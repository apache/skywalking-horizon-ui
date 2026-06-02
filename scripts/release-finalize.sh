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
#   1. Promote the voted artifacts on SVN: server-side move from
#        dist/dev/skywalking/horizon-ui/<v>/   (release candidate)
#      to
#        dist/release/skywalking/horizon-ui/<v>/   (official release)
#      and remove the PREVIOUS release from release/ (ASF keeps only the
#      current release live; older ones are auto-archived).
#
#   2. Cut a GitHub release on tag v<v>, attaching the SAME voted bytes
#      (src + bin tarballs + .asc + .sha512) fetched back from SVN release,
#      with the CHANGELOG section for <v> as the body.
#
#   3. Verify the Docker Hub multi-arch image — CI's publish-image
#      workflow mirrors the GHCR image to Docker Hub automatically on
#      every `v*` tag push (apache/skywalking-ui:horizon-<v> and
#      apache/skywalking-ui:latest). This step only CONFIRMS the two
#      expected tags are present; publishing is CI's job. There is no
#      local-push fallback — if the tags are missing, re-run the
#      publish-image workflow and re-run this script.
#
# Usage:  bash scripts/release-finalize.sh
#
# The script is idempotent-ish and confirms before every irreversible step
# (SVN move, SVN delete, gh release). Nothing destructive happens without
# a y/N. The Docker Hub image is published by CI, not here.

set -e -o pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PROJECT_DIR=$(cd "${SCRIPT_DIR}/.." && pwd)
PRODUCT_NAME="apache-skywalking-horizon-ui"

SVN_DEV_URL="https://dist.apache.org/repos/dist/dev/skywalking/horizon-ui"
SVN_RELEASE_URL="https://dist.apache.org/repos/dist/release/skywalking/horizon-ui"

DOCKERHUB_REPO="apache/skywalking-ui"
WORK_DIR="${SCRIPT_DIR}/.finalize-work"
# ========================== Helpers ==========================

err() { echo "ERROR: $*" >&2; }
note() { echo ""; echo "=== $* ==="; }

confirm() {
    local prompt="$1"
    read -r -p "${prompt} [y/N] " ans
    [[ "$ans" == "y" || "$ans" == "Y" ]]
}

svn_exists() {
    svn ls "$1" >/dev/null 2>&1
}

# ========================== Step 1: Tool + auth preflight ==========================
note "Step 1 — Tool + auth preflight"

MISSING=()
for t in svn gh git docker shasum curl; do
    command -v "$t" >/dev/null || MISSING+=("$t")
