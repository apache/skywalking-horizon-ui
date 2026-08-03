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
# The container joins the fixture's own compose network and reaches Horizon by
# SERVICE NAME, so no host port mapping is involved and no URL has to be
# threaded through from infra-e2e.
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
# The budget exists for the data-readiness gates ahead of this case, which do
# need it. A browser suite does not: if the assertions failed once against a
# fixture already proven ready, running them again changes nothing. Record the
# first failure and short-circuit every later attempt, which also preserves
# the screenshots and trace taken closest to the cause.
if [ -f "${marker}" ]; then
  echo "passed: false"
  exit 1
fi

# Discover the fixture's network from the running horizon container rather
# than deriving it from a project name — infra-e2e and the `make dev` targets
# use different compose projects, and both must work.
container=$(docker ps --filter 'label=com.docker.compose.service=horizon' \
                      --format '{{.Names}}' | head -1)
if [ -z "${container}" ]; then
  echo "passed: false"
  echo "ERROR: no running horizon container — is the fixture up?" >&2
  exit 1
fi
network=$(docker inspect "${container}" \
  --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}')

# The whole repo is mounted, not just test/: pnpm links node_modules into the
# workspace root store, so a narrower mount leaves the symlinks dangling.
if docker run --rm \
     --network "${network}" \
     -v "${root}:/work" -w /work/test/e2e/playwright \
     -e HORIZON_BASE_URL=http://horizon:8081 \
     -e CI=1 \
     "${image}" \
     npx playwright test --project="${PROJECT}" >&2; then
  echo "passed: true"
else
  mkdir -p "$(dirname "${marker}")"
  : > "${marker}"
  echo "passed: false"
  exit 1
fi
