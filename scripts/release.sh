#!/usr/bin/env bash

#
# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements.  See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License.  You may obtain a copy of the License at
#
#    http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#

# Apache SkyWalking Horizon UI release automation.
#
# Mirrors the apache/skywalking release.sh flow (see
# docs/en/guides/How-to-release.md upstream) but adapted for the
# pnpm-workspace Node project layout. Produces:
#
#   apache-skywalking-horizon-ui-<v>-src.tar.gz {.asc,.sha512}
#   apache-skywalking-horizon-ui-<v>-bin.tar.gz {.asc,.sha512}
#
# Uploads them to https://dist.apache.org/repos/dist/dev/skywalking/horizon-ui/<v>/
# then prepares a next-version PR.
#
# Usage:  bash scripts/release.sh

set -e -o pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PROJECT_DIR=$(cd "${SCRIPT_DIR}/.." && pwd)
PRODUCT_NAME="apache-skywalking-horizon-ui"
REPO_URL="${HORIZON_RELEASE_REPO_URL:-https://github.com/apache/skywalking-horizon-ui.git}"
REPO_BRANCH="${HORIZON_RELEASE_BRANCH:-main}"
SVN_DEV_URL="https://dist.apache.org/repos/dist/dev/skywalking/horizon-ui"
WORK_DIR="${SCRIPT_DIR}/.release-work"
CLONE_DIR="${WORK_DIR}/skywalking-horizon-ui"

# ========================== Helpers ==========================

err() { echo "ERROR: $*" >&2; }
note() { echo ""; echo "=== $* ==="; }

confirm() {
    local prompt="$1"
    read -r -p "${prompt} [y/N] " ans
    [[ "$ans" == "y" || "$ans" == "Y" ]]
}

# Extract the root package.json "version" without depending on jq —
# we want this script to be runnable on stock macOS / Alpine.
read_version() {
    node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('${PROJECT_DIR}/package.json','utf8')).version)"
}

# Quietly check that the named file contains a literal needle.
file_has() {
    grep -F -q -- "$2" "$1"
}

# ========================== Step 1: GPG signer ==========================
note "Step 1 — GPG signer check"

GPG_KEY_ID=$(git config user.signingkey 2>/dev/null || true)
if [ -z "$GPG_KEY_ID" ]; then
    GPG_KEY_ID=$(gpg --list-secret-keys --keyid-format LONG 2>/dev/null | grep -A1 '^sec' | tail -1 | awk '{print $1}' || true)
fi
if [ -z "$GPG_KEY_ID" ]; then
    err "No GPG secret key found. Configure your Apache GPG key first."
    exit 1
fi

