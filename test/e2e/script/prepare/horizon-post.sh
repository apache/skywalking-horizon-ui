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
#     horizon-post.sh <base-url> <path> <json-body>
#
# Signs in and POSTs to an authenticated BFF route, printing the body on
# stdout. The query-shaped routes (traces, logs, landing) take their
# conditions in a body rather than the query string, so a verify case cannot
# reach them with horizon-get.sh.

set -eu

BASE="${1:?usage: horizon-post.sh <base-url> <path> <json-body>}"
PATH_="${2:?usage: horizon-post.sh <base-url> <path> <json-body>}"
BODY="${3:-{\}}"

USER="${HORIZON_E2E_USER:-e2e}"
PASSWORD="${HORIZON_E2E_PASSWORD:-e2e-passw0rd}"

JAR=$(mktemp)
trap 'rm -f "${JAR}"' EXIT

curl -sSf -c "${JAR}" -X POST "${BASE}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${USER}\",\"password\":\"${PASSWORD}\"}" > /dev/null

curl -sSf -b "${JAR}" -X POST "${BASE}${PATH_}" \
  -H 'Content-Type: application/json' \
  -d "${BODY}"
