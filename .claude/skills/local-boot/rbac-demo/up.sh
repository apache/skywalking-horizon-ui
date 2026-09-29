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
# Boot the layer/group-grant demo: a local OAP with services in two groups of
# GENERAL (see docker-compose.yml), then a BFF on :10083 and Vite on :10093
# with the roles in roles.json and the users in users.json (password ==
# username). Ends by splitting GENERAL's sidebar entry by service group on
# that OAP, so each group is its own entry.
set -euo pipefail

D="$(cd "$(dirname "$0")" && pwd)"
REPO="$(git -C "$D" rev-parse --show-toplevel)"
ENVF="$REPO/test/e2e/script/env"
pin() { grep "^$1=" "$ENVF" | cut -d= -f2-; }
# A value already exported in the shell wins over the e2e pin.
export SW_OAP_COMMIT="${SW_OAP_COMMIT:-$(pin SW_OAP_COMMIT)}"
export SW_BANYANDB_COMMIT="${SW_BANYANDB_COMMIT:-$(pin SW_BANYANDB_COMMIT)}"
export SW_E2E_SERVICE_COMMIT="${SW_E2E_SERVICE_COMMIT:-$(pin SW_E2E_SERVICE_COMMIT)}"
export SW_OTEL_COLLECTOR_IMAGE="${SW_OTEL_COLLECTOR_IMAGE:-$(pin SW_OTEL_COLLECTOR_IMAGE)}"

BFF_PORT=${RBAC_DEMO_BFF_PORT:-10083}
UI_PORT=${RBAC_DEMO_UI_PORT:-10093}
LOGS="${TMPDIR:-/tmp}/horizon-rbac-demo"; mkdir -p "$LOGS"

docker compose -p horizon-rbac-demo -f "$D/docker-compose.yml" up -d
echo "waiting for the OAP…"
until [ "$(docker inspect -f '{{.State.Health.Status}}' horizon-rbac-demo-oap-1 2>/dev/null)" = healthy ]; do sleep 3; done

# The demo services need no -javaagent: the image presets JAVA_TOOL_OPTIONS.
HORIZON_SERVER_PORT=$BFF_PORT HORIZON_CONFIG="$REPO/horizon.yaml" \
HORIZON_OAP_QUERY_URL=http://127.0.0.1:12820 \
HORIZON_OAP_ADMIN_URL=http://127.0.0.1:17138 \
HORIZON_AUTH_LOCAL_USERS="$(cat "$D/users.json")" \
HORIZON_RBAC_BUILTIN_ROLES=keep HORIZON_RBAC_ROLES="$(cat "$D/roles.json")" \
  nohup pnpm --filter @skywalking-horizon-ui/bff run dev > "$LOGS/bff.log" 2>&1 &
echo $! > "$LOGS/bff.pid"
( cd "$REPO/apps/ui" && BFF_PORT=$BFF_PORT UI_DEV_PORT=$UI_PORT \
    env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
    nohup node_modules/.bin/vite --host 127.0.0.1 > "$LOGS/vite.log" 2>&1 & echo $! > "$LOGS/vite.pid" )

echo "waiting for the BFF…"
until curl -sf --noproxy '*' "http://127.0.0.1:$BFF_PORT/api/health" > /dev/null; do sleep 2; done

# Split GENERAL's sidebar entry per service group on this OAP: push the
# bundled template with the flag on, as the Layer dashboards admin would.
JAR="$LOGS/admin.cookies"
curl -sf --noproxy '*' -c "$JAR" -H 'content-type: application/json' \
  -d '{"username":"admin","password":"admin"}' "http://127.0.0.1:$BFF_PORT/api/auth/login" > /dev/null
python3 - "$REPO/apps/bff/src/bundled_templates/layers/general.json" <<'PY' > "$LOGS/general-split.json"
import json, sys
t = json.load(open(sys.argv[1])); t["splitByServiceGroup"] = True
print(json.dumps({"name": "horizon.layer.GENERAL", "content": t}))
PY
curl -sf --noproxy '*' -b "$JAR" -H 'content-type: application/json' \
  --data-binary "@$LOGS/general-split.json" "http://127.0.0.1:$BFF_PORT/api/admin/templates/save" > /dev/null

cat <<MSG

Open http://127.0.0.1:$UI_PORT — password is the username.

  viewer      every layer but Platform monitoring; every GENERAL entry
  maintainer  every layer, Platform monitoring included
  payments    the payments group of GENERAL only
  risk        the risk group of GENERAL only (its map still shows payments::ledger as a neighbour)
  general     the whole GENERAL layer: payments, risk and the ungrouped audit
  so11y       the OAP self-observability layer only, without cluster:read
  mixed       metrics on payments, logs on risk, alarms everywhere

Logs: $LOGS. Stop with: $D/down.sh
MSG
