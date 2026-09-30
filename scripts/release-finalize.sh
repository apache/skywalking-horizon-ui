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

# Apache SkyWalking Horizon UI — POST-VOTE release finalization.
#
# Run this AFTER the [VOTE] on dev@skywalking.apache.org passes. It is the
# second half of the release flow; `scripts/release.sh` is the first half
# (build, sign, upload RC to SVN dev, vote email, next-dev PR).
#
# What it does, in order:
#
#   1. Locate the voted candidate. Normally it is still staged at
#        dist/dev/skywalking/horizon-ui/<v>/
#      but on a re-run after an interrupted finalize it may already sit at
#        dist/release/skywalking/horizon-ui/<v>/
#      — either is accepted, so a resumed run continues instead of dying.
#
#   2. Download the candidate and VERIFY it before anything is published:
#      that the directory holds EXACTLY the six expected artifacts (step 3
#      moves the whole directory, so anything else in it would be published
#      without ever being verified or voted on), the .sha512 checksums, the
#      .asc detached signatures, and the signer itself — checked inside a
#      throwaway keyring built only from the project's published KEYS file,
#      so a signature from a key that is not a SkyWalking release key cannot
#      verify. The signing key must also carry an @apache.org identity, and
#      both artifacts must be signed by the same key.
#
#   3. ONLY THEN promote on SVN: server-side move from dev/ to release/, and
#      remove the release this one SUPERSEDES — the highest version BELOW <v>
#      (ASF keeps only the current release live; older ones are auto-archived).
#      A higher version already in release/ is never proposed for deletion, so
#      finalizing an older maintenance line cannot take out a newer release.
#
#   4. Cut a GitHub release on tag v<v>, attaching the SAME voted bytes
#      (src + bin tarballs + .asc + .sha512) that were just verified, with
#      the release's notes — docs/changelog/<v>.md read out of the tag, not out
#      of the working tree — as the body. On a release that already exists, every attached
#      asset is compared against those verified bytes (size, then sha512) and
#      only what is missing or different is (re-)uploaded: a matching FILENAME
#      is not evidence that the bytes behind it are the voted ones.
#
#   5. Verify the Docker Hub multi-arch image (apache/skywalking-ui:horizon-<v>,
#      plus apache/skywalking-ui:latest when v<v> is the highest v* tag). These
#      are NOT published by the tag push: a tag is only a release candidate
#      until the vote passes, so the tag build publishes the immutable digest
#      tag alone. The stable tags and the Docker Hub mirror are attached by the
#      promotion run, which publishing the GitHub release (step 7 below)
#      triggers — that run moves :latest only for the highest tag, so promoting
#      a patch on a superseded line leaves it alone. Publishing stays CI's job;
#      this step WAITS for the expected tags and then confirms them.
#
# Usage:  bash scripts/release-finalize.sh
#
# The script is re-runnable and confirms before every irreversible step
# (SVN move, SVN delete, gh release). Nothing destructive happens without
# a y/N, and nothing is published before step 2 has passed. The Docker Hub
# image is published by CI, not here.

set -e -o pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PROJECT_DIR=$(cd "${SCRIPT_DIR}/.." && pwd)
PRODUCT_NAME="apache-skywalking-horizon-ui"

SVN_DEV_URL="https://dist.apache.org/repos/dist/dev/skywalking/horizon-ui"
SVN_RELEASE_URL="https://dist.apache.org/repos/dist/release/skywalking/horizon-ui"
SVN_KEYS_URL="https://dist.apache.org/repos/dist/release/skywalking/KEYS"

GH_REPO="apache/skywalking-horizon-ui"
DOCKERHUB_REPO="apache/skywalking-ui"
WORK_DIR="${SCRIPT_DIR}/.finalize-work"

# ========================== Helpers ==========================

# shellcheck source=scripts/release-common.sh
. "${SCRIPT_DIR}/release-common.sh"

svn_exists() {
    svn ls "$1" >/dev/null 2>&1
}

# Credentials are read lazily, right before the first WRITE to SVN — reads
# are anonymous, and a run that only verifies (or only re-uploads a GitHub
# asset) should never ask for them.
SVN_AUTH=()
SVN_AUTH_READY=false
svn_auth_init() {
    if [ "${SVN_AUTH_READY}" = true ]; then
        return 0
    fi
    local svn_user svn_pass
    read -r -p "Apache SVN username: " svn_user
    read -r -s -p "Apache SVN password: " svn_pass
    echo ""
    SVN_AUTH=(--username "${svn_user}" --password "${svn_pass}" --non-interactive --no-auth-cache)
    SVN_AUTH_READY=true
}

