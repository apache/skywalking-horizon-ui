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
# Tear the layer/group-grant demo down: the BFF, Vite and the compose stack.
set -uo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
LOGS="${TMPDIR:-/tmp}/horizon-rbac-demo"
for p in bff vite; do [ -f "$LOGS/$p.pid" ] && pkill -P "$(cat "$LOGS/$p.pid")" 2>/dev/null; [ -f "$LOGS/$p.pid" ] && kill "$(cat "$LOGS/$p.pid")" 2>/dev/null; done
docker compose -p horizon-rbac-demo -f "$D/docker-compose.yml" down -v
