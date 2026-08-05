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
#     dsl-push.sh <base-url> <catalog> <name>
#
# Hot-updates a runtime rule. The rule body is text/plain, not JSON, so
# horizon-post.sh cannot carry it.
#
# MUTATES OAP — only the `admin` case may call this. A rule pushed under any
# other case would change the backend its neighbours are asserting against.

set -eu

BASE="${1:?usage: dsl-push.sh <base-url> <catalog> <name>}"
CATALOG="${2:?usage: dsl-push.sh <base-url> <catalog> <name>}"
NAME="${3:?usage: dsl-push.sh <base-url> <catalog> <name>}"

USER="${HORIZON_E2E_USER:-e2e}"
PASSWORD="${HORIZON_E2E_PASSWORD:-e2e-passw0rd}"

JAR=$(mktemp)
trap 'rm -f "${JAR}"' EXIT

curl -sSf -c "${JAR}" -X POST "${BASE}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${USER}\",\"password\":\"${PASSWORD}\"}" > /dev/null

# A minimal but VALID rule: it must parse, or OAP rejects it structurally and
# the apply phase never reaches APPLIED. Deliberately inert — it sinks nothing
# and matches nothing, so it cannot alter what other assertions observe.
curl -sSf -b "${JAR}" -X POST "${BASE}/api/rule?catalog=${CATALOG}&name=${NAME}" \
  -H 'Content-Type: text/plain' \
  --data-binary "rules:
  - name: ${NAME}
    layer: GENERAL
    dsl: |
      filter {
        sink {
        }
      }
"
