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

# Local entry points. CI drives the same scripts, so a case can never be run
# one way here and another way there.
#
#     make images          build the images compose expects (never pulled)
#     make run CASE=core   full infra-e2e cycle for one case
#     make run-istio-without-profiling   the mesh case minus rover (macOS)
#     make dev CASE=core   bring the stack up and LEAVE it up (see below)
#     make dev-down CASE=core

E2E ?= e2e
CASE ?= core
# A case's commands run with infra-e2e's own working directory, and the cases
# spell every script from the REPO ROOT (`bash test/e2e/script/...`) because
# that is where CI invokes the CLI. So a case runs from there too — started
# from `test/e2e` it dies on its first step, with a `No such file or
# directory` that reads like a missing script rather than a wrong directory.
# `$(CURDIR)` is this Makefile's directory — `test/e2e` — so reaching the
# repo root takes TWO levels, not one. With one, every case file resolved
# against `test/` and infra-e2e reported the case as "not exist", which
# reads as a missing file rather than a wrong directory.
ROOT = $(CURDIR)/../..
CASE_FILE = test/e2e/cases/$(CASE)/e2e.yaml

.PHONY: images
images:
	bash script/prepare/build-images.sh

# Skips the slow Horizon build. Use while iterating on specs or compose, when
# the app image is already current.
.PHONY: images-demo
images-demo:
	SKIP_HORIZON_IMAGE=true bash script/prepare/build-images.sh

# The browser runner records a first failure in a marker file so infra-e2e's
# retry budget cannot re-run a red suite fifteen times. That file lives in
# /tmp and outlives the run, which is right within one run and wrong between
# them: locally, the next `make run` would short-circuit the browser project
# and report the PREVIOUS failure without executing a single spec. CI never
# sees it (fresh runner each time), so clearing it here is what makes a local
# re-run mean what it appears to mean.
.PHONY: run
run:
	rm -f /tmp/skywalking-infra-e2e/playwright-*.failed
	cd $(ROOT) && $(E2E) run -c $(CASE_FILE)

# The istio case with profiling switched off, for machines with no Linux
# kernel for eBPF probes to attach to. Same case file, same fixture — the flag
# drops the rover deployment and the verification that depends on it.
.PHONY: run-istio-without-profiling
run-istio-without-profiling:
	cd $(ROOT) && E2E_SKIP_PROFILING=true $(E2E) run -c test/e2e/cases/istio/e2e.yaml

# Spec iteration: a stack that OUTLIVES the command that started it.
#
# `e2e setup` cannot do this. The cases set `cleanup: on: always`, which leaves
# testcontainers' reaper enabled, so every container dies the moment the CLI
# process exits — you get a stack for about a second. Driving compose directly
# is the supported way to hold one open.
#
#     make dev                                    # start, stay up
#     make dev-url                                # → the Horizon URL
#     cd playwright && HORIZON_BASE_URL=<url> pnpm exec playwright test --project=ui --headed
#     make dev-down
.PHONY: dev dev-url dev-logs dev-down
DEV := bash script/prepare/dev-compose.sh $(CASE)

dev:
	$(DEV) up -d --wait

# compose reports the bind address (0.0.0.0), which is not a usable client
# address — rewrite it to loopback so the output can be pasted straight in.
dev-url:
	@echo "http://$$($(DEV) port horizon 8081 | sed 's/^0\.0\.0\.0/127.0.0.1/')"

# The stack alone produces NO data: in a case run it is infra-e2e's `trigger`
# block that drives the demo app, and `make dev` has no equivalent. Without
# this the roster is empty and most specs fail against a perfectly good build.
.PHONY: dev-traffic
dev-traffic:
	@url=http://$$($(DEV) port consumer 9092 | sed 's/^0\.0\.0\.0/127.0.0.1/'); \
	  secs=$${SECONDS_TO_RUN:-120}; \
	  echo "driving $$url/users for $${secs}s"; \
	  end=$$(( $$(date +%s) + secs )); \
	  while [ $$(date +%s) -lt $$end ]; do \
	    curl -sf -o /dev/null -X POST "$$url/users" \
	      -H 'Content-Type: application/json' -d '{"id":"123","name":"skywalking"}' || true; \
	    sleep 2; \
	  done; \
	  echo "traffic done"

dev-logs:
	$(DEV) logs

dev-down:
	$(DEV) down -v --remove-orphans
