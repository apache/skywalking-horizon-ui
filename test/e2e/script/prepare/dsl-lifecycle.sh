#!/usr/bin/env bash
#
# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements.  See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License.  You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
#     dsl-lifecycle.sh <base-url> <step>
#
# Walks the runtime-rule lifecycle a step at a time, so each verify case can
# assert one transition. MUTATES OAP — `admin` case only.
#
# The rule under test is `horizon-e2e`, deliberately: it is the LAL rule
# base-compose mounts, so it HAS a bundled twin on disk. revertToBundled is
# refused with `no_bundled_twin` for any rule pushed ad-hoc, which makes an
# invented name useless for testing restore.
#
# Steps, and the contract each one pins:
#   debug-start   a debug session needs the rule LIVE, not merely pushed —
#                 OAP answers rule_not_found until the apply reaches APPLIED
#   revert-active revertToBundled on an ACTIVE rule is REFUSED; restore is a
#                 two-step flow, inactivate first
#   inactivate    the soft pause — synchronous, no schema change
#   revert        …and only then does the bundled rule come back

set -eu

BASE="${1:?usage: dsl-lifecycle.sh <base-url> <step>}"
STEP="${2:?usage: dsl-lifecycle.sh <base-url> <step>}"
RULE=horizon-e2e

USER="${HORIZON_E2E_USER:-e2e}"
PASSWORD="${HORIZON_E2E_PASSWORD:-e2e-passw0rd}"
JAR=$(mktemp)
trap 'rm -f "${JAR}"' EXIT
curl -sSf -c "${JAR}" -X POST "${BASE}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${USER}\",\"password\":\"${PASSWORD}\"}" > /dev/null

case "${STEP}" in
  debug-start)
    curl -sSf -b "${JAR}" -X POST "${BASE}/api/debug/session" \
      -H 'Content-Type: application/json' \
      -d "{\"clientId\":\"e2e\",\"catalog\":\"lal\",\"name\":\"${RULE}\",\"ruleName\":\"${RULE}\",\"durationSeconds\":30}"
    ;;
  sessions)
    curl -sSf -b "${JAR}" "${BASE}/api/debug/sessions"
    ;;
  revert-active)
    # NO -f here, deliberately. The refusal is an HTTP 409 — semantically
    # right, since it conflicts with the rule's current state — and `curl -f`
    # discards the body of any 4xx, which is exactly the body carrying the
    # contract. Emit the code alongside it so the case pins both.
    body=$(curl -sS -o /dev/null -w '%{http_code}' -b "${JAR}" -X POST \
      "${BASE}/api/rule/delete?catalog=lal&name=${RULE}&mode=revertToBundled")
    status=$(curl -sS -b "${JAR}" -X POST \
      "${BASE}/api/rule/delete?catalog=lal&name=${RULE}&mode=revertToBundled" \
      | sed -n 's/.*"applyStatus":"\([a-z_]*\)".*/\1/p')
    printf '{"httpCode": %s, "applyStatus": "%s"}\n' "${body}" "${status}"
    ;;
  inactivate)
    curl -sSf -b "${JAR}" -X POST "${BASE}/api/rule/inactivate?catalog=lal&name=${RULE}"
    ;;
  revert)
    curl -sSf -b "${JAR}" -X POST \
      "${BASE}/api/rule/delete?catalog=lal&name=${RULE}&mode=revertToBundled"
    ;;
  *)
    echo "unknown step: ${STEP}" >&2
    exit 1
    ;;
esac
