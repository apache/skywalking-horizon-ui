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
#     dev-compose.sh <case> <compose args...>
#
# Runs docker compose for a case the way infra-e2e does, for the `make dev`
# stack that outlives the command that started it.
#
# Why not `docker compose --env-file script/env`: compose INTERPOLATES `$` in
# values read from an env file, so the argon2 hash collapses to blanks
# ("argon2id variable is not set") and every login fails. infra-e2e instead
# splits each line on the first `=` and exports the value verbatim. Compose
# does not re-interpolate values substituted from the environment, so loading
# them that way and leaving --env-file off reproduces infra-e2e's behaviour
# exactly — one parsing convention across the whole tree, which is what
# script/env documents.

set -eu

CASE="${1:?usage: dev-compose.sh <case> <compose args...>}"
shift

here=$(cd "$(dirname "$0")/../.." && pwd)   # test/e2e

while IFS= read -r line; do
  case "${line}" in
    '#'* | '') continue ;;
  esac
  key=${line%%=*}
  val=${line#*=}
  [ "${key}" = "${line}" ] && continue
  export "${key}=${val}"
done < "${here}/script/env"

exec docker compose \
  -p horizon-e2e-dev \
  -f "${here}/cases/${CASE}/docker-compose.yml" \
  "$@"
