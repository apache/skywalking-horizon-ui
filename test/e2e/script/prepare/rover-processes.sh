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
#     rover-processes.sh <graphql-base-url> <service-name>
#
# Prints `hasProcesses: true|false` — whether rover has reported processes for
# ANY instance of the service.
#
# Every instance is checked, not the first one. Two pipelines register
# instances under the same MESH service: OAP's ALS analysis, and rover's
# process discovery. Only rover's carry processes, and nothing orders the list
# — so picking `.[0]` reads "rover reported nothing" whenever the ALS instance
# happens to sort first, which is a coin flip rather than a fixture state.

set -eu

BASE="${1:?usage: rover-processes.sh <graphql-base-url> <service-name>}"
SERVICE="${2:?usage: rover-processes.sh <graphql-base-url> <service-name>}"

instances=$(swctl --display yaml --base-url="${BASE}" \
  instance list --service-name="${SERVICE}" | yq e '.[].name' - 2>/dev/null || true)

for instance in ${instances}; do
  count=$(swctl --display json --base-url="${BASE}" \
    process ls --service-name="${SERVICE}" --instance-name="${instance}" \
    | yq e 'length' - 2>/dev/null || echo 0)
  if [ "${count:-0}" -gt 0 ] 2>/dev/null; then
    echo "hasProcesses: true"
    exit 0
  fi
done

# The instance names are on stderr so a red check says WHICH instances were
# asked — "rover reported nothing" and "the service has no instances at all"
# are different failures with the same output.
echo "instances checked: ${instances:-<none>}" >&2
echo "hasProcesses: false"
