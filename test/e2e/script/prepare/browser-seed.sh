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
#     browser-seed.sh <oap-query-base-url>
#
# Posts browser error logs straight to OAP's browser receiver.
#
# Upstream's browser case builds a client-js instrumented web app from source
# and drives it. That produces the same records this does, at the cost of two
# image builds from GitHub tarballs — for a UI repo whose interest is what
# Horizon renders, not whether the JS agent serialises correctly, the receiver
# is the honest boundary to seed at. The wire format is the browser receiver's
# own BrowserErrorLog, so the records are indistinguishable from agent-sent
# ones by the time Horizon reads them.

set -eu

BASE="${1:?usage: browser-seed.sh <oap-query-base-url>}"
SERVICE="${BROWSER_SERVICE:-e2e-browser-app}"
COUNT="${BROWSER_ERROR_COUNT:-12}"

now=$(node -e 'process.stdout.write(String(Date.now()))')

# perfData FIRST, and it is not optional: the browser service is registered by
# the performance-data path, not by error logs. Seeding only errors leaves OAP
# accepting every post with a 200 while `getAllServices` stays empty and the
# BROWSER layer never appears — which reads as a Horizon bug and is not one.
perf=$(node -e '
  const [service, now] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({
    service, serviceVersion: "v1.0.0", time: Number(now), pagePath: "/e2e/checkout",
    redirectTime: 1, dnsTime: 2, ttfbTime: 3, tcpTime: 4, transTime: 5,
    domAnalysisTime: 6, fptTime: 7, domReadyTime: 8, loadPageTime: 9,
    resTime: 10, sslTime: 11, ttlTime: 12, firstPackTime: 13, fmpTime: 14,
  }));
' "${SERVICE}" "${now}")
curl -sSf -o /dev/null -X POST "${BASE}/browser/perfData" \
  -H 'Content-Type: application/json' -d "${perf}" \
  || { echo "ERROR: OAP rejected the browser perf data — no service will register." >&2; exit 1; }

sent=0
for i in $(seq 1 "${COUNT}"); do
  payload=$(node -e '
    const [service, now, i] = process.argv.slice(1);
    process.stdout.write(JSON.stringify([{
      uniqueId: `e2e-${i}`,
      service,
      serviceVersion: "v1.0.0",
      time: Number(now) - (Number(i) * 1000),
      pagePath: "/e2e/checkout",
      category: "js",
      grade: "Error",
      message: `e2e synthetic failure ${i}`,
      line: 42,
      col: 7,
      stack: `TypeError: cannot read properties of undefined\n    at checkout (/assets/app.min.js:42:7)`,
      errorUrl: "/assets/app.min.js",
      firstReportedError: Number(i) === 1,
    }]));
  ' "${SERVICE}" "${now}" "${i}")
  if curl -sSf -o /dev/null -X POST "${BASE}/browser/errorLogs" \
       -H 'Content-Type: application/json' -d "${payload}"; then
    sent=$(( sent + 1 ))
  fi
done

echo "browser errors seeded: ${sent}/${COUNT}"

if [ "${sent}" -eq 0 ]; then
  echo "ERROR: OAP's browser receiver accepted nothing — the fixture is broken." >&2
  exit 1
fi
