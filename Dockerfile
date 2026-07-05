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

# From-source, multi-arch image. Single source of truth for every image
# build: CI (GHCR), local dev, and the manual Docker Hub release push.
#
# Why from-source (not copy-in): `dist/node_modules` carries argon2's
# native binding, which is architecture-specific. Building `dist/` INSIDE
# the image — once per target platform — lets one `buildx --platform
# linux/amd64,linux/arm64` invocation compile the correct binding for each
# arch (native on a matching runner, QEMU-emulated otherwise). A copy-in
# image cannot do this from a single host.
#
#     docker build -t horizon-ui:local .          # single-arch dev build
#     docker buildx build --platform linux/amd64,linux/arm64 -t … --push .
#
# Trade-off: the build needs the network (`pnpm install`) — but only in the
# throwaway build stage. The final shipped stage is network-free.

# ---- build stage: compile the self-contained dist for THIS platform ----
# Throwaway BUILD ENVIRONMENT — uses the network (`pnpm install`) and
# carries the compiler toolchain. Discarded; only the final stage ships.
FROM node:24-alpine AS build
WORKDIR /src

# Toolchain for argon2's native build (node-gyp needs python3 + make + g++).
RUN apk add --no-cache python3 make g++

# corepack ships with node:24; pin pnpm to the workspace version.
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

# Copy the whole source tree. `.dockerignore` keeps host-built artifacts
# (node_modules, dist) out of the context so nothing arch-specific leaks in.
COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm package

# ---- runtime stage: the shipped image — no toolchain, no network ----
FROM node:24-alpine
WORKDIR /app

RUN addgroup -S horizon && adduser -S -G horizon horizon

COPY --from=build /src/dist/server.js              ./server.js
COPY --from=build /src/dist/package.json           ./package.json
COPY --from=build /src/dist/node_modules           ./node_modules
COPY --from=build /src/dist/static                 ./static
# The fully tokenized horizon.yaml is the active config — every field is a
# `${HORIZON_…:default}` token, so the image runs with NO mounted file:
# `docker run -e HORIZON_OAP_QUERY_URL=… -e HORIZON_AUTH_LOCAL_USERS='[…]' …`
# is enough. A bind-mount at /app/horizon.yaml still overrides it.
COPY --from=build /src/dist/horizon.yaml           ./horizon.yaml

COPY --from=build --chown=horizon:horizon /src/dist/bundled_templates  ./bundled_templates
COPY --from=build --chown=horizon:horizon /src/dist/resources           ./resources

RUN mkdir -p /data && chown horizon:horizon /data
VOLUME ["/data"]

# Static source-map mount point for the Browser Errors tab (#6784). Drop
# (or bind-mount) `.map` files here and they're indexed at boot — durable
# across restarts, unlike runtime uploads which live in memory only.
RUN mkdir -p /app/sourcemaps && chown horizon:horizon /app/sourcemaps

ENV NODE_ENV=production \
    HORIZON_SERVER_HOST=0.0.0.0 \
    HORIZON_SERVER_PORT=8081 \
    HORIZON_STATIC_DIR=/app/static \
    HORIZON_CONFIG=/app/horizon.yaml \
    HORIZON_AUDIT_FILE=/data/horizon-audit.jsonl \
    HORIZON_SETUP_FILE=/data/horizon-setup.json \
    HORIZON_ALARMS_FILE=/data/horizon-alarms.json \
    HORIZON_WIRE_LOG_FILE=/data/horizon-wire.jsonl \
    HORIZON_SOURCEMAPS_DIR=/app/sourcemaps \
    # Match this to the container memory limit and your sourceMaps budget — the in-heap map cache lives inside it.
    NODE_OPTIONS=--max-old-space-size=768

USER horizon
EXPOSE 8081
CMD ["node", "server.js"]