# ========================== Step 1: Tool + auth preflight ==========================
note "Step 1 — Tool + auth preflight"

MISSING=()
for t in svn gh git docker shasum curl gpg node; do
    command -v "$t" >/dev/null || MISSING+=("$t")
done
if [ ${#MISSING[@]} -gt 0 ]; then
    err "Missing required tools: ${MISSING[*]}"
    exit 1
fi

if ! docker buildx version >/dev/null 2>&1; then
    err "docker buildx is required (the last step uses 'imagetools inspect'"
    err "to verify the CI-published Docker Hub tags)."
    exit 1
fi

# gh must be logged in with repo scope to cut a release.
if ! gh auth status >/dev/null 2>&1; then
    err "gh is not authenticated. Run: gh auth login"
    exit 1
fi
echo "gh: $(gh auth status 2>&1 | grep -m1 'Logged in' | sed 's/^[[:space:]]*//')"

# ========================== Step 2: Detect version ==========================
note "Step 2 — Detect release version"

DETECTED=$(cd "${PROJECT_DIR}" && git tag --list 'v*' --sort=-version:refname | head -1 | sed 's/^v//')
echo "Most recent git tag: v${DETECTED:-<none>}"
read -r -p "Release version to finalize [${DETECTED}]: " RELEASE_VERSION
RELEASE_VERSION="${RELEASE_VERSION:-${DETECTED}}"
if [ -z "${RELEASE_VERSION}" ]; then
    err "No release version provided."
    exit 1
fi
TAG="v${RELEASE_VERSION}"

if ! (cd "${PROJECT_DIR}" && git rev-parse "${TAG}" >/dev/null 2>&1); then
    err "Git tag ${TAG} does not exist locally. Fetch tags first: git fetch --tags"
    exit 1
fi
echo "Finalizing ${RELEASE_VERSION} (tag ${TAG}). Once the candidate verifies, this run"
echo "asks separately before each step it still needs — on a resumed run the ones"
echo "already done are skipped:"
echo "  · svn mv  ${SVN_DEV_URL}/${RELEASE_VERSION}/  ->  ${SVN_RELEASE_URL}/${RELEASE_VERSION}/"
echo "  · svn rm  the release ${RELEASE_VERSION} supersedes, under ${SVN_RELEASE_URL}/"
echo "  · gh release  https://github.com/${GH_REPO}/releases/tag/${TAG}"
echo "Nothing is published before the verification in Step 5 passes."
confirm "Proceed?" || { echo "Aborted."; exit 1; }

rm -rf "${WORK_DIR}"
mkdir -p "${WORK_DIR}"

# ========================== Step 3: Locate the voted candidate ==========================
note "Step 3 — Locate the voted candidate on SVN"

RC_PRESENT=false
RELEASED_PRESENT=false
if svn_exists "${SVN_DEV_URL}/${RELEASE_VERSION}"; then RC_PRESENT=true; fi
if svn_exists "${SVN_RELEASE_URL}/${RELEASE_VERSION}"; then RELEASED_PRESENT=true; fi

# A finalize that was interrupted anywhere after the svn mv leaves the
# candidate ONLY under release/. Treating that as "RC not found" would make
# every retry impossible, so release/ is a valid source too — the bytes are
# the same objects the move carried over.
if [ "${RELEASED_PRESENT}" = true ]; then
    CANDIDATE_URL="${SVN_RELEASE_URL}/${RELEASE_VERSION}"
    if [ "${RC_PRESENT}" = true ]; then
        echo "Present in BOTH dev/ and release/ — verifying the release/ copy (the published one)."
        echo "  Note: ${SVN_DEV_URL}/${RELEASE_VERSION}/ still exists; remove it by hand once you are done."
    else
        echo "Already promoted — resuming from ${SVN_RELEASE_URL}/${RELEASE_VERSION}/."
    fi
elif [ "${RC_PRESENT}" = true ]; then
    CANDIDATE_URL="${SVN_DEV_URL}/${RELEASE_VERSION}"
    echo "Release candidate staged at ${SVN_DEV_URL}/${RELEASE_VERSION}/."
else
    err "Version ${RELEASE_VERSION} is at neither ${SVN_DEV_URL}/ nor ${SVN_RELEASE_URL}/."
    err "Did scripts/release.sh upload the release candidate?"
    exit 1
fi

# ========================== Step 4: Inspect + download the candidate ==========================
note "Step 4 — Check the candidate contents + download (nothing is published yet)"

ART_DIR="${WORK_DIR}/artifacts"
mkdir -p "${ART_DIR}"
SRC_BASE="${PRODUCT_NAME}-${RELEASE_VERSION}-src.tar.gz"
BIN_BASE="${PRODUCT_NAME}-${RELEASE_VERSION}-bin.tar.gz"
ART_FILES=(
    "${SRC_BASE}" "${SRC_BASE}.asc" "${SRC_BASE}.sha512"
    "${BIN_BASE}" "${BIN_BASE}.asc" "${BIN_BASE}.sha512"
)

# Step 5 verifies these six files, but Step 6 promotes the DIRECTORY with one
# server-side `svn mv` — so a stale artifact from an earlier RC, a half-finished
# upload, or anything else left in there rides along into the official release
# location unverified. An Apache release directory must hold exactly what was
# voted on, so an unexpected entry stops the run before anything is published.
CANDIDATE_ENTRIES=$(svn ls "${CANDIDATE_URL}/" 2>/dev/null || true)
if [ -z "${CANDIDATE_ENTRIES}" ]; then
    err "${CANDIDATE_URL}/ is empty or could not be listed."
    exit 1
fi
EXTRA_ENTRIES=()
while IFS= read -r entry; do
    [ -n "${entry}" ] || continue
    known=false
    for f in "${ART_FILES[@]}"; do
        if [ "${entry}" = "${f}" ]; then known=true; break; fi
    done
    [ "${known}" = true ] || EXTRA_ENTRIES+=("${entry}")
done <<< "${CANDIDATE_ENTRIES}"
if [ ${#EXTRA_ENTRIES[@]} -gt 0 ]; then
    err "${CANDIDATE_URL}/ holds ${#EXTRA_ENTRIES[@]} entry/entries that are not part of the voted release:"
    for entry in "${EXTRA_ENTRIES[@]}"; do
        err "  ${CANDIDATE_URL}/${entry}"
    done
    err "Expected exactly these ${#ART_FILES[@]}:"
    for f in "${ART_FILES[@]}"; do
        err "  ${f}"
    done
    err "Promotion moves the whole directory, so those entries would become part of the"
    err "official release without having been verified or voted on. Remove them first:"
    for entry in "${EXTRA_ENTRIES[@]}"; do
        err "  svn rm -m 'Remove stray entry from the ${RELEASE_VERSION} release candidate' ${CANDIDATE_URL}/${entry%/}"
    done
    err "then re-run this script. Nothing has been published."
    exit 1
fi
# The loop above only proves there is nothing EXTRA. Assert the converse too,
# so the line below is a fact rather than a hopeful summary: a candidate that
# is missing an artifact must fail here, before anything is downloaded.
MISSING_ENTRIES=()
for f in "${ART_FILES[@]}"; do
    if ! printf '%s\n' "${CANDIDATE_ENTRIES}" | grep -qxF "${f}"; then
        MISSING_ENTRIES+=("${f}")
    fi
done
if [ ${#MISSING_ENTRIES[@]} -gt 0 ]; then
    err "${CANDIDATE_URL}/ is missing ${#MISSING_ENTRIES[@]} of the ${#ART_FILES[@]} voted artifacts:"
    for f in "${MISSING_ENTRIES[@]}"; do
        err "  ${f}"
    done
    err "The candidate is incomplete — it cannot be what the vote approved."
    err "Nothing has been published."
    exit 1
fi
echo "${CANDIDATE_URL}/ holds exactly the ${#ART_FILES[@]} expected artifacts."

for f in "${ART_FILES[@]}"; do
    echo "Fetching ${f}…"
    if ! curl -fSL -o "${ART_DIR}/${f}" "${CANDIDATE_URL}/${f}"; then
        err "Could not fetch ${CANDIDATE_URL}/${f} — the candidate is incomplete."
        exit 1
    fi
done

# ========================== Step 5: Verify before publishing ==========================
note "Step 5 — Verify checksums + signatures + signer identity"

if ! (cd "${ART_DIR}" && shasum -a 512 -c "${SRC_BASE}.sha512" && shasum -a 512 -c "${BIN_BASE}.sha512"); then
    err "Checksum verification FAILED. Nothing has been published."
    exit 1
fi
echo "Checksums verified."

# Import KEYS into a THROWAWAY keyring rather than the operator's own. That
# is what turns "is this key a project release key?" into something gpg
# checks for us: in a keyring holding only KEYS, a signature from any other
# key fails with NO_PUBKEY instead of quietly passing because the operator
# happens to trust the signer personally.
KEYS_FILE="${WORK_DIR}/KEYS"
KEYS_RING="${WORK_DIR}/keys-ring"
echo "Fetching KEYS from ${SVN_KEYS_URL}…"
curl -fSL -o "${KEYS_FILE}" "${SVN_KEYS_URL}"
rm -rf "${KEYS_RING}"
mkdir -p "${KEYS_RING}"
chmod 700 "${KEYS_RING}"
if ! GNUPGHOME="${KEYS_RING}" gpg --batch --quiet --import "${KEYS_FILE}"; then
    err "Could not import ${SVN_KEYS_URL} — cannot verify the release signatures."
    exit 1
fi

SIGNER_FPR=""
for base in "${SRC_BASE}" "${BIN_BASE}"; do
    if ! signer=$(export GNUPGHOME="${KEYS_RING}"; gpg_verify_detached "${ART_DIR}/${base}" "${ART_DIR}/${base}.asc"); then
        err "${base}.asc is NOT a good signature from a key in ${SVN_KEYS_URL}."
        err "Nothing has been published. Do not promote this candidate."
        exit 1
    fi
    if ! signer_uid=$(export GNUPGHOME="${KEYS_RING}"; gpg_apache_uid "${signer}"); then
        err "${base} was signed by ${signer}, whose KEYS entry carries no @apache.org identity."
        exit 1
    fi
    if [ -n "${SIGNER_FPR}" ] && [ "${SIGNER_FPR}" != "${signer}" ]; then
        err "The two artifacts were signed by different keys (${SIGNER_FPR} vs ${signer})."
        exit 1
    fi
    SIGNER_FPR="${signer}"
    echo "✓ ${base} — good signature by ${signer_uid}"
done
echo "Signatures verified against KEYS; signing key ${SIGNER_FPR}."

# ========================== Step 6: SVN promote dev -> release ==========================
note "Step 6 — Promote on SVN: dev (RC) -> release (official)"

if [ "${RELEASED_PRESENT}" = true ]; then
    echo "Already present at release/${RELEASE_VERSION} — skipping the move."
else
    echo "  FROM (release candidate): ${SVN_DEV_URL}/${RELEASE_VERSION}/"
    echo "  TO   (official release):  ${SVN_RELEASE_URL}/${RELEASE_VERSION}/"
    if ! confirm "Move ${SVN_DEV_URL}/${RELEASE_VERSION}/ to ${SVN_RELEASE_URL}/${RELEASE_VERSION}/ now (server-side svn mv, all ${#ART_FILES[@]} artifacts)?"; then
        err "SVN move skipped — cannot continue without the official artifacts."
        exit 1
    fi
    svn_auth_init
    # The parent dir release/skywalking/horizon-ui may not exist yet (first
    # SVN-published Horizon release). svn mv into a missing parent fails, so
    # create the parent chain first.
    if ! svn_exists "${SVN_RELEASE_URL}"; then
        echo "Creating ${SVN_RELEASE_URL}/ (first Horizon release here)…"
        svn mkdir --parents "${SVN_AUTH[@]}" \
            -m "Create Horizon UI release directory" \
            "${SVN_RELEASE_URL}"
    fi
    svn mv "${SVN_AUTH[@]}" \
        -m "Release Apache SkyWalking Horizon UI ${RELEASE_VERSION}" \
        "${SVN_DEV_URL}/${RELEASE_VERSION}" \
        "${SVN_RELEASE_URL}/${RELEASE_VERSION}"
    echo "Moved to ${SVN_RELEASE_URL}/${RELEASE_VERSION}/"
fi

# Remove the release this one SUPERSEDES (ASF policy: only the current release
# stays live; older versions are auto-archived to archive.apache.org). Only
# versions BELOW the one being finalized are candidates: taking the highest
# OTHER version would, when an older maintenance line is finalized after a
# newer release is already out (1.0.1 while 1.2.0 is live), propose deleting
# the NEWER one. ASF keeps the latest of each supported line, so a higher
# version is never touched here.
LIVE_RELEASES=$(svn ls "${SVN_RELEASE_URL}/" 2>/dev/null \
    | sed 's,/$,,' \
    | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -t. -k1,1n -k2,2n -k3,3n || true)
PREV_RELEASE=""
NEWER_RELEASES=""
if [ -n "${LIVE_RELEASES}" ]; then
    PREV_RELEASE=$(printf '%s\n' "${LIVE_RELEASES}" | awk -F. -v cur="${RELEASE_VERSION}" '
        BEGIN { split(cur, c, ".") }
        ($1+0 <  c[1]+0) ||
        ($1+0 == c[1]+0 && ($2+0 <  c[2]+0 ||
        ($2+0 == c[2]+0 &&  $3+0 <  c[3]+0)))
    ' | tail -1 || true)
    NEWER_RELEASES=$(printf '%s\n' "${LIVE_RELEASES}" | awk -F. -v cur="${RELEASE_VERSION}" '
        BEGIN { split(cur, c, ".") }
        ($1+0 >  c[1]+0) ||
        ($1+0 == c[1]+0 && ($2+0 >  c[2]+0 ||
        ($2+0 == c[2]+0 &&  $3+0 >  c[3]+0)))
    ' | tr '\n' ' ' | sed 's/ *$//' || true)
fi
if [ -n "${NEWER_RELEASES}" ]; then
    echo "Newer release(s) live under ${SVN_RELEASE_URL}/ — left untouched: ${NEWER_RELEASES}"
fi
if [ -n "${PREV_RELEASE}" ]; then
    echo "Release superseded by ${RELEASE_VERSION}: ${PREV_RELEASE}"
    echo "  DELETE (this SVN path and every file in it):"
    echo "    ${SVN_RELEASE_URL}/${PREV_RELEASE}/"
    svn ls "${SVN_RELEASE_URL}/${PREV_RELEASE}/" 2>/dev/null | sed 's,^,      ,' || true
    echo "  KEEP:  ${SVN_RELEASE_URL}/${RELEASE_VERSION}/"
    echo "  ${PREV_RELEASE} stays downloadable from"
    echo "    https://archive.apache.org/dist/skywalking/horizon-ui/${PREV_RELEASE}/"
    if confirm "Delete ${SVN_RELEASE_URL}/${PREV_RELEASE}/ now?"; then
        svn_auth_init
        svn rm "${SVN_AUTH[@]}" \
            -m "Remove superseded release ${PREV_RELEASE} (archived)" \
            "${SVN_RELEASE_URL}/${PREV_RELEASE}"
        echo "Deleted ${SVN_RELEASE_URL}/${PREV_RELEASE}/."
    else
        echo "Left ${SVN_RELEASE_URL}/${PREV_RELEASE}/ in place."
    fi
fi
# Drop the credentials — nothing below writes to SVN.
SVN_AUTH=()
SVN_AUTH_READY=false

# ========================== Step 7: GitHub release ==========================
note "Step 7 — GitHub release ${TAG}"

# The release body is this version's changelog file, read out of the TAG rather
# than the working tree — the body has to describe the bytes being published,
# and the checkout this script runs from may have moved on since the release
# commit. A GitHub Release body renders with GFM hard-line-breaks, so every
# newline inside a paragraph becomes a literal <br>. The committed changelog is
# written one physical line per paragraph / list item for that reason; the
# helper joins any that were hard-wrapped anyway, as a backstop — see
# scripts/changelog-release-notes.mjs.
NOTES_FILE="${WORK_DIR}/release-notes.md"
NOTES_SOURCE="${WORK_DIR}/changelog-${RELEASE_VERSION}.md"
if ! git -C "${PROJECT_DIR}" show "${TAG}:docs/changelog/${RELEASE_VERSION}.md" > "${NOTES_SOURCE}" 2>/dev/null; then
    err "Tag ${TAG} carries no docs/changelog/${RELEASE_VERSION}.md — cannot build the release notes."
    exit 1
fi
node "${SCRIPT_DIR}/changelog-release-notes.mjs" "${RELEASE_VERSION}" "${NOTES_SOURCE}" > "${NOTES_FILE}"
{
    echo ""
    echo "---"
    echo ""
    echo "Source & binary releases (with signatures and checksums):"
    echo "* ${SVN_RELEASE_URL}/${RELEASE_VERSION}/"
    echo "* KEYS: ${SVN_KEYS_URL}"
    echo ""
    echo "Container image: \`docker pull ${DOCKERHUB_REPO}:horizon-${RELEASE_VERSION}\`"
} >> "${NOTES_FILE}"

if gh release view "${TAG}" --repo "${GH_REPO}" >/dev/null 2>&1; then
    # A previous run may have created the release and died mid-upload, so
    # "exists" is not the same as "complete" — and neither is "an asset with
    # the expected NAME is attached": an interrupted upload leaves a truncated
    # file under exactly that name, and a re-cut candidate leaves a stale one.
    # Compare every attached asset against the bytes verified in Step 5 (size
    # first, then sha512 on the downloaded copy) and replace whatever differs,
    # so what the release serves is what the vote passed.
    echo "GitHub release ${TAG} already exists — comparing its assets against the verified candidate."
    ATTACHED=$(gh release view "${TAG}" --repo "${GH_REPO}" --json assets \
        --jq '.assets[] | [.name, (.size|tostring), .state] | @tsv' 2>/dev/null || true)
    DL_DIR="${WORK_DIR}/gh-assets"
    rm -rf "${DL_DIR}"
    mkdir -p "${DL_DIR}"
    UPLOAD_ASSETS=()
    UPLOAD_REASONS=()
    for f in "${ART_FILES[@]}"; do
        remote_row=$(printf '%s\n' "${ATTACHED}" | awk -F'\t' -v n="${f}" '$1 == n { print; exit }')
        if [ -z "${remote_row}" ]; then
            UPLOAD_ASSETS+=("${f}")
            UPLOAD_REASONS+=("${f} — not attached; uploading the verified artifact")
            continue
        fi
        remote_size=$(printf '%s' "${remote_row}" | cut -f2)
        remote_state=$(printf '%s' "${remote_row}" | cut -f3)
        local_size=$(wc -c < "${ART_DIR}/${f}" | tr -d '[:space:]')
        if [ "${remote_state}" != "uploaded" ]; then
            UPLOAD_ASSETS+=("${f}")
            UPLOAD_REASONS+=("${f} — attached copy is in state '${remote_state}', not 'uploaded' (an upload that never finished); REPLACING")
            continue
        fi
        if [ "${remote_size}" != "${local_size}" ]; then
            UPLOAD_ASSETS+=("${f}")
            UPLOAD_REASONS+=("${f} — attached copy is ${remote_size} bytes, the voted artifact is ${local_size}; REPLACING")
            continue
        fi
        if ! gh release download "${TAG}" --repo "${GH_REPO}" --pattern "${f}" --dir "${DL_DIR}" >/dev/null 2>&1; then
            UPLOAD_ASSETS+=("${f}")
            UPLOAD_REASONS+=("${f} — attached copy could not be downloaded for comparison; REPLACING")
            continue
        fi
        remote_sha=$(shasum -a 512 "${DL_DIR}/${f}" | cut -d' ' -f1)
        local_sha=$(shasum -a 512 "${ART_DIR}/${f}" | cut -d' ' -f1)
        if [ "${remote_sha}" != "${local_sha}" ]; then
            UPLOAD_ASSETS+=("${f}")
            UPLOAD_REASONS+=("${f} — same size but a different sha512 (attached ${remote_sha}, voted ${local_sha}); REPLACING")
        else
            echo "✓ ${f} — attached copy is byte-identical to the voted artifact"
        fi
    done
    if [ ${#UPLOAD_ASSETS[@]} -eq 0 ]; then
        echo "All ${#ART_FILES[@]} artifacts are attached and byte-identical to the voted candidate."
    else
        echo "To (re-)upload on https://github.com/${GH_REPO}/releases/tag/${TAG}:"
        for reason in "${UPLOAD_REASONS[@]}"; do
            echo "  · ${reason}"
        done
        if confirm "Upload/overwrite these ${#UPLOAD_ASSETS[@]} asset(s) on https://github.com/${GH_REPO}/releases/tag/${TAG}?"; then
            (cd "${ART_DIR}" && gh release upload "${TAG}" --repo "${GH_REPO}" --clobber "${UPLOAD_ASSETS[@]}")
            echo "Uploaded: ${UPLOAD_ASSETS[*]}"
        else
            echo "Left release ${TAG} carrying ${#UPLOAD_ASSETS[@]} asset(s) that are missing or do not match the voted candidate."
        fi
    fi
else
    echo "Release notes preview (docs/changelog/${RELEASE_VERSION}.md at ${TAG}):"
    echo "------------------------------------------------------------"
    cat "${NOTES_FILE}"
    echo "------------------------------------------------------------"
    if confirm "Create release ${TAG} on https://github.com/${GH_REPO}/releases/tag/${TAG} with these notes and the ${#ART_FILES[@]} verified artifacts?"; then
        RELEASE_UPLOADS=()
        for f in "${ART_FILES[@]}"; do
            RELEASE_UPLOADS+=("${ART_DIR}/${f}")
        done
        # --verify-tag: without it, a ${TAG} that never reached origin makes
        # GitHub CREATE one at the default branch's HEAD — publishing a release
        # tag that points at main instead of the voted commit.
        gh release create "${TAG}" --verify-tag \
            --repo "${GH_REPO}" \
            --title "${RELEASE_VERSION}" \
            --notes-file "${NOTES_FILE}" \
            "${RELEASE_UPLOADS[@]}"
        echo "GitHub release created."
    else
        echo "Skipped GitHub release."
    fi
fi

# ========================== Step 8: Verify Docker Hub image ==========================
note "Step 8 — Verify Docker Hub image: ${DOCKERHUB_REPO}"

# The stable tags are vote-gated: the `v*` tag push publishes only the
# immutable digest. They arrive from the PROMOTION run, which the GitHub
# release published a few steps above has just triggered — so this step waits
# for it rather than assuming it already happened. Publishing stays CI's job;
# there is no local-push fallback.
#
# The wait is bounded. A multi-architecture build takes minutes, and the two
# architectures build on their own native runners before a manifest job
# stitches them, so the tag appears only at the very end.
DH_WAIT_SECONDS="${DH_WAIT_SECONDS:-1800}"
DH_POLL_SECONDS=30
DH_VERSION_TAG="${DOCKERHUB_REPO}:horizon-${RELEASE_VERSION}"
DH_LATEST_TAG="${DOCKERHUB_REPO}:latest"

# Echo the top-level manifest digest of a registry tag; empty when the tag is
# absent (or the local buildx prints a shape this cannot read, in which case
# only the existence check below applies).
dockerhub_digest() {
    docker buildx imagetools inspect "$1" 2>/dev/null | awk '$1 == "Digest:" { print $2; exit }'
}

# `:latest` must always name the NEWEST Horizon release, so the promotion run
# moves it only when the promoted tag is the highest v* in the repo. The same
# rule is applied here against THIS checkout's tag list — Step 2 only proves
# that ${TAG} itself resolves, so a checkout whose tags are stale could judge
# a superseded release "highest"; the fetch below removes that doubt. Finalizing a patch on a superseded
# line leaves `:latest` on the newer release, and demanding it here would fail
# a perfectly good maintenance release.
git -C "${PROJECT_DIR}" fetch --tags --quiet origin 2>/dev/null || true
HIGHEST_TAG=$(cd "${PROJECT_DIR}" && git tag --list 'v*' --sort=-version:refname | head -1)
IS_HIGHEST_TAG=false
if [ "${TAG}" = "${HIGHEST_TAG}" ]; then
    IS_HIGHEST_TAG=true
fi

echo "Expected on Docker Hub:"
echo "  ${DH_VERSION_TAG}   (immutable, this release)"
if [ "${IS_HIGHEST_TAG}" = true ]; then
    echo "  ${DH_LATEST_TAG}   (moving — ${TAG} is the highest v* tag in this checkout, so the promotion run points it at this release)"
else
    echo "  ${DH_LATEST_TAG} is NOT expected to move: ${HIGHEST_TAG} is higher than ${TAG}, so the promotion run left it on that release."
fi

# Wait for the promotion the release trigger started. Polls quietly; the first
# minutes are expected to be empty.
echo "Waiting for the promotion run to mirror ${DH_VERSION_TAG} (up to $((DH_WAIT_SECONDS / 60)) min)…"
echo "  Watch it: https://github.com/${GH_REPO}/actions/workflows/publish-image.yaml"
DH_WAITED=0
while ! docker buildx imagetools inspect "${DH_VERSION_TAG}" >/dev/null 2>&1; do
    if [ "${DH_WAITED}" -ge "${DH_WAIT_SECONDS}" ]; then
        break
    fi
    sleep "${DH_POLL_SECONDS}"
    DH_WAITED=$((DH_WAITED + DH_POLL_SECONDS))
    echo "  … ${DH_WAITED}s"
done

if docker buildx imagetools inspect "${DH_VERSION_TAG}" >/dev/null 2>&1; then
    DH_VERSION_DIGEST=$(dockerhub_digest "${DH_VERSION_TAG}" || true)
    echo "✓ ${DH_VERSION_TAG} is on Docker Hub — the promotion run mirrored it.${DH_VERSION_DIGEST:+ (${DH_VERSION_DIGEST})}"
    echo "  Inspect:  docker buildx imagetools inspect ${DH_VERSION_TAG}"
else
    err "✗ ${DH_VERSION_TAG} did not appear within $((DH_WAIT_SECONDS / 60)) minutes."
    err "  Publishing the GitHub release above triggers the promotion run, so it"
    err "  should be building — check whether it failed, or is merely slow. The SVN"
    err "  promote and the GitHub release already succeeded; only the image is"
    err "  missing, and re-running this script picks up where it left off."
    err "    https://github.com/${GH_REPO}/actions/workflows/publish-image.yaml"
    err "  If the run is absent (a tag that pre-dates the release trigger), start it"
    err "  by hand: workflow_dispatch with tag ${TAG}."
    err "  A longer wait: DH_WAIT_SECONDS=3600 bash scripts/release-finalize.sh"
    exit 1
fi

if [ "${IS_HIGHEST_TAG}" = true ]; then
    if ! docker buildx imagetools inspect "${DH_LATEST_TAG}" >/dev/null 2>&1; then
        err "✗ ${DH_LATEST_TAG} is NOT on Docker Hub, though ${TAG} is the highest v* tag"
        err "  and the promotion run attaches it in the same pass as ${DH_VERSION_TAG}."
        err "  One arriving without the other means that run half-failed — read it:"
        err "    https://github.com/${GH_REPO}/actions/workflows/publish-image.yaml"
        exit 1
    fi
    DH_LATEST_DIGEST=$(dockerhub_digest "${DH_LATEST_TAG}" || true)
    if [ -n "${DH_VERSION_DIGEST}" ] && [ -n "${DH_LATEST_DIGEST}" ] && [ "${DH_VERSION_DIGEST}" != "${DH_LATEST_DIGEST}" ]; then
        err "✗ ${DH_LATEST_TAG} points at ${DH_LATEST_DIGEST}, not at this release's"
        err "  ${DH_VERSION_DIGEST} (${DH_VERSION_TAG}) — 'latest' is serving something else."
        err "  Re-run the promotion for this tag to move it (workflow_dispatch, ${TAG}):"
        err "    https://github.com/${GH_REPO}/actions/workflows/publish-image.yaml"
        exit 1
    fi
    echo "✓ ${DH_LATEST_TAG} is on Docker Hub${DH_LATEST_DIGEST:+ and points at the same digest}."
else
    echo "· ${DH_LATEST_TAG} not checked — it belongs to ${HIGHEST_TAG}, the highest v* tag."
fi

# ========================== Done ==========================
note "Done — ${RELEASE_VERSION} finalized"
echo "  SVN release:   ${SVN_RELEASE_URL}/${RELEASE_VERSION}/"
echo "  Signed by:     ${SIGNER_FPR}"
echo "  GitHub:        https://github.com/${GH_REPO}/releases/tag/${TAG}"
echo "  Docker Hub:    ${DH_VERSION_TAG}"
if [ "${IS_HIGHEST_TAG}" = true ]; then
    echo "                 ${DH_LATEST_TAG} (points at this release)"
else
    echo "                 ${DH_LATEST_TAG} left on ${HIGHEST_TAG}"
fi
echo ""
echo "Remaining manual steps:"
echo "  1. Update the Docker Hub repo overview if needed"
echo "     (Docker Hub → ${DOCKERHUB_REPO} → 'Repository overview' → edit)."
echo "  2. Send the [ANNOUNCE] email to dev@ + announce@apache.org."
echo "  3. Update the download page on the SkyWalking website."
echo ""
echo "Working files left in ${WORK_DIR}/ (safe to delete)."
