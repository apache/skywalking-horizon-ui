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
#      the .sha512 checksums, the .asc detached signatures, and the signer
#      itself — checked inside a throwaway keyring built only from the
#      project's published KEYS file, so a signature from a key that is not
#      a SkyWalking release key cannot verify. The signing key must also
#      carry an @apache.org identity, and both artifacts must be signed by
#      the same key.
#
#   3. ONLY THEN promote on SVN: server-side move from dev/ to release/,
#      and remove the PREVIOUS release from release/ (ASF keeps only the
#      current release live; older ones are auto-archived).
#
#   4. Cut a GitHub release on tag v<v>, attaching the SAME voted bytes
#      (src + bin tarballs + .asc + .sha512) that were just verified, with
#      the CHANGELOG section for <v> as the body. A release that already
#      exists gets only its MISSING assets uploaded.
#
#   5. Verify the Docker Hub multi-arch image (apache/skywalking-ui:horizon-<v>
#      and apache/skywalking-ui:latest). These are NOT published by the tag
#      push: a tag is only a release candidate until the vote passes, so the
#      tag build publishes the immutable digest tag alone. The stable tags and
#      the Docker Hub mirror are attached by re-running the publish-image
#      workflow via workflow_dispatch for that tag, which is the promotion
#      step and belongs BEFORE this script. Publishing stays CI's job; this
#      step only CONFIRMS the two tags arrived.
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
echo "Finalizing ${RELEASE_VERSION} (tag ${TAG})."
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

# ========================== Step 4: Download the candidate ==========================
note "Step 4 — Download the candidate (nothing is published yet)"

ART_DIR="${WORK_DIR}/artifacts"
mkdir -p "${ART_DIR}"
SRC_BASE="${PRODUCT_NAME}-${RELEASE_VERSION}-src.tar.gz"
BIN_BASE="${PRODUCT_NAME}-${RELEASE_VERSION}-bin.tar.gz"
ART_FILES=(
    "${SRC_BASE}" "${SRC_BASE}.asc" "${SRC_BASE}.sha512"
    "${BIN_BASE}" "${BIN_BASE}.asc" "${BIN_BASE}.sha512"
)
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
    if ! confirm "Run the server-side svn mv now?"; then
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

