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
#     playwright.sh <project>
#
# Runs one Playwright project and reduces it to the single line infra-e2e
# compares against an `expected` file.
#
# The browser runs INSIDE the pinned Ubuntu image, never on the host. The e2e
# environment is therefore one platform everywhere: a laptop run reproduces CI
# exactly instead of approximately, and nothing depends on what the developer
# happens to have installed. It also removes the whole class of "passes on my
# machine" caused by fonts, system libraries or a differently-patched Chromium.
#
# The container joins the fixture's own network and reaches Horizon by
# CONTAINER NAME, so no host port mapping is involved and no URL has to be
# threaded through from infra-e2e. See the discovery block below for how that
# differs between a compose fixture and a kind one.
#
# Playwright's own output goes to STDERR on purpose: infra-e2e parses stdout as
# YAML and diffs it, so a stray reporter line there would fail the case with a
# diff instead of the real error. Report, traces and screenshots land in
# test/e2e/playwright/{playwright-report,test-results} for the CI artifact.

set -eu

PROJECT="${1:?usage: playwright.sh <project>}"

here=$(cd "$(dirname "$0")/../.." && pwd)   # test/e2e
root=$(cd "${here}/../.." && pwd)           # repo root
marker="/tmp/skywalking-infra-e2e/playwright-${PROJECT}.failed"

image=$(grep -E '^SW_PLAYWRIGHT_IMAGE=' "${here}/script/env" | head -1 | cut -d= -f2-)

# infra-e2e's retry budget is global to `verify`, and VerifyCase carries no
# per-case override — so a genuinely failing browser project gets re-run for
# the whole budget. That turns a real regression from a 20-second answer into
# a quarter of an hour, and overwrites the artifacts each round, so what
# survives is the LAST failure rather than the first.
#
# The budget exists for the data-readiness checks ahead of this case, which do
# need it. A browser suite does not: if the assertions failed once against a
# fixture already proven ready, running them again changes nothing. Record the
# first failure and short-circuit every later attempt, which also preserves
# the screenshots and trace taken closest to the cause.
if [ -f "${marker}" ]; then
  echo "passed: false"
  exit 1
fi

# Where Horizon is depends on how the fixture was stood up, and both shapes
# have to work:
#
#   compose  — a horizon container on the case's own network, reached by
#              service name. Discovered from the container rather than derived
#              from a project name, because infra-e2e and `make dev` use
#              different compose projects.
#
#   kind     — Horizon runs inside the cluster, so there is no such container.
#              The browser instead joins the network the kind NODE is on and
#              calls the node's NodePort. Deliberately not the host port-
#              forward infra-e2e sets up for the checks: that binds to the
#              host's loopback, which a container only shares on Linux, and
#              the without-profiling variant exists precisely so a developer
#              on macOS can run this.
#
# Either way the browser runs in a container on a docker network and addresses
# the fixture by container name, so a laptop run and a CI run are identical.
container=$(docker ps --filter 'label=com.docker.compose.service=horizon' \
                      --format '{{.Names}}' | head -1)
if [ -n "${container}" ]; then
  target="http://horizon:8081"
else
  container=$(docker ps --filter 'label=io.x-k8s.kind.role=control-plane' \
                        --format '{{.Names}}' | head -1)
  if [ -z "${container}" ]; then
    echo "passed: false"
    echo "ERROR: found neither a horizon container nor a kind node — is the fixture up?" >&2
    exit 1
  fi
  node_port=$(grep -E '^HORIZON_E2E_NODE_PORT=' "${here}/script/env" | head -1 | cut -d= -f2-)
  target="http://${container}:${node_port}"
fi
network=$(docker inspect "${container}" \
  --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}')

# The whole repo is mounted, not just test/: pnpm links node_modules into the
# workspace root store, so a narrower mount leaves the symlinks dangling.
if docker run --rm \
     --network "${network}" \
     -v "${root}:/work" -w /work/test/e2e/playwright \
     -e HORIZON_BASE_URL="${target}" \
     -e HORIZON_E2E_PROJECT="${PROJECT}" \
     -e CI=1 \
     "${image}" \
     npx playwright test --project="${PROJECT}" >&2; then
  echo "passed: true"
else
  mkdir -p "$(dirname "${marker}")"
  : > "${marker}"

  # Cluster state, captured HERE rather than from a later CI step, because
  # infra-e2e's `cleanup: on: always` deletes the kind cluster the moment the
  # case ends — a workflow step that runs afterwards finds nothing to talk to
  # and collects an empty directory. This is the last moment the cluster is
  # still up. Best-effort: it must never turn a test failure into a
  # collector failure.
  bash "${here}/script/prepare/collect-k8s.sh" \
    "${root}/e2e-logs/cluster-${PROJECT}" >&2 2>&1 || true

  echo "passed: false"
  exit 1
fi
