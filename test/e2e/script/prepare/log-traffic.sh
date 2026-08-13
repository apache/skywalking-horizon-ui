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
#     log-traffic.sh <provider-base-url> [count]
#
# Fires a burst at the demo app's log-emitting endpoint.
#
# Why a burst here rather than the `trigger` block: a case gets exactly one
# trigger, and that one is spent on the consumer -> provider call, which is
# what produces the service and instance topology. Logs come from a DIFFERENT
# endpoint on the provider, so they need their own nudge. A burst is enough —
# logs are queried over a 30-minute window, so they do not need topping up the
# way the metrics widgets do.

set -eu

BASE="${1:?usage: log-traffic.sh <provider-base-url> [count]}"
COUNT="${2:-30}"

sent=0
for _ in $(seq 1 "${COUNT}"); do
  if curl -sf -o /dev/null "${BASE}/logs/trigger"; then
    sent=$(( sent + 1 ))
  fi
  sleep 1
done

echo "log traffic: ${sent}/${COUNT} ok"

if [ "${sent}" -eq 0 ]; then
  echo "ERROR: the demo app never served /logs/trigger — no logs will exist." >&2
  exit 1
fi
