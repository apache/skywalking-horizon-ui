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
#     make setup CASE=core bring the stack up and leave it up
#     make cleanup CASE=core

E2E ?= e2e
CASE ?= core
CASE_FILE = cases/$(CASE)/e2e.yaml

.PHONY: images
images:
	bash script/prepare/build-images.sh

# Skips the slow Horizon build. Use while iterating on specs or compose, when
# the app image is already current.
.PHONY: images-demo
images-demo:
	SKIP_HORIZON_IMAGE=true bash script/prepare/build-images.sh

.PHONY: run
run:
	$(E2E) run -c $(CASE_FILE)

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