# Remove the PREVIOUS release from release/ (ASF policy: only the current
# release stays live; older versions are auto-archived to archive.apache.org).
PREV_RELEASE=$(svn ls "${SVN_RELEASE_URL}/" 2>/dev/null \
    | sed 's,/$,,' \
    | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' \
    | grep -vx "${RELEASE_VERSION}" \
    | sort -t. -k1,1n -k2,2n -k3,3n \
    | tail -1 || true)
if [ -n "${PREV_RELEASE}" ]; then
    echo "Previous release in release/: ${PREV_RELEASE}"
    if confirm "Remove release/${PREV_RELEASE}/ (auto-archived, still downloadable from archive.apache.org)?"; then
        svn_auth_init
        svn rm "${SVN_AUTH[@]}" \
            -m "Remove superseded release ${PREV_RELEASE} (archived)" \
            "${SVN_RELEASE_URL}/${PREV_RELEASE}"
        echo "Removed release/${PREV_RELEASE}/."
    else
        echo "Left release/${PREV_RELEASE}/ in place."
    fi
fi
# Drop the credentials — nothing below writes to SVN.
SVN_AUTH=()
SVN_AUTH_READY=false

# ========================== Step 7: GitHub release ==========================
note "Step 7 — GitHub release ${TAG}"

# Extract the CHANGELOG section for this version as the release body. The
# committed CHANGELOG is hard-wrapped at ~80 cols, which reflows cleanly in
# the repo file view but renders as a ragged column of <br>-broken short
# lines in a GitHub Release body (GFM hard-line-breaks). The helper unwraps
# each paragraph / list item onto one line so the release body flows; see
# scripts/changelog-release-notes.mjs for the full rationale.
NOTES_FILE="${WORK_DIR}/release-notes.md"
node "${SCRIPT_DIR}/changelog-release-notes.mjs" "${RELEASE_VERSION}" "${PROJECT_DIR}/CHANGELOG.md" > "${NOTES_FILE}"
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
    # "exists" is not the same as "complete" — attach whatever is missing.
    echo "GitHub release ${TAG} already exists — checking its assets."
    ATTACHED=$(gh release view "${TAG}" --repo "${GH_REPO}" --json assets --jq '.assets[].name' 2>/dev/null || true)
    MISSING_ASSETS=()
    for f in "${ART_FILES[@]}"; do
        case $'\n'"${ATTACHED}"$'\n' in
            *$'\n'"${f}"$'\n'*) ;;
            *) MISSING_ASSETS+=("${f}") ;;
        esac
    done
    if [ ${#MISSING_ASSETS[@]} -eq 0 ]; then
        echo "All ${#ART_FILES[@]} artifacts are already attached."
    else
        echo "Missing assets: ${MISSING_ASSETS[*]}"
        if confirm "Upload the ${#MISSING_ASSETS[@]} missing asset(s) to release ${TAG}?"; then
            (cd "${ART_DIR}" && gh release upload "${TAG}" --repo "${GH_REPO}" --clobber "${MISSING_ASSETS[@]}")
            echo "Assets uploaded."
        else
            echo "Left release ${TAG} with missing assets."
        fi
    fi
else
    echo "Release notes preview:"
    echo "------------------------------------------------------------"
    cat "${NOTES_FILE}"
    echo "------------------------------------------------------------"
    if confirm "Create the GitHub release ${TAG} and attach the ${#ART_FILES[@]} artifacts?"; then
        RELEASE_UPLOADS=()
        for f in "${ART_FILES[@]}"; do
            RELEASE_UPLOADS+=("${ART_DIR}/${f}")
        done
        gh release create "${TAG}" \
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
# immutable digest, and these two arrive when the publish-image workflow is
# re-run via workflow_dispatch for the tag — the promotion step, which the
# release manager does once the vote passes and before running this script.
# This step only VERIFIES they arrived; publishing is CI's job, there is no
# local-push fallback.
DH_VERSION_TAG="${DOCKERHUB_REPO}:horizon-${RELEASE_VERSION}"
DH_LATEST_TAG="${DOCKERHUB_REPO}:latest"

echo "Expected on Docker Hub:"
echo "  ${DH_VERSION_TAG}   (immutable, this release)"
echo "  ${DH_LATEST_TAG}                      (moving — newest Horizon release)"

if docker buildx imagetools inspect "${DH_VERSION_TAG}" >/dev/null 2>&1; then
    echo "✓ ${DH_VERSION_TAG} is on Docker Hub — the promotion run mirrored it."
    echo "  Inspect:  docker buildx imagetools inspect ${DH_VERSION_TAG}"
else
    err "✗ ${DH_VERSION_TAG} is NOT on Docker Hub."
    err "  The stable image tags are attached by the promotion run, not by the tag"
    err "  push — most likely it has not been run yet. The SVN promote + GitHub"
    err "  release above already succeeded; only the image is missing. Run the"
    err "  workflow (workflow_dispatch with tag ${TAG}), then re-run this script:"
    err "    https://github.com/${GH_REPO}/actions/workflows/publish-image.yaml"
    exit 1
fi

# ========================== Done ==========================
note "Done — ${RELEASE_VERSION} finalized"
echo "  SVN release:   ${SVN_RELEASE_URL}/${RELEASE_VERSION}/"
echo "  Signed by:     ${SIGNER_FPR}"
echo "  GitHub:        https://github.com/${GH_REPO}/releases/tag/${TAG}"
echo "  Docker Hub:    ${DOCKERHUB_REPO}:horizon-${RELEASE_VERSION}"
echo ""
echo "Remaining manual steps:"
echo "  1. Update the Docker Hub repo overview if needed"
echo "     (Docker Hub → ${DOCKERHUB_REPO} → 'Repository overview' → edit)."
echo "  2. Send the [ANNOUNCE] email to dev@ + announce@apache.org."
echo "  3. Update the download page on the SkyWalking website."
echo ""
echo "Working files left in ${WORK_DIR}/ (safe to delete)."
