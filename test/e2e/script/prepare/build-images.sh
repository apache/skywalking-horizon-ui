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

# Builds the two images the compose files reference but no registry carries:
# the instrumented demo services, and Horizon itself.
#
# Run before any case. CI runs it as a workflow step; locally it is
# `make -C test/e2e images`. Both paths go through this script so a case can
# never be run against an image built a different way.

set -eu

here=$(cd "$(dirname "$0")/.." && pwd)   # test/e2e/script
root=$(cd "${here}/../../.." && pwd)     # repo root

# Read one key from script/env exactly the way infra-e2e does: split on the
# first `=`, take the rest verbatim. Sourcing the file instead would let bash
# expand the `$` segments of the argon2 hash to nothing — see the note there.
val() {
  grep -E "^$1=" "${here}/env" | head -1 | cut -d= -f2-
}

SW_AGENT_JAVA_COMMIT=$(val SW_AGENT_JAVA_COMMIT)
SW_AGENT_JDK_VERSION=$(val SW_AGENT_JDK_VERSION)
SW_E2E_SERVICE_COMMIT=$(val SW_E2E_SERVICE_COMMIT)
HORIZON_E2E_IMAGE=$(val HORIZON_E2E_IMAGE)

AGENT_IMAGE="ghcr.io/apache/skywalking-java/skywalking-java:${SW_AGENT_JAVA_COMMIT}-java${SW_AGENT_JDK_VERSION}"

build_demo() {
  local role="$1"
  echo "▸ building horizon-e2e-demo-${role}:${SW_E2E_SERVICE_COMMIT}"
  docker build \
    --build-arg "AGENT_IMAGE=${AGENT_IMAGE}" \
    --build-arg "APP_IMAGE=ghcr.io/apache/skywalking/e2e-service-${role}:${SW_E2E_SERVICE_COMMIT}" \
    -t "horizon-e2e-demo-${role}:${SW_E2E_SERVICE_COMMIT}" \
    -f "${here}/Dockerfile.demo-service" \
    "${here}"
}

build_demo provider
build_demo consumer

# Horizon last: it is the slow one, and a failure in the cheap builds above
# should surface first.
if [ "${SKIP_HORIZON_IMAGE:-}" = "true" ]; then
  echo "▸ skipping ${HORIZON_E2E_IMAGE} (SKIP_HORIZON_IMAGE=true)"
else
  echo "▸ building ${HORIZON_E2E_IMAGE} from ${root}"
  docker build -t "${HORIZON_E2E_IMAGE}" "${root}"
fi

# The chart's init container asks for `curlimages/curl` with no tag, which
# docker resolves to `:latest`. A kind case must side-load exactly that
# reference, so it cannot be pinned in the import list — pin the CONTENT here
# instead: pull a fixed version and re-tag it as the name the pod will request.
# Skipped silently when the pull fails and something is already tagged locally,
# so an offline run keeps working.
CURL_IMAGE=$(val SW_CURL_IMAGE)
if docker pull -q "${CURL_IMAGE}" > /dev/null 2>&1; then
  docker tag "${CURL_IMAGE}" curlimages/curl:latest
  echo "▸ pinned curlimages/curl:latest to ${CURL_IMAGE}"
elif docker image inspect curlimages/curl:latest > /dev/null 2>&1; then
  echo "▸ curlimages/curl:latest already present (pull failed, using local)"
else
  echo "ERROR: cannot resolve ${CURL_IMAGE} and no local curlimages/curl:latest" >&2
  exit 1
fi

echo "images ready"