GPG_UIDS=$(gpg --list-secret-keys --keyid-format LONG 2>/dev/null | grep 'uid' | sed 's/.*] //')
GPG_EMAIL=$(echo "$GPG_UIDS" | grep -oE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' | head -1)

if [[ "$GPG_EMAIL" != *"@apache.org" ]]; then
    err "GPG key email '${GPG_EMAIL}' is not @apache.org — Apache releases must be signed with an @apache.org key."
    exit 1
fi
echo "GPG Signer: ${GPG_UIDS}"
echo "GPG Key:    ${GPG_KEY_ID}"
confirm "Is this the correct signer?" || { echo "Aborted."; exit 1; }

export GPG_TTY=$(tty)
echo "Verifying GPG signing works (you may be prompted for the passphrase)…"
TEST_FILE=$(mktemp); echo "test" > "${TEST_FILE}"
if ! gpg --armor --detach-sig "${TEST_FILE}" 2>/dev/null; then
    rm -f "${TEST_FILE}" "${TEST_FILE}.asc"
    err "GPG signing failed. Try:  export GPG_TTY=\$(tty)  /  gpgconf --launch gpg-agent"
    exit 1
fi
rm -f "${TEST_FILE}" "${TEST_FILE}.asc"
echo "GPG signing OK."

# ========================== Step 2: Required tools ==========================
note "Step 2 — Tool check"

MISSING=()
for t in gpg svn shasum git gh node pnpm tar license-eye; do
    command -v "$t" >/dev/null || MISSING+=("$t")
done
if [ ${#MISSING[@]} -gt 0 ]; then
    err "Missing required tools: ${MISSING[*]}"
    exit 1
fi
echo "All tools present."
echo "node: $(node --version)"
echo "pnpm: $(pnpm --version)"

# ========================== Step 3: Detect version ==========================
note "Step 3 — Detect version"

CURRENT_VERSION=$(read_version)
if [ -z "$CURRENT_VERSION" ]; then
    err "Could not read version from package.json."
    exit 1
fi
# main carries `<release>-dev` while the next release is in flight. The
# release version is the bare semver — strip the `-dev` (also `-SNAPSHOT`
# for parity with the upstream skywalking convention).
RELEASE_VERSION="${CURRENT_VERSION%-dev}"
RELEASE_VERSION="${RELEASE_VERSION%-SNAPSHOT}"
if [ "${CURRENT_VERSION}" = "${RELEASE_VERSION}" ]; then
    err "package.json version '${CURRENT_VERSION}' has no '-dev' / '-SNAPSHOT' suffix."
    err "main should carry the dev-suffixed version between releases — bump it before running this script."
    exit 1
fi
MAJOR=$(echo "$RELEASE_VERSION" | cut -d. -f1)
MINOR=$(echo "$RELEASE_VERSION" | cut -d. -f2)
NEXT_MINOR=$((MINOR + 1))
NEXT_RELEASE_VERSION="${MAJOR}.${NEXT_MINOR}.0"

echo "Current (in package.json): ${CURRENT_VERSION}"
echo "Release:                   ${RELEASE_VERSION}"
echo "Next dev:                  ${NEXT_RELEASE_VERSION}-dev"
if ! confirm "Are these correct?"; then
    read -r -p "Enter release version: " RELEASE_VERSION
    read -r -p "Enter next version (without -dev suffix): " NEXT_RELEASE_VERSION
fi

# Normalize + validate both versions. The "next version" prompt asks for a
# BARE X.Y.Z — the script appends `-dev` itself (Step 15) — so strip a stray
# leading `v` / `-dev` / `-SNAPSHOT` an operator may have typed anyway, then
# reject anything that isn't a clean semver core. Without this, entering
# "1.0.0-dev" at the prompt silently produces the malformed "1.0.0-dev-dev".
for _var in RELEASE_VERSION NEXT_RELEASE_VERSION; do
    _val="${!_var}"
    _val="${_val#v}"; _val="${_val%-dev}"; _val="${_val%-SNAPSHOT}"
    if [[ ! "${_val}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        err "${_var} '${!_var}' is not a clean version — enter a bare X.Y.Z (e.g. 1.0.0), without a -dev suffix."
        exit 1
    fi
    printf -v "${_var}" '%s' "${_val}"
done

TAG="v${RELEASE_VERSION}"

# ========================== Step 4: Version-consistency check ==========================
note "Step 4 — Version consistency check"

CONSISTENT=true
check_file_has_version() {
    local file="$1"; local needle="$2"
    if ! file_has "${PROJECT_DIR}/${file}" "$needle"; then
        err "${file} is missing expected token: ${needle}"
        CONSISTENT=false
    fi
}
# Every code-side marker carries the dev-suffixed version (`-dev`) on
# main between releases. Strip-and-tag happens later in the clone, NOT
# in the local working tree.
for pj in package.json packages/api-client/package.json packages/design-tokens/package.json \
          packages/templates/package.json apps/bff/package.json apps/ui/package.json; do
    check_file_has_version "$pj" "\"version\": \"${CURRENT_VERSION}\""
done
check_file_has_version "apps/bff/src/server.ts" "'${CURRENT_VERSION}'"

# Docs normally reference the last released image tag on main, then the
# release commit advances them to the new tag. If the docs were already
# prepared for the release version, accept that too.
PRIOR_RELEASE=$(cd "${PROJECT_DIR}" && git tag --list 'v*' --sort=-version:refname | head -1 | sed 's/^v//')
if [ -z "${PRIOR_RELEASE}" ]; then
    err "No prior release tag (vX.Y.Z) found. Tag the first release manually before using this script."
    exit 1
fi
if ! file_has "${PROJECT_DIR}/docs/setup/container-image.md" "ghcr.io/apache/skywalking-horizon-ui:${PRIOR_RELEASE}" &&
   ! file_has "${PROJECT_DIR}/docs/setup/container-image.md" "ghcr.io/apache/skywalking-horizon-ui:${RELEASE_VERSION}"; then
    err "docs/setup/container-image.md must reference either prior image tag ${PRIOR_RELEASE} or release tag ${RELEASE_VERSION}."
    CONSISTENT=false
fi

if ! $CONSISTENT; then
    err "Version drift across files. Fix before continuing."
    exit 1
fi
echo "Code markers all at ${CURRENT_VERSION}; container docs are release-check compatible."

# ========================== Step 5: Doc + Changelog check ==========================
note "Step 5 — Docs + CHANGELOG check"

if ! grep -q "^## ${RELEASE_VERSION}$" "${PROJECT_DIR}/CHANGELOG.md"; then
    err "CHANGELOG.md has no '## ${RELEASE_VERSION}' section heading."
    exit 1
fi
# Reject the placeholder body. Operators MUST fill the section in before
# casting a vote — a stub CHANGELOG line in a release tarball is a
# review smell.
if awk -v v="${RELEASE_VERSION}" '
    $0 == "## " v        { in_sec=1; next }
    in_sec && /^## /     { in_sec=0 }
    in_sec               { print }
' "${PROJECT_DIR}/CHANGELOG.md" | grep -q "In development"; then
    err "CHANGELOG.md ${RELEASE_VERSION} section still contains the '(In development …)' placeholder. Fill it in."
    exit 1
fi
echo "CHANGELOG.md has a non-placeholder section for ${RELEASE_VERSION}."

# Make sure LICENSE / NOTICE exist at the repo root (they ship in src+bin tarballs).
for f in LICENSE NOTICE HEADER; do
    [ -f "${PROJECT_DIR}/${f}" ] || { err "${f} missing at repo root."; exit 1; }
done
echo "LICENSE / NOTICE / HEADER present."

# ========================== Step 6: License-header check ==========================
note "Step 6 — License-header check (license-eye)"

(cd "${PROJECT_DIR}" && license-eye -c .licenserc.yaml header check)
echo "License headers OK."

# ========================== Step 7: Clone fresh ==========================
note "Step 7 — Clone fresh repo"

rm -rf "${WORK_DIR}"
mkdir -p "${WORK_DIR}"
echo "Cloning ${REPO_URL} (branch: ${REPO_BRANCH}) into ${CLONE_DIR}…"
git clone --depth 1 --branch "${REPO_BRANCH}" "${REPO_URL}" "${CLONE_DIR}"

CLONE_VERSION=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('${CLONE_DIR}/package.json','utf8')).version)")
if [ "${CLONE_VERSION}" != "${CURRENT_VERSION}" ]; then
    err "Fresh clone has version ${CLONE_VERSION}, expected ${CURRENT_VERSION} (the dev-suffixed version on ${REPO_BRANCH})."
    exit 1
fi

# ========================== Step 8: Strip -dev, advance docs, commit, tag ==========================
note "Step 8 — Prepare release commit + tag ${TAG}"

cd "${CLONE_DIR}"

# The release commit is NEVER pushed straight to ${REPO_BRANCH} — main is
# protected, and ASF review wants the version change to land via PR. Cut a
# dedicated release branch; the tag is created on the release commit here,
# and the next-dev bump is added as a second commit on the SAME branch in
# Step 15 so one PR carries both (version strip → tag → back to -dev).
RELEASE_BRANCH_NAME="prepare-release-${RELEASE_VERSION}"
git checkout -b "${RELEASE_BRANCH_NAME}"

# Strip the -dev suffix on every code marker in the clone. The committed
# release-tagged commit must carry the bare semver.
node -e "
const fs = require('fs');
const files = [
  'package.json',
  'packages/api-client/package.json',
  'packages/design-tokens/package.json',
  'packages/templates/package.json',
  'apps/bff/package.json',
  'apps/ui/package.json',
];
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j.version = '${RELEASE_VERSION}';
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
}
"
sed -i.bak "s/'${CURRENT_VERSION}'/'${RELEASE_VERSION}'/g" apps/bff/src/server.ts
rm apps/bff/src/server.ts.bak

# Advance docs from the prior release tag to the new one so the image
# tag references in the release tarball match the release being cut.
sed -i.bak "s|ghcr.io/apache/skywalking-horizon-ui:${PRIOR_RELEASE}|ghcr.io/apache/skywalking-horizon-ui:${RELEASE_VERSION}|g" docs/setup/container-image.md
rm docs/setup/container-image.md.bak

git add package.json packages/*/package.json apps/*/package.json apps/bff/src/server.ts docs/setup/container-image.md
git commit -m "Prepare release ${RELEASE_VERSION}"

if git ls-remote --tags origin | grep -q "refs/tags/${TAG}$"; then
    err "Tag ${TAG} already exists on origin. Delete it first if you need to re-cut, or pick a new version."
    exit 1
fi
git tag "${TAG}"
# Push the release commit on its own branch + the tag (the tag points at
# the release commit). The branch is merged into ${REPO_BRANCH} via the PR
# opened in Step 15 — after the next-dev bump is added on top.
git push --set-upstream origin "${RELEASE_BRANCH_NAME}" "${TAG}"
echo "Pushed release branch ${RELEASE_BRANCH_NAME} + tag ${TAG} (tag → release commit; not pushed to ${REPO_BRANCH})."

# ========================== Step 9: Build source tarball ==========================
note "Step 9 — Build source tarball"

SRC_TAR="${WORK_DIR}/${PRODUCT_NAME}-${RELEASE_VERSION}-src.tar.gz"
SRC_STAGE_NAME="${PRODUCT_NAME}-${RELEASE_VERSION}-src"
# A "source release" is the canonical Apache artifact: exactly the committed
# files at the release tag — no .git, no node_modules, no dist, no editor
# leftovers (git archive emits only tracked files, which excludes all of
# those by .gitignore). We stage via `git archive` (portable — git does the
# archiving) then repackage with plain `tar`, so this works the same on
# macOS (bsdtar) and Linux (GNU tar). GNU-only `--transform` is avoided;
# the tarball's top-level dir comes from `--prefix`.
rm -rf "${WORK_DIR}/${SRC_STAGE_NAME}"
git -C "${CLONE_DIR}" archive --format=tar --prefix="${SRC_STAGE_NAME}/" "${TAG}" \
    | tar -C "${WORK_DIR}" -xf -
# Drop the CI publish workflow from the source release (ASF-infra specific).
rm -f "${WORK_DIR}/${SRC_STAGE_NAME}/.github/workflows/publish-image.yaml"
tar -C "${WORK_DIR}" -czf "${SRC_TAR}" "${SRC_STAGE_NAME}"

echo "Source tarball: ${SRC_TAR}"

# ========================== Step 10: Build binary (self-contained) ==========================
note "Step 10 — Build binary tarball (self-contained, no install/network at boot)"

cd "${CLONE_DIR}"
pnpm install --frozen-lockfile
pnpm package
# The packager left dist/server.js + dist/node_modules + dist/static + …
# Now layer in LICENSE/NOTICE + per-dep license texts. `--check` regenerates
# dist/LICENSE + dist/NOTICE AND aborts if they drift from the committed
# reference (dist-material/release-docs/) — so the binary ships exactly the
# reviewed bytes. check-dist-licenses then enforces the ASF allow/deny list.
node "${CLONE_DIR}/scripts/collect-dist-licenses.mjs" --check
node "${CLONE_DIR}/scripts/check-dist-licenses.mjs"

# Stage the binary contents under a clean folder name so the tar root
# entry matches the artifact name. Copy in the operator-facing docs too.
BIN_STAGE="${WORK_DIR}/${PRODUCT_NAME}-${RELEASE_VERSION}-bin"
rm -rf "${BIN_STAGE}"
cp -R "${CLONE_DIR}/dist" "${BIN_STAGE}"
cp "${CLONE_DIR}/CHANGELOG.md" "${BIN_STAGE}/CHANGELOG.md"
cp "${CLONE_DIR}/README.md"    "${BIN_STAGE}/README.md"
# dist/LICENSE and dist/NOTICE were just generated by the collector and
# are the BINARY-flavored versions (Apache-2.0 + bundled-dep summary +
# pass-through NOTICEs). The repo-root LICENSE/NOTICE — source-flavored —
# stay in the source tarball only. Do NOT overwrite.

BIN_TAR="${WORK_DIR}/${PRODUCT_NAME}-${RELEASE_VERSION}-bin.tar.gz"
tar -C "${WORK_DIR}" -czf "${BIN_TAR}" "${PRODUCT_NAME}-${RELEASE_VERSION}-bin"

echo "Binary tarball: ${BIN_TAR}"

# ========================== Step 11: Compare LICENSE/NOTICE in tarballs ==========================
note "Step 11 — Verify LICENSE/NOTICE in src + bin tarballs"

# Both tarballs must carry a LICENSE and NOTICE at their root, and the
# binary version must be the expanded one (contains the "Subcomponents"
# section the collector appends). The source version must NOT contain
# that section — a bundled-dep summary on a source-only tarball would
# be a wire-shape lie.
src_license=$(tar -tzf "${SRC_TAR}" | grep -E "^${PRODUCT_NAME}-${RELEASE_VERSION}-src/LICENSE$" || true)
src_notice=$( tar -tzf "${SRC_TAR}" | grep -E "^${PRODUCT_NAME}-${RELEASE_VERSION}-src/NOTICE$"  || true)
bin_license=$(tar -tzf "${BIN_TAR}" | grep -E "^${PRODUCT_NAME}-${RELEASE_VERSION}-bin/LICENSE$" || true)
bin_notice=$( tar -tzf "${BIN_TAR}" | grep -E "^${PRODUCT_NAME}-${RELEASE_VERSION}-bin/NOTICE$"  || true)
[ -n "$src_license" ] || { err "Source tarball missing LICENSE";  exit 1; }
[ -n "$src_notice"  ] || { err "Source tarball missing NOTICE";   exit 1; }
[ -n "$bin_license" ] || { err "Binary tarball missing LICENSE";  exit 1; }
[ -n "$bin_notice"  ] || { err "Binary tarball missing NOTICE";   exit 1; }

src_lic_text=$(tar -xzf "${SRC_TAR}" -O "${PRODUCT_NAME}-${RELEASE_VERSION}-src/LICENSE")
bin_lic_text=$(tar -xzf "${BIN_TAR}" -O "${PRODUCT_NAME}-${RELEASE_VERSION}-bin/LICENSE")
if echo "$src_lic_text" | grep -qE 'Horizon UI Subcomponents'; then
    err "Source LICENSE unexpectedly contains 'Horizon UI Subcomponents' — that section belongs in the binary tarball only."
    exit 1
fi
if ! echo "$bin_lic_text" | grep -qE 'Horizon UI Subcomponents'; then
    err "Binary LICENSE missing 'Horizon UI Subcomponents' — collector did not run."
    exit 1
fi

echo "src LICENSE sha512: $(echo "$src_lic_text" | shasum -a 512 | cut -d' ' -f1)"
echo "bin LICENSE sha512: $(echo "$bin_lic_text" | shasum -a 512 | cut -d' ' -f1)"

# ========================== Step 12: GPG sign + sha512 ==========================
note "Step 12 — GPG sign + sha512"

cd "${WORK_DIR}"
for t in "${SRC_TAR}" "${BIN_TAR}"; do
    gpg --armor --detach-sig "${t}"
    shasum -a 512 "$(basename "${t}")" > "${t}.sha512"
done

echo "Artifacts:"
ls -lh "${SRC_TAR}" "${SRC_TAR}.asc" "${SRC_TAR}.sha512" \
       "${BIN_TAR}" "${BIN_TAR}.asc" "${BIN_TAR}.sha512"

# Verify signatures locally before publishing.
gpg --verify "${SRC_TAR}.asc" "${SRC_TAR}"
gpg --verify "${BIN_TAR}.asc" "${BIN_TAR}"
shasum -a 512 -c "${SRC_TAR}.sha512"
shasum -a 512 -c "${BIN_TAR}.sha512"
echo "Self-verify OK."

# ========================== Step 13: SVN upload ==========================
note "Step 13 — Upload to ${SVN_DEV_URL}/${RELEASE_VERSION}"

read -r -p "Apache SVN username: " SVN_USER
read -r -s -p "Apache SVN password: " SVN_PASS
echo ""

# The dev parent dir (dist/dev/skywalking/horizon-ui) may not exist yet on
# the first SVN-published release. `svn co` of a missing URL fails, so
# check-and-create the parent chain before checking it out.
if ! svn ls --username "${SVN_USER}" --password "${SVN_PASS}" \
        --non-interactive --no-auth-cache "${SVN_DEV_URL}" >/dev/null 2>&1; then
    echo "Dev staging dir does not exist — creating ${SVN_DEV_URL}/"
    svn mkdir --parents --username "${SVN_USER}" --password "${SVN_PASS}" \
        --non-interactive --no-auth-cache \
        -m "Create Horizon UI dev staging directory" \
        "${SVN_DEV_URL}"
fi

SVN_STAGE="${WORK_DIR}/svn-staging"
rm -rf "${SVN_STAGE}"
svn co --depth empty --username "${SVN_USER}" --password "${SVN_PASS}" \
       --non-interactive --no-auth-cache \
       "${SVN_DEV_URL}" "${SVN_STAGE}"

SVN_VERSION_DIR="${SVN_STAGE}/${RELEASE_VERSION}"
if svn ls --username "${SVN_USER}" --password "${SVN_PASS}" --non-interactive --no-auth-cache \
       "${SVN_DEV_URL}/${RELEASE_VERSION}" >/dev/null 2>&1; then
    echo "Version folder exists on SVN. Updating in place."
    svn update --username "${SVN_USER}" --password "${SVN_PASS}" --non-interactive --no-auth-cache \
               --set-depth infinity "${SVN_VERSION_DIR}"
else
    mkdir -p "${SVN_VERSION_DIR}"
    (cd "${SVN_STAGE}" && svn add "${RELEASE_VERSION}")
fi

cp "${SRC_TAR}" "${SRC_TAR}.asc" "${SRC_TAR}.sha512" "${SVN_VERSION_DIR}/"
cp "${BIN_TAR}" "${BIN_TAR}.asc" "${BIN_TAR}.sha512" "${SVN_VERSION_DIR}/"

(cd "${SVN_STAGE}" && svn add --force "${RELEASE_VERSION}")
(cd "${SVN_STAGE}" && svn commit \
    --username "${SVN_USER}" --password "${SVN_PASS}" \
    --non-interactive --no-auth-cache \
    -m "Upload Apache SkyWalking Horizon UI ${RELEASE_VERSION} release candidate")

echo "Uploaded: ${SVN_DEV_URL}/${RELEASE_VERSION}"
unset SVN_PASS

# ========================== Step 14: Vote email ==========================
note "Step 14 — Vote email"

SRC_SHA512=$(cat "${SRC_TAR}.sha512")
BIN_SHA512=$(cat "${BIN_TAR}.sha512")
# Force C locale so the month name is English (%B is locale-dependent) —
# the vote email goes to an English mailing list regardless of the runner's OS language.
VOTE_DATE=$(LC_ALL=C date +"%B %d, %Y")
RELEASE_COMMIT=$(git -C "${CLONE_DIR}" rev-parse "${TAG}")

cat <<EOF

========================================================================
Vote Email — copy and send to dev@skywalking.apache.org
========================================================================

Subject: [VOTE] Release Apache SkyWalking Horizon UI version ${RELEASE_VERSION}

Hi All,

This is a call for vote to release Apache SkyWalking Horizon UI
version ${RELEASE_VERSION}.

Release notes:

 * https://github.com/apache/skywalking-horizon-ui/blob/${TAG}/CHANGELOG.md

Release Candidate:

 * ${SVN_DEV_URL}/${RELEASE_VERSION}
 * sha512 checksums
   - ${SRC_SHA512}
   - ${BIN_SHA512}

Release Tag:

 * (Git Tag) ${TAG}

Release CommitID:

 * https://github.com/apache/skywalking-horizon-ui/tree/${TAG}
 * SHA: ${RELEASE_COMMIT}

Keys to verify the Release Candidate:

 * https://dist.apache.org/repos/dist/release/skywalking/KEYS

Guide to build the release from source:

 * Extract apache-skywalking-horizon-ui-${RELEASE_VERSION}-src.tar.gz
 * cd into the extracted directory
 * pnpm install --frozen-lockfile
 * pnpm package
 * node dist/server.js (after copying horizon.yaml → horizon.yaml)

Voting will start now (${VOTE_DATE}) and will remain open for at least
72 hours. PMC members, please cast your vote.

[ ] +1 Release this package.
[ ] +0 No opinion.
[ ] -1 Do not release this package because …

========================================================================
EOF

# ========================== Step 15: Next-dev bump + release PR ==========================
note "Step 15 — Add next-dev bump (${NEXT_RELEASE_VERSION}-dev) + open release PR"

if ! confirm "Add the next-dev bump on ${RELEASE_BRANCH_NAME} and open the release PR now?"; then
    echo "Skipping the next-dev commit + PR. Release artifacts are in ${WORK_DIR}/."
    echo "Release branch ${RELEASE_BRANCH_NAME} + tag ${TAG} are already pushed; open the PR manually when ready."
    exit 0
fi

cd "${CLONE_DIR}"
# Stay on the release branch — the next-dev bump is a SECOND commit on top
# of the tagged release commit, so one PR carries both: the version strip
# (tagged) and the return to -dev for the next cycle.
git checkout "${RELEASE_BRANCH_NAME}"

# Bump every code marker to the next dev-suffixed version.
NEXT_DEV_VERSION="${NEXT_RELEASE_VERSION}-dev"
node -e "
const fs = require('fs');
const files = [
  'package.json',
  'packages/api-client/package.json',
  'packages/design-tokens/package.json',
  'packages/templates/package.json',
  'apps/bff/package.json',
  'apps/ui/package.json',
];
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j.version = '${NEXT_DEV_VERSION}';
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
}
"

# server.ts default — keep in lock-step with HORIZON_VERSION.
sed -i.bak "s/'${RELEASE_VERSION}'/'${NEXT_DEV_VERSION}'/g" apps/bff/src/server.ts
rm apps/bff/src/server.ts.bak

# Container-image docs already point at ${RELEASE_VERSION} (the release
# commit just bumped them). They stay there — docs always reference the
# last released tag, not the in-flight dev version.

# Rotate CHANGELOG: insert a fresh placeholder at the top.
node -e "
const fs = require('fs');
const path = 'CHANGELOG.md';
const txt = fs.readFileSync(path, 'utf8');
const insertion = '## ${NEXT_RELEASE_VERSION}\n\n(In development — fill in highlights here before cutting the release.)\n\n';
// Insert above the first '## <prev>' heading.
const out = txt.replace(/^## /m, insertion + '## ');
fs.writeFileSync(path, out);
"

git add package.json packages/*/package.json apps/*/package.json apps/bff/src/server.ts CHANGELOG.md
git commit -m "Prepare next release ${NEXT_DEV_VERSION}"
git push origin "${RELEASE_BRANCH_NAME}"

gh pr create --title "Release ${RELEASE_VERSION}, bump to ${NEXT_DEV_VERSION}" \
    --body "$(cat <<PRBODY
Release branch for ${RELEASE_VERSION}. Two commits:

1. \`Prepare release ${RELEASE_VERSION}\` — strips \`-dev\` from every package
   marker + \`apps/bff/src/server.ts\`; advances container-image docs to
   \`${RELEASE_VERSION}\`. Tagged \`${TAG}\` (the release-candidate commit the
   vote runs against).
2. \`Prepare next release ${NEXT_DEV_VERSION}\` — bumps every marker to
   \`${NEXT_DEV_VERSION}\` and rotates CHANGELOG for the next cycle.

Merge after the [VOTE] passes so \`${REPO_BRANCH}\` returns to a \`-dev\`
version with the release in its history. The \`${TAG}\` tag is immutable and
keeps pointing at commit 1 regardless of how this PR is merged.
PRBODY
)" \
    --head "${RELEASE_BRANCH_NAME}" \
    --base "${REPO_BRANCH}"

note "Done."
echo "  Release version:    ${RELEASE_VERSION}"
echo "  Next dev version:   ${NEXT_DEV_VERSION}"
echo "  Release branch:     ${RELEASE_BRANCH_NAME} (PR open → ${REPO_BRANCH})"
echo "  SVN dev staging:    ${SVN_DEV_URL}/${RELEASE_VERSION}"
echo "  Release tag:        ${TAG}"
echo ""
echo "Next steps:"
echo "  1. Send the vote email above to dev@skywalking.apache.org."
echo "  2. After the vote passes, run:  svn mv ${SVN_DEV_URL}/${RELEASE_VERSION} \\"
echo "         https://dist.apache.org/repos/dist/release/skywalking/horizon-ui/${RELEASE_VERSION}"
echo "  3. Merge the release PR (${RELEASE_BRANCH_NAME} → ${REPO_BRANCH}): brings the"
echo "     version strip + next-dev bump into ${REPO_BRANCH}; tag ${TAG} stays put."