done
if [ ${#MISSING[@]} -gt 0 ]; then
    err "Missing required tools: ${MISSING[*]}"
    exit 1
fi

if ! docker buildx version >/dev/null 2>&1; then
    err "docker buildx is required (Step 5 uses 'imagetools inspect' to"
    err "verify the CI-published Docker Hub tags)."
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

# ========================== Step 3: SVN move dev -> release ==========================
note "Step 3 — Promote on SVN: dev (RC) -> release (official)"

echo "  FROM (release candidate): ${SVN_DEV_URL}/${RELEASE_VERSION}/"
echo "  TO   (official release):  ${SVN_RELEASE_URL}/${RELEASE_VERSION}/"

read -r -p "Apache SVN username: " SVN_USER
read -r -s -p "Apache SVN password: " SVN_PASS
echo ""
SVN_AUTH=(--username "${SVN_USER}" --password "${SVN_PASS}" --non-interactive --no-auth-cache)

if ! svn_exists "${SVN_DEV_URL}/${RELEASE_VERSION}"; then
    err "Release candidate not found at ${SVN_DEV_URL}/${RELEASE_VERSION}/."
    err "Did scripts/release.sh upload it? (Step 13)"
    exit 1
fi

if svn_exists "${SVN_RELEASE_URL}/${RELEASE_VERSION}"; then
    echo "Already present at release/${RELEASE_VERSION} — skipping the move (idempotent)."
else
    # The parent dir release/skywalking/horizon-ui may not exist yet (first
    # SVN-published Horizon release). svn mv into a missing parent fails, so
    # create the parent chain first.
    if ! svn_exists "${SVN_RELEASE_URL}"; then
        echo "Creating ${SVN_RELEASE_URL}/ (first Horizon release here)…"
        svn mkdir --parents "${SVN_AUTH[@]}" \
            -m "Create Horizon UI release directory" \
            "${SVN_RELEASE_URL}"
    fi
    if confirm "Run the server-side svn mv now?"; then
        svn mv "${SVN_AUTH[@]}" \
            -m "Release Apache SkyWalking Horizon UI ${RELEASE_VERSION}" \
            "${SVN_DEV_URL}/${RELEASE_VERSION}" \
            "${SVN_RELEASE_URL}/${RELEASE_VERSION}"
        echo "Moved to ${SVN_RELEASE_URL}/${RELEASE_VERSION}/"
    else
        err "SVN move skipped — cannot continue without the official artifacts."
        exit 1
    fi
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
        svn rm "${SVN_AUTH[@]}" \
            -m "Remove superseded release ${PREV_RELEASE} (archived)" \
            "${SVN_RELEASE_URL}/${PREV_RELEASE}"
        echo "Removed release/${PREV_RELEASE}/."
    else
        echo "Left release/${PREV_RELEASE}/ in place."
    fi
fi
unset SVN_PASS

# ========================== Step 4: GitHub release ==========================
note "Step 4 — GitHub release ${TAG}"

# Pull the VOTED artifacts back from release/ so the GitHub release attaches
# byte-identical files to what the PMC voted on (not a fresh rebuild).
ART_DIR="${WORK_DIR}/artifacts"
mkdir -p "${ART_DIR}"
SRC_BASE="${PRODUCT_NAME}-${RELEASE_VERSION}-src.tar.gz"
BIN_BASE="${PRODUCT_NAME}-${RELEASE_VERSION}-bin.tar.gz"
for f in \
    "${SRC_BASE}" "${SRC_BASE}.asc" "${SRC_BASE}.sha512" \
    "${BIN_BASE}" "${BIN_BASE}.asc" "${BIN_BASE}.sha512"; do
    echo "Fetching ${f}…"
    curl -fSL -o "${ART_DIR}/${f}" "${SVN_RELEASE_URL}/${RELEASE_VERSION}/${f}"
done

# Re-verify the checksums locally before attaching.
(cd "${ART_DIR}" && shasum -a 512 -c "${SRC_BASE}.sha512" && shasum -a 512 -c "${BIN_BASE}.sha512")
echo "Checksums verified."

# Extract the CHANGELOG section for this version as the release body.
NOTES_FILE="${WORK_DIR}/release-notes.md"
awk -v v="${RELEASE_VERSION}" '
    $0 == "## " v   { in_sec=1; next }
    in_sec && /^## / { in_sec=0 }
    in_sec           { print }
' "${PROJECT_DIR}/CHANGELOG.md" > "${NOTES_FILE}"
{
    echo ""
    echo "---"
    echo ""
    echo "Source & binary releases (with signatures and checksums):"
    echo "* ${SVN_RELEASE_URL}/${RELEASE_VERSION}/"
    echo "* KEYS: https://dist.apache.org/repos/dist/release/skywalking/KEYS"
    echo ""
    echo "Container image: \`docker pull ${DOCKERHUB_REPO}:horizon-${RELEASE_VERSION}\`"
} >> "${NOTES_FILE}"

if gh release view "${TAG}" --repo apache/skywalking-horizon-ui >/dev/null 2>&1; then
    echo "GitHub release ${TAG} already exists — skipping create."
else
    echo "Release notes preview:"
    echo "------------------------------------------------------------"
    cat "${NOTES_FILE}"
    echo "------------------------------------------------------------"
    if confirm "Create the GitHub release ${TAG} and attach the 6 artifacts?"; then
        gh release create "${TAG}" \
            --repo apache/skywalking-horizon-ui \
            --title "${RELEASE_VERSION}" \
            --notes-file "${NOTES_FILE}" \
            "${ART_DIR}/${SRC_BASE}" \
            "${ART_DIR}/${SRC_BASE}.asc" \
            "${ART_DIR}/${SRC_BASE}.sha512" \
            "${ART_DIR}/${BIN_BASE}" \
            "${ART_DIR}/${BIN_BASE}.asc" \
            "${ART_DIR}/${BIN_BASE}.sha512"
        echo "GitHub release created."
    else
        echo "Skipped GitHub release."
    fi
fi

# ========================== Step 5: Verify Docker Hub image ==========================
note "Step 5 — Verify Docker Hub image: ${DOCKERHUB_REPO}"

# CI (.github/workflows/publish-image.yaml) mirrors the multi-arch image
# to Docker Hub automatically on every `v*` tag push, so by the time
# you're finalizing a passed vote it is already live. This step only
# VERIFIES the expected tags are present — publishing is CI's job, there
# is no local-push fallback.
DH_VERSION_TAG="${DOCKERHUB_REPO}:horizon-${RELEASE_VERSION}"
DH_LATEST_TAG="${DOCKERHUB_REPO}:latest"

echo "Expected on Docker Hub:"
echo "  ${DH_VERSION_TAG}   (immutable, this release)"
echo "  ${DH_LATEST_TAG}                      (moving — newest Horizon release)"

if docker buildx imagetools inspect "${DH_VERSION_TAG}" >/dev/null 2>&1; then
    echo "✓ ${DH_VERSION_TAG} is on Docker Hub — CI's publish-image mirror succeeded."
    echo "  Inspect:  docker buildx imagetools inspect ${DH_VERSION_TAG}"
else
    err "✗ ${DH_VERSION_TAG} is NOT on Docker Hub."
    err "  CI's publish-image workflow did not mirror tag ${TAG}. The SVN promote +"
    err "  GitHub release above already succeeded; only the image is missing. Re-run"
    err "  the workflow (workflow_dispatch with tag ${TAG}), then re-run this script:"
    err "    https://github.com/apache/skywalking-horizon-ui/actions/workflows/publish-image.yaml"
    exit 1
fi

# ========================== Done ==========================
note "Done — ${RELEASE_VERSION} finalized"
echo "  SVN release:   ${SVN_RELEASE_URL}/${RELEASE_VERSION}/"
echo "  GitHub:        https://github.com/apache/skywalking-horizon-ui/releases/tag/${TAG}"
echo "  Docker Hub:    ${DOCKERHUB_REPO}:horizon-${RELEASE_VERSION}"
echo ""
echo "Remaining manual steps:"
echo "  1. Update the Docker Hub repo overview if needed"
echo "     (Docker Hub → ${DOCKERHUB_REPO} → 'Repository overview' → edit)."
echo "  2. Send the [ANNOUNCE] email to dev@ + announce@apache.org."
echo "  3. Update the download page on the SkyWalking website."
echo ""
echo "Working files left in ${WORK_DIR}/ (safe to delete)."
