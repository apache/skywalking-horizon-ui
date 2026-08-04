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
#     echo-coverage.sh <case>
#
# Prints what a case covers, at the TOP of its console output — so a red run
# says what the case was responsible for before it says what broke, and a
# green one says what it did NOT cover.
#
# The text is READ OUT OF the case table in .github/workflows/e2e.yaml. That
# table has to exist anyway for anyone reading the CI config, so keeping a
# second copy beside each case would only give the two something to drift
# apart over. Changing what a case claims to cover means editing that table.

set -eu

CASE="${1:?usage: echo-coverage.sh <case>}"

here=$(cd "$(dirname "$0")/../.." && pwd)   # test/e2e
workflow="${here}/../../.github/workflows/e2e.yaml"

if [ ! -f "${workflow}" ]; then
  echo "ERROR: cannot find ${workflow} to read the case table from." >&2
  exit 1
fi

# An entry is the line naming the case plus the deeper-indented lines under
# it, and ends at the blank comment line before the next one. Anything else —
# including the prose that follows the table — must not be swept in, so the
# entry ends on the first line that is neither.
entry=$(awk -v want="${CASE}" '
  # `#   <case>  <deployment>` — 3 spaces, the case name, then its stack.
  /^#   [a-z0-9_-]+ +[A-Za-z]/ {
    inside = ($2 == want)
    if (inside) { sub(/^#   /, ""); print }
    next
  }
  # Continuation: 4 or more spaces, so a case line can never match.
  inside && /^#    +[^ ]/ { sub(/^#   /, ""); print; next }
  inside { inside = 0 }
' "${workflow}")

if [ -z "${entry}" ]; then
  echo "ERROR: no entry for case '${CASE}' in the table in ${workflow}." >&2
  exit 1
fi

echo ""
echo "┌───────────────────────────────────────────────────────────────────────"
printf '│  E2E CASE: %s\n' "${CASE}"
echo "├───────────────────────────────────────────────────────────────────────"
printf '%s\n' "${entry}" | while IFS= read -r line; do
  printf '│  %s\n' "${line}"
done
echo "└───────────────────────────────────────────────────────────────────────"
echo ""
