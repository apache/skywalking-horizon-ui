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
# Boot the trace + log demo: a local OAP fed native, OTLP and Zipkin traces
# with the logs written inside them (see docker-compose.yml), then a BFF on
# :10084 and Vite on :10094 from this checkout, with the dev users (password
# == username).
set -euo pipefail

D="$(cd "$(dirname "$0")" && pwd)"
REPO="$(git -C "$D" rev-parse --show-toplevel)"
ENVF="$REPO/test/e2e/script/env"
pin() { grep "^$1=" "$ENVF" | cut -d= -f2-; }
# A value already exported in the shell wins over the e2e pin.
export SW_OAP_COMMIT="${SW_OAP_COMMIT:-$(pin SW_OAP_COMMIT)}"
export SW_BANYANDB_COMMIT="${SW_BANYANDB_COMMIT:-$(pin SW_BANYANDB_COMMIT)}"
export SW_E2E_SERVICE_COMMIT="${SW_E2E_SERVICE_COMMIT:-$(pin SW_E2E_SERVICE_COMMIT)}"
export TRAFFIC_GEN_IMAGE="${TRAFFIC_GEN_IMAGE:-$(pin TRAFFIC_GEN_IMAGE)}"

BFF_PORT=${TRACE_LOG_DEMO_BFF_PORT:-10084}
UI_PORT=${TRACE_LOG_DEMO_UI_PORT:-10094}
LOGS="${TMPDIR:-/tmp}/horizon-trace-log-demo"; mkdir -p "$LOGS"

# The demo services and the Python caller are built locally, never pulled.
for img in "horizon-e2e-demo-provider:$SW_E2E_SERVICE_COMMIT" "horizon-e2e-demo-consumer:$SW_E2E_SERVICE_COMMIT"; do
  docker image inspect "$img" > /dev/null 2>&1 || { echo "missing $img — run: make -C $REPO/test/e2e images-demo" >&2; exit 1; }
done

docker compose -p horizon-trace-log-demo -f "$D/docker-compose.yml" up -d
echo "waiting for the OAP (OAP $SW_OAP_COMMIT)…"
until [ "$(docker inspect -f '{{.State.Health.Status}}' horizon-trace-log-demo-oap-1 2>/dev/null)" = healthy ]; do sleep 3; done

cd "$REPO"
HORIZON_SERVER_PORT=$BFF_PORT HORIZON_CONFIG="$REPO/horizon.yaml" \
HORIZON_OAP_QUERY_URL=http://127.0.0.1:12830 \
HORIZON_OAP_ADMIN_URL=http://127.0.0.1:17148 \
HORIZON_OAP_ZIPKIN_URL=http://127.0.0.1:9422/zipkin \
HORIZON_OAP_TRACEQL_URL=http://127.0.0.1:3210 \
HORIZON_AUTH_LOCAL_USERS="$(cat "$D/../dev-users.json")" \
  nohup pnpm --filter @skywalking-horizon-ui/bff run dev > "$LOGS/bff.log" 2>&1 &
echo $! > "$LOGS/bff.pid"
( cd "$REPO/apps/ui" && BFF_PORT=$BFF_PORT UI_DEV_PORT=$UI_PORT \
    env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
    nohup node_modules/.bin/vite --host 127.0.0.1 > "$LOGS/vite.log" 2>&1 & echo $! > "$LOGS/vite.pid" )

echo "waiting for the BFF…"
until curl -sf --noproxy '*' "http://127.0.0.1:$BFF_PORT/api/health" > /dev/null; do sleep 2; done

cat <<MSG

Open http://127.0.0.1:$UI_PORT — admin / admin (password == username).

  native  General Service -> Traces (e2e-service-provider, /logs/trigger) or
          its Logs tab, whose lines open their trace: the trace's Logs, and
          the span's Related logs
  OTLP    OTLP Service -> OTLP traces (e2e-otel-python): Logs, and the LLM
          span's Related logs
  Zipkin  Operate -> Trace inspect, target Zipkin, service e2e-zipkin-python:
          the same two

Traces and logs start landing a minute after the OAP is up. OAP: GraphQL
:12830, admin :17148, OTLP / agent gRPC :11820, Zipkin :9422, TraceQL :3210.
Logs: $LOGS. Stop with: $D/down.sh
MSG
