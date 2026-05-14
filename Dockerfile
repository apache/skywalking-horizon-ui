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

# ---- builder ----------------------------------------------------------------
# Builds the BFF bundle + the Vite SPA in a single workspace install. Final
# image only carries the BFF dist + UI dist + the production dependency tree
# (no source, no devDependencies, no pnpm store).
FROM node:20-alpine AS builder
WORKDIR /workspace

# argon2 (password hashing) builds a native module; alpine needs python + a
# C toolchain at build time. The deps are dropped from the runtime stage.
RUN apk add --no-cache python3 make g++ libc6-compat
# corepack reads `packageManager` from package.json — no need to pin the
# pnpm version here. Adding `--activate` so the binary is in PATH for
# subsequent layers.
RUN corepack enable && corepack prepare --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/bff/package.json apps/bff/
COPY apps/ui/package.json apps/ui/
COPY packages/api-client/package.json packages/api-client/
COPY packages/design-tokens/package.json packages/design-tokens/
COPY packages/templates/package.json packages/templates/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @skywalking-horizon-ui/bff build \
 && pnpm --filter @skywalking-horizon-ui/ui  build

# Deploy a focused production install for the BFF — pnpm copies only the
# packages it actually needs (workspace deps + runtime npm deps). The
# `--legacy` flag is mandatory under pnpm 10+ for non-injected
# workspaces (the alternative is enabling `inject-workspace-packages`
# everywhere, which we don't need for plain workspace deps).
RUN pnpm deploy --legacy --filter @skywalking-horizon-ui/bff --prod /deploy/bff

# ---- runtime ---------------------------------------------------------------
FROM node:20-alpine
WORKDIR /app

# Run as a non-root user — the BFF doesn't need any privileged access.
RUN addgroup -S horizon && adduser -S -G horizon horizon

COPY --from=builder /deploy/bff/dist ./dist
COPY --from=builder /deploy/bff/node_modules ./node_modules
COPY --from=builder /deploy/bff/package.json ./package.json
# The bundled layer + overview JSONs must sit one level up from the
# compiled server (`/app/dist/server.js`). The loader resolves them via
# `path.join(__dirname, '..', 'bundled_templates', ...)` — keeping this
# layout in sync with the source tree means no path remapping at boot.
COPY --from=builder /workspace/apps/bff/src/bundled_templates ./bundled_templates
COPY --from=builder /workspace/apps/ui/dist ./static
COPY --from=builder /workspace/horizon.example.yaml ./horizon.example.yaml

ENV NODE_ENV=production \
    HORIZON_STATIC_DIR=/app/static \
    HORIZON_CONFIG=/app/horizon.yaml

USER horizon
EXPOSE 8081
CMD ["node", "dist/server.js"]
