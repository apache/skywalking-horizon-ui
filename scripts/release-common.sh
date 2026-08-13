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

# Shared helpers for the two halves of the Apache release flow:
# scripts/release.sh (build + sign + upload the RC) and
# scripts/release-finalize.sh (verify + promote it after the vote).
# This file is SOURCED, never executed; it assumes the caller has already
# set `set -e -o pipefail`.
#
# Why the GPG helpers work in full primary-key FINGERPRINTS: `gpg` signs
# with its own default key whenever no --local-user is passed, and that
# default is invisible to a script that merely *listed* the keyring. A
# release script that inspects one key and then signs without pinning it
# can validate key A and ship a signature made by key B. So every helper
# here resolves a selector to exactly one fingerprint, pins it on the
# signing call, and re-reads the produced signature to confirm who really
# signed it.

err() { echo "ERROR: $*" >&2; }
note() { echo ""; echo "=== $* ==="; }

confirm() {
    local prompt="$1"
    read -r -p "${prompt} [y/N] " ans
    [[ "$ans" == "y" || "$ans" == "Y" ]]
}

# Echo the primary fingerprint of the ONE secret key that should sign this
# release. Selection order: HORIZON_RELEASE_GPG_KEY, then git's
# user.signingkey, then — only when the keyring holds exactly one secret
# key — that key. Ambiguity is an error rather than a guess: picking for
# the operator is how a release ends up signed by a personal key.
gpg_resolve_signing_key() {
    local selector count listing fpr

    selector="${HORIZON_RELEASE_GPG_KEY:-}"
    if [ -z "${selector}" ]; then
        selector=$(git config --get user.signingkey 2>/dev/null || true)
    fi
    if [ -z "${selector}" ]; then
        count=$(gpg --list-secret-keys --with-colons 2>/dev/null | awk -F: '$1 == "sec" { n++ } END { print n + 0 }' || true)
        if [ "${count}" = "0" ]; then
            err "No GPG secret key found. Import your Apache release key first."
            return 1
        fi
        if [ "${count}" != "1" ]; then
            err "${count} GPG secret keys are present and none is selected — refusing to guess which one signs the release."
            err "Pick one:  git config user.signingkey <fingerprint>   (or export HORIZON_RELEASE_GPG_KEY=<fingerprint>)"
            return 1
        fi
        selector=$(gpg --list-secret-keys --with-colons 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }' || true)
    fi

    if ! listing=$(gpg --list-secret-keys --with-colons -- "${selector}" 2>/dev/null); then
        err "No GPG secret key matches '${selector}'."
        return 1
    fi
    count=$(printf '%s\n' "${listing}" | awk -F: '$1 == "sec" { n++ } END { print n + 0 }')
    if [ "${count}" = "0" ]; then
        err "No GPG secret key matches '${selector}'."
        return 1
    fi
    if [ "${count}" != "1" ]; then
        err "'${selector}' matches ${count} secret keys — narrow it to one full fingerprint."
        return 1
    fi
    # The first `fpr` record of a `--list-secret-keys` listing belongs to the
    # PRIMARY key, so a selector naming a signing subkey still resolves to the
    # primary; gpg then picks the right subkey itself.
    fpr=$(printf '%s\n' "${listing}" | awk -F: '$1 == "fpr" { print $10; exit }')
    if [ -z "${fpr}" ]; then
        err "Could not read the fingerprint of GPG key '${selector}'."
        return 1
    fi
    printf '%s' "${fpr}"
}

# Echo the non-revoked, non-expired user IDs of ONE key (public part), so a
# caller can check the identity of exactly the key it resolved instead of
# whatever uid happens to be first in the whole keyring.
gpg_key_uids() {
    gpg --list-keys --with-colons -- "$1" 2>/dev/null \
        | awk -F: '$1 == "uid" && $2 != "r" && $2 != "e" { print $10 }'
}

# Echo the key's first @apache.org user ID; non-zero when it has none.
gpg_apache_uid() {
    local uids uid
    uids=$(gpg_key_uids "$1") || return 1
    while IFS= read -r uid; do
        if [[ "${uid}" == *@apache.org* ]]; then
            printf '%s' "${uid}"
            return 0
        fi
    done <<< "${uids}"
    return 1
}

# Verify <file> against detached <sig>, echoing the PRIMARY fingerprint of
# the key that made the signature. Non-zero when the signature is bad,
# unverifiable, or made by a key the current keyring does not hold.
#
# It reads --status-fd rather than gpg's human output because gpg exits 0
# for a good signature from an untrusted key too, and the status stream is
# the only stable way to learn WHICH key signed. VALIDSIG's field 1 is the
# signing key — a subkey, usually — while its 10th (overall field 12) is the
# primary key; callers compare against the primary, so report that.
gpg_verify_detached() {
    local file="$1" sig="$2" status fpr
    status=$(gpg --batch --status-fd 1 --verify "${sig}" "${file}" 2>/dev/null) || return 1
    case "${status}" in
        *"[GNUPG:] GOODSIG "*) ;;
        *) return 1 ;;
    esac
    fpr=$(printf '%s\n' "${status}" \
        | awk '$1 == "[GNUPG:]" && $2 == "VALIDSIG" { print (NF >= 12 ? $12 : $3); exit }')
    [ -n "${fpr}" ] || return 1
    printf '%s' "${fpr}"
}

# Sign <file> with the pinned key, then prove the .asc it just wrote really
# is that key's signature. The --local-user pin is what makes the proof
# meaningful; the re-read is what makes it a proof rather than an assumption.
gpg_sign_and_verify() {
    local file="$1" key="$2" signer base
    base=$(basename "${file}")
    rm -f "${file}.asc"
    if ! gpg --local-user "${key}" --armor --detach-sig "${file}"; then
        err "GPG signing of ${base} failed with key ${key}."
        return 1
    fi
    if ! signer=$(gpg_verify_detached "${file}" "${file}.asc"); then
        err "The signature just written for ${base} does not verify."
        return 1
    fi
    if [ "${signer}" != "${key}" ]; then
        err "${base}.asc was signed by ${signer}, not the selected key ${key}."
        return 1
    fi
}
