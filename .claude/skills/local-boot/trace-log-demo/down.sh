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
#
# Tear the trace + log demo down: the BFF, Vite and the compose stack.
set -uo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
LOGS="${TMPDIR:-/tmp}/horizon-trace-log-demo"
REPO="$(git -C "$D" rev-parse --show-toplevel)"
ENVF="$REPO/test/e2e/script/env"
pin() { grep "^$1=" "$ENVF" | cut -d= -f2-; }
# Compose resolves every image to read the file, even to take it down — the
# same pins up.sh exports, so a fresh shell can stop what up.sh started.
export SW_OAP_COMMIT="${SW_OAP_COMMIT:-$(pin SW_OAP_COMMIT)}"
export SW_BANYANDB_COMMIT="${SW_BANYANDB_COMMIT:-$(pin SW_BANYANDB_COMMIT)}"
export SW_E2E_SERVICE_COMMIT="${SW_E2E_SERVICE_COMMIT:-$(pin SW_E2E_SERVICE_COMMIT)}"
export TRAFFIC_GEN_IMAGE="${TRAFFIC_GEN_IMAGE:-$(pin TRAFFIC_GEN_IMAGE)}"
# Each pid is a launcher (pnpm -> tsx watch -> the server): stop the whole tree
# it started, and nothing else.
tree() { local c; for c in $(pgrep -P "$1"); do tree "$c"; done; echo "$1"; }
for p in bff vite; do
  [ -f "$LOGS/$p.pid" ] || continue
  kill $(tree "$(cat "$LOGS/$p.pid")") 2>/dev/null
  rm -f "$LOGS/$p.pid"
done
docker compose -p horizon-trace-log-demo -f "$D/docker-compose.yml" down -v
