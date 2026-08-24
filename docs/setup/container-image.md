# Container Image

Horizon UI ships a single multi-arch container image (linux/amd64 + linux/arm64). The image bundles both the BFF and the built UI — there is no separate frontend container.

## Where to get it

Registry: **GitHub Container Registry (GHCR)** at `ghcr.io/apache/skywalking-horizon-ui`.

| Tag | Points at | Use case |
|---|---|---|
| `<40-char-sha>` | Exact commit. Immutable. | **Production.** Pin to a SHA so deploys are reproducible. |
| `X.Y.Z` | A released version. | Stable release. Same image as the SHA it was built from. |
| `X.Y` | Latest released patch on a minor line. Moves over time. | Track a minor release line. |
| `latest` | The newest released version. Moves. | Demos / dev only — do not pin production to `latest`. |
| `main` | Head of `main`. Moves on every merge. | Smoke-test the development branch. |

```sh
docker pull ghcr.io/apache/skywalking-horizon-ui:0.7.0
docker pull ghcr.io/apache/skywalking-horizon-ui:<sha>
```

The full commit SHA is the canonical, immutable identifier. Moving tags are conveniences that point at the same SHA-built image.

Pushing a `vX.Y.Z` git tag publishes the `:<sha>` image only — that tag is a release *candidate* until the Apache release vote passes. The `X.Y.Z`, `X.Y` and `latest` tags, and the Docker Hub mirror, are attached afterwards, when the release is promoted. `latest` moves only if the promoted version is the highest one released, so publishing a patch on an older line never drags it backwards.

## Image layout

| Path inside the container | Owner | Writable by `horizon`? | What it is |
|---|---|---|---|
| `/app/server.js` | root | no | Compiled BFF entry point. `CMD` runs `node server.js`. |
| `/app/node_modules/` | root | no | Production npm dependencies. |
| `/app/static/` | root | no | Built UI assets (Vite `dist/`). |
| `/app/horizon.yaml` | root | no | The **active** config — a **baked, fully tokenized default** (every field is a `${HORIZON_…:default}` env token). The image runs with no mounted file; override any field via env (see [Run with env vars only](#run-with-env-vars-only-no-mounted-file)), or bind-mount your own to replace it. |
| `/app/bundled_templates/` | horizon | (read) | Bundled layer + overview JSON templates — the read-only **seed source**. In the default `templates.mode: live` they are seeded into OAP's `ui_template` store at boot; in `readonly` mode dashboards render straight from this bundle. Nothing writes here at runtime — admin template edits are stored in OAP, not in the container. |
| `/data/` | **horizon** | **yes** | Declared `VOLUME`. Default destination for the wire debug log. Mount a PVC / named volume / host bind here for durable storage. |
| `/app/sourcemaps/` | **horizon** | (read) | Static source maps for the **Browser Logs** tab. Bind-mount or copy `.map` files here and they're loaded at boot — durable across restarts. Optional; runtime uploads work without it. See [Browser Logs & Source Maps](../operate/browser-source-maps.md). |

The runtime stage runs as the non-root user `horizon`. `/data/` is owned by `horizon` so the wire debug log can be written without operator intervention.

## Environment variables

| Variable | Default in image | Purpose |
|---|---|---|
| `NODE_ENV` | `production` | Drives the logger format (JSON vs pretty) and Node optimizations. |
| `LOG_LEVEL` | (unset → `warn` in production, `debug` in dev) | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |
| `HORIZON_VERSION` | (unset → the build's baked version string) | Overrides the version string reported by the public `GET /api/health` probe endpoint. |
| `HORIZON_CONFIG` | `/app/horizon.yaml` | Where the BFF looks for `horizon.yaml`. Override to mount elsewhere. |
| `HORIZON_STATIC_DIR` | `/app/static` | Where the BFF serves UI assets from. |
| `HORIZON_WIRE_LOG_FILE` | `/data/horizon-wire.jsonl` | Default for `debugLog.file` when `horizon.yaml` doesn't override it. |
| `HORIZON_SOURCEMAPS_DIR` | `/app/sourcemaps` | Default for `sourceMaps.bootMountDir` — the directory scanned at boot for statically-provisioned `.map` files. See [Browser Logs & Source Maps](../operate/browser-source-maps.md). |

`HORIZON_WIRE_LOG_FILE` seeds the **default** the config schema uses when `horizon.yaml` doesn't supply a value. An explicit value in `horizon.yaml` always wins. The intent: an operator who runs the published image with only a minimal `horizon.yaml` (no `debugLog` block) gets the file routed to `/data/` automatically, no manual path override needed.

`server.host` and `server.port` come from the YAML when present. If they are omitted, the image supplies defaults via `HORIZON_SERVER_HOST=0.0.0.0` and `HORIZON_SERVER_PORT=8081`. The image sets `EXPOSE 8081`; if you change `server.port`, also publish the new port.

## Run with env vars only (no mounted file)

The baked `/app/horizon.yaml` is **fully tokenized** — every config field is a `${HORIZON_…:default}` env var — so you can run the published image with **no mounted config** and set only the vars you need. Precedence is **env var > the baked file's default > built-in default**. The config file itself is the complete, self-documenting list; the table below mirrors it.

Scalar vars take a plain value; **list / object vars take a JSON string** (injected into the YAML and parsed). A `null`/`[]` default means "use the built-in default".

| Variable | Default | Type | Sets |
|---|---|---|---|
| `HORIZON_TEMPLATES_MODE` | `live` | `live` \| `readonly` | Template source: OAP 11 REST-backed storage (`live`) vs. the local bundle (`readonly`). OAP 10 requires `readonly` because Horizon does not consume its legacy GraphQL template API. |
| `HORIZON_OAP_QUERY_URL` | `http://127.0.0.1:12800` | url | OAP GraphQL / query host. |
| `HORIZON_OAP_ADMIN_URL` | `http://127.0.0.1:17128` | url | OAP admin host (runtime-rule / inspect / status). |
| `HORIZON_OAP_ZIPKIN_URL` | `http://127.0.0.1:9412/zipkin` | url | OAP Zipkin v2 host. |
| `HORIZON_OAP_TIMEOUT_MS` | `15000` | int | Outbound OAP request timeout. |
| `HORIZON_OAP_MQE` | (none) | JSON | MQE endpoint override for the Metrics Inspect page, e.g. `{"host":"mqe.internal","port":12800}` (both fields optional). Defaults to the query host — see [OAP Connection](oap.md#mqe-endpoint-override-oapmqe). |
| `HORIZON_OAP_AUTH` | (none) | JSON | OAP basic-auth, e.g. `{"username":"sw","password":"sw"}`. |
| `HORIZON_AUTH_BACKEND` | `local` | `local` \| `ldap` | Auth backend. |
| `HORIZON_AUTH_LOCAL_USERS` | `[]` | JSON | Local users: `[{"username":"admin","passwordHash":"$argon2id$…","roles":["admin"]}]` (hash via `pnpm --filter bff cli:hash`). |
| `HORIZON_AUTH_LDAP` | (none) | JSON | LDAP block: `{"url":"ldaps://…","userBaseDn":"…","groupMappings":[{"group":"*","role":"viewer"}]}`. |
| `HORIZON_AUTH_BREAK_GLASS` | (none) | JSON | Break-glass admin (honored only when `ldap` + LDAP probe failing). |
| `HORIZON_RBAC_ENABLED` | `true` | bool | When `false`, every session gets `*`. |
| `HORIZON_RBAC_ROLES` | (built-in) | JSON | Role → verb-grants map. |
| `HORIZON_RBAC_LANDING_BY_ROLE` | (built-in) | JSON | Post-login landing route per role. |
| `HORIZON_LAYERS_EXCLUDED` | `FAAS`, `VIRTUAL_GATEWAY` | JSON | Layers hidden from the sidebar; `[]` shows all. |
| `HORIZON_SESSION_TTL_MINUTES` | `60` | int | Session lifetime. |
| `HORIZON_SESSION_COOKIE_NAME` | `horizon_sid` | string | Session cookie name. |
| `HORIZON_SESSION_COOKIE_SECURE` | `false` | bool | Set `true` behind HTTPS. |
| `HORIZON_QUERY_LANDING_SERVICE_CAP` | `100` | int | Max services a layer landing fetches metrics for per request. |
| `HORIZON_QUERY_OVERVIEW_TOPN` | `100` | int | Top-N window the Overview KPI tiles' `top_n(...)` rollups use (the `{{topn}}` placeholder). Raise it only if a single layer holds more than 100 services and the tail matters to the aggregate. |
| `HORIZON_SOURCEMAPS_ENABLED` | `true` | bool | Source-map upload / resolve capability. |
| `HORIZON_SOURCEMAPS_MAX_FILE_BYTES` | `67108864` | int | Reject a `.map` larger than this (64 MiB). |
| `HORIZON_SOURCEMAPS_MAX_TOTAL_BYTES` | `536870912` | int | In-memory map budget (512 MiB, LRU-evicted). |
| `HORIZON_SOURCEMAPS_MAX_FILE_COUNT` | `128` | int | Max hosted maps. |
| `HORIZON_DEBUG_LOG_ENABLED` | `false` | bool | OAP wire debug log. |
| `HORIZON_DEBUG_LOG_MAX_BODY_CHARS` | `8192` | int | Wire-log body truncation. |
| `HORIZON_DEBUG_LOG_REDACT_AUTH` | `true` | bool | Redact auth headers in the wire log. |
| `HORIZON_AI_ENABLED` | `false` | bool | AI assistant master switch. See [AI Assistant](../operate/ai-assistant.md). |
| `HORIZON_AI_PROVIDER` | `openai-compatible` | `openai-compatible` \| `bedrock` | AI transport. Set `bedrock` only for Amazon Bedrock. |
| `HORIZON_AI_MODEL` | (none) | string | Model id (for `bedrock`, the Bedrock model / inference-profile id). |
| `HORIZON_AI_BASE_URL` | (none) | url | OpenAI-compatible endpoint URL. |
| `HORIZON_AI_REGION` | (none) | string | AWS region for `bedrock`; blank → `AWS_REGION` / `AWS_DEFAULT_REGION`. |
| `HORIZON_AI_API_KEY` | (none) | string | **Secret.** Provider API key (for `bedrock`, the bearer key). Redacted from logs. |
| `HORIZON_AI_SYSTEM_PROMPT` | (none) | string | Override the bundled system prompt; blank keeps the default. |
| `HORIZON_AI_STARTERS` | (built-in) | JSON | Override the starter example chips, e.g. `["What is failing right now?"]`. |
| `HORIZON_AI_HISTORY_MAX_MB` | `500` | int | Per-user browser-side (IndexedDB) chat-history cap. |
| `HORIZON_PERFORMANCE` | (built-in) | JSON | BFF→OAP fan-out + caps, e.g. `{"bulk":{"dashboard":{"bulkSize":8}}}`. |

Server bind, static dir, the `HORIZON_*_FILE` state paths, and `HORIZON_SOURCEMAPS_DIR` are in the table above this section (the image already sets them to container-appropriate values).

A minimal env-only run against a real OAP with one admin user:

```bash
docker run --rm -p 8081:8081 \
  -e HORIZON_OAP_QUERY_URL=http://oap:12800 \
  -e HORIZON_OAP_ADMIN_URL=http://oap:17128 \
  -e HORIZON_AUTH_LOCAL_USERS='[{"username":"admin","passwordHash":"'"$(…cli:hash…)"'","roles":["admin"]}]' \
  ghcr.io/apache/skywalking-horizon-ui:<version>
```

To run standalone on the bundled templates (without Horizon's OAP 11 `/ui-management/templates*` REST dependency), add `-e HORIZON_TEMPLATES_MODE=readonly` — dashboards render from the local bundle and the config surface is read-only (the OAP query host is still required for metrics / traces / logs). OAP 10 has its own legacy GraphQL template API, but Horizon does not consume it.

## Memory & sizing

The BFF holds its **source-map cache in the Node heap** — uploaded Browser-Logs maps live in process memory, not in OAP — so the container's memory limit and Node's heap limit must be sized together with the source-map budget.

- Set **`NODE_OPTIONS=--max-old-space-size=<MB>`** to match the container memory limit (leave headroom for the rest of the process — a value somewhat below the container limit, e.g. `1536` for a 2 GiB container). `--max-old-space-size` is a **process flag read by V8 before any config loads**, so it is **not** a `horizon.yaml` field — pass it via `NODE_OPTIONS` (env), not in the YAML.
- Size **`sourceMaps.maxTotalBytes`** to fit comfortably inside that heap. A few recently-resolved maps are also kept *parsed* (larger than the raw file), so budget roughly 2× headroom above `maxTotalBytes`. Mounted (static) maps are disk-backed and don't count against the heap. See [Browser Logs & Source Maps](../operate/browser-source-maps.md).

```sh
docker run -d --name horizon \
  -p 8081:8081 \
  -e NODE_OPTIONS=--max-old-space-size=1536 \
  -v "$PWD/horizon.yaml:/app/horizon.yaml:ro" \
  ghcr.io/apache/skywalking-horizon-ui:0.7.0
```

## How to load `horizon.yaml` into the container

Three common approaches.

### 1. Bind-mount from the host

Simplest for single-host deployments. Mount your `horizon.yaml` at `/app/horizon.yaml`:

```sh
docker run -d \
  --name horizon \
  -p 8081:8081 \
  -v "$PWD/horizon.yaml:/app/horizon.yaml:ro" \
  ghcr.io/apache/skywalking-horizon-ui:0.7.0
```

Notes:

- `:ro` — read-only mount. The BFF only reads the file; preventing writes catches mistakes.
- If your YAML sets `server.host`, use `0.0.0.0` in containers. `127.0.0.1` binds container loopback only, so `-p 8081:8081` cannot reach it.

### 2. Bake it in (custom image)

For immutable single-tenant deployments, build a child image that includes your config:

```dockerfile
FROM ghcr.io/apache/skywalking-horizon-ui:0.7.0
COPY horizon.yaml /app/horizon.yaml
```

Pros: one artifact contains both code and config. Cons: rebuild on every config change; secrets baked into image layers.

If you bake it in, do **not** include secrets directly. Use `${ENV_VAR}` interpolation in the YAML (see [`horizon.yaml` Reference](horizon-yaml.md#environment-variable-interpolation)) and pass the actual secrets via env at run time.

### 3. Kubernetes ConfigMap + Secret

Standard pattern for Kubernetes deployments. The non-secret YAML goes in a ConfigMap; secrets stay in Secret resources and are injected as env vars.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: horizon-config
data:
  horizon.yaml: |
    server:
      host: 0.0.0.0
      port: 8081
    oap:
      queryUrl: http://oap.skywalking:12800
      adminUrl: http://oap.skywalking:17128
      auth:
        username: skywalking
        password: "${HORIZON_OAP_PW}"
    auth:
      backend: local
      local:
        users:
          - username: admin
            passwordHash: "${HORIZON_ADMIN_HASH}"
            roles: [admin]
    rbac:
      enabled: true
    session:
      cookieSecure: true
---
apiVersion: v1
kind: Secret
metadata:
  name: horizon-secrets
type: Opaque
stringData:
  HORIZON_OAP_PW: "..."
  HORIZON_ADMIN_HASH: "$argon2id$v=19$..."
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: horizon
spec:
  replicas: 1
  selector:
    matchLabels: { app: horizon }
  template:
    metadata:
      labels: { app: horizon }
    spec:
      securityContext:
        # The image's `horizon` user is created by `adduser -S`, which
        # picks a system UID. `fsGroup` makes the mounted volumes
        # group-writable by that user without a chown sidecar.
        fsGroup: 101
      containers:
        - name: horizon
          image: ghcr.io/apache/skywalking-horizon-ui:0.7.0
          ports:
            - containerPort: 8081
          envFrom:
            - secretRef: { name: horizon-secrets }
          env:
            - name: HORIZON_CONFIG
              value: /etc/horizon/horizon.yaml
          volumeMounts:
            - name: config
              mountPath: /etc/horizon
              readOnly: true
            - name: state
              mountPath: /data
          readinessProbe:
            httpGet: { path: /api/health, port: 8081 }
            periodSeconds: 10
      volumes:
        - name: config
          configMap:
            name: horizon-config
            items: [{ key: horizon.yaml, path: horizon.yaml }]
        - name: state
          persistentVolumeClaim:
            claimName: horizon-state
```

Notes:

- Mount the ConfigMap as a directory, not a `subPath`, so Kubernetes can project updates. `HORIZON_CONFIG` points the BFF at the projected file without shadowing `/app`.
- Mount with `readOnly: true` on the config — the BFF only reads it.
- Updates to the ConfigMap reach hot-reloadable settings after Kubernetes refreshes the projected volume. Settings documented as restart-required still need a pod restart.
- Values supplied through `envFrom` are fixed when the container starts. After changing `horizon-secrets`, restart or roll out the pods; updating the Secret does not change an existing process's environment.
- `/data` is the image's declared `VOLUME` for runtime state (the wire debug log). The `HORIZON_WIRE_LOG_FILE` env var baked into the image points at `/data/`, so mounting a PVC here is enough — no path override in `horizon.yaml` is required.
- `fsGroup: 101` is the typical alpine `nobody` GID that `adduser -S -G horizon horizon` falls into. Run `docker run --rm <image> id horizon` to confirm if you've forked the image.
- Run a single replica unless you accept that sessions are per-pod (the in-memory session store does not federate; see [session](session.md)).

### Persisting the wire debug log

The BFF writes the wire debug log as JSON Lines when `debugLog.enabled` is set. The image declares `/data` as a `VOLUME` and points the default at `/data/` via an env var, so **no `horizon.yaml` configuration is required** to get a writable, persistable path — operators just mount a volume at `/data`:

```sh
docker run -d --name horizon \
  -p 8081:8081 \
  -v "$PWD/horizon.yaml:/app/horizon.yaml:ro" \
  -v horizon-state:/data \
  ghcr.io/apache/skywalking-horizon-ui:0.7.0
```

Without a mounted volume the writes still land in the container's writable layer at `/data/` (ephemeral, but at least non-failing). Mounting a volume is what makes them durable.

If you want to override the location, you can either:

- Set the env var: `-e HORIZON_WIRE_LOG_FILE=/var/log/horizon/wire.jsonl`, or
- Set the path explicitly in `horizon.yaml`:

  ```yaml
  debugLog: { file: /var/log/horizon/wire.jsonl }
  ```

In either case the target directory must be writable by the `horizon` user. Storage classes that enforce ownership need `fsGroup` set in Kubernetes (or `chown` on bind mounts) to match the `horizon` UID/GID inside the container.

### Where admin-edited templates live

Admin template edits (Layer-Templates, Overview-Templates, translations) are **stored in OAP's `ui_template` store**, not inside the Horizon container — persistence follows your OAP storage backend, and nothing needs to be mounted or copied to keep them. Replacing or upgrading the Horizon container never loses admin edits.

`/app/bundled_templates/` is the **read-only seed source**: in the default `templates.mode: live`, Horizon seeds any bundled template that is missing from OAP into the `ui_template` store at boot; in `templates.mode: readonly`, dashboards render directly from this bundle and the template admin surface is read-only. Nothing writes into the directory at runtime, so bind-mounting it persists nothing — mount it only if you want to **replace the bundle itself** (custom seed templates, or a custom read-only set for `readonly` mode). See [`horizon.yaml` Reference → Template source mode](horizon-yaml.md#template-source-mode).

## Logging

The BFF uses [pino](https://github.com/pinojs/pino) and writes **structured JSON** to **stdout** in production — visible via `docker logs <container>` and ready for any log aggregator (Fluent Bit, Vector, Promtail, Filebeat, Datadog) without extra parsers.

| Mode | How to enter | Output |
|---|---|---|
| Production | The image sets `NODE_ENV=production`. Anything that isn't explicitly `NODE_ENV=development` is treated as production — including the local binary `node dist/server.js`. | One JSON object per line on stdout. **Default level `warn`** — quiet by default; only warnings, errors, and fatals reach stdout. Fields: `level`, `time`, `pid`, `hostname`, plus per-event keys (`reqId`, `req`, `res`, `responseTime`, `msg`, …). |
| Development | `pnpm --filter bff dev` (the `dev` script sets `NODE_ENV=development` explicitly). | Pretty-printed, colorized, with timestamps via `pino-pretty`. **Default level `debug`** — full lifecycle chatter + per-request access logs. Human-readable. |

Adjust the floor with `LOG_LEVEL` when triaging:

```sh
docker run -e LOG_LEVEL=info ...    # louder: add per-request access logs + lifecycle
docker run -e LOG_LEVEL=debug ...   # louder still: add the loader / capability-probe chatter
docker run -e LOG_LEVEL=trace ...   # every pino-instrumented site
docker run -e LOG_LEVEL=error ...   # quieter than the default: silences warnings
NODE_ENV=production LOG_LEVEL=info node dist/server.js
```

The default floor is `warn` (not `error`) because misconfiguration and security signals — break-glass logins, LDAP failures, rejected config hot-reloads — are emitted at `warn`, and operators are told to alert on them. Dropping to `LOG_LEVEL=error` silences all of those.

### Per-request logging

The server request logger is on by default and emits one `incoming request` line + one `request completed` line per HTTP request, both tagged with a stable `reqId`. These are level-`info` (30) events — **suppressed under the production default `warn`**. Bump to `LOG_LEVEL=info` to surface them; example pair under that level:

```json
{"level":30,"time":1779109372598,"pid":1,"hostname":"...","reqId":"req-1","req":{"method":"GET","url":"/api/auth/health","host":"127.0.0.1:8081","remoteAddress":"192.168.65.1","remotePort":60655},"msg":"incoming request"}
{"level":30,"time":1779109372614,"pid":1,"hostname":"...","reqId":"req-1","res":{"statusCode":200},"responseTime":14.93,"msg":"request completed"}
```

Genuine request errors (5xx, request-handler exceptions) are still logged at `error` (50) — they reach stdout under any default that includes `error`.

This is separate from the **wire-debug log** (which records OAP HTTP request/response payloads when `debugLog.enabled: true`; see [Setup → debugLog](debug-log.md)). Two orthogonal channels:

| Channel | Where | What | Toggle |
|---|---|---|---|
| App logs | stdout (JSON in prod, pretty in dev) | Lifecycle + per-request, plus sign-ins (`info`), refused sign-ins and break-glass use (`warn`) | Always on. `LOG_LEVEL` adjusts — the default hides the successes. |
| Wire-debug | `debugLog.file` (JSONL) | Outbound OAP requests/responses | Off by default. `debugLog.enabled: true` opt-in. |

### Aggregating from Docker

```sh
# Quick tail with severity color (jq):
docker logs -f horizon-test | jq -c '. | "\(.time|todate) [\(.level)] \(.msg)"' -r

# Just request failures:
docker logs -f horizon-test | jq -c 'select(.res.statusCode >= 400)'

# Just structured slowness:
docker logs -f horizon-test | jq -c 'select(.responseTime != null and .responseTime > 200)'
```

For Kubernetes, the standard pipelines (fluent-bit `tail` plugin with `Parser json`, or vector `kubernetes_logs` → `parse_json`) ingest these lines directly. No app-side configuration required.

## Network

- Container exposes **8081** by default. If you change `server.port`, publish the new port and update the readiness probe.
- The BFF needs **egress** to:
  - OAP query port (default 12800).
  - OAP admin port (default 17128).
  - OAP Zipkin port (default 9412) if any layer uses `traces.source: zipkin` or `both`.
  - LDAP server (default 636 / 389) if `auth.backend: ldap`.

See [Network Ports](../compatibility/ports.md) for the full port matrix.

## Multi-arch

The image is built for both `linux/amd64` and `linux/arm64`. Docker auto-selects the right architecture on `pull`. For Apple Silicon dev hosts, the arm64 image runs natively (no emulation).

## TLS

The image does **not** terminate TLS. Always run behind a TLS terminator (Kubernetes Ingress, Nginx, Envoy, a cloud LB). Once TLS is in front:

```yaml
session:
  cookieSecure: true
```

so session cookies are flagged `Secure` and the browser refuses to send them over plain HTTP.

## Building locally

The image is a multi-stage build: it compiles the app from source inside the build stage, so there is no host pre-step — `docker build` is self-contained (it only needs network for `pnpm install` during the build).

Single-arch dev build:

```sh
docker build -t horizon:local .
docker run --rm -it -p 8081:8081 \
  -v "$PWD/horizon.yaml:/app/horizon.yaml:ro" \
  horizon:local
```

Multi-arch build (same shape as CI — needs a `docker-container` buildx builder and QEMU for the non-native arch):

```sh
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t horizon:local \
  .
```

## Health probes

Wire your platform's readiness probe to one of:

| Endpoint | What it verifies |
|---|---|
| `GET /api/health` | **Recommended.** Public, unauthenticated, no OAP dependency — returns `{ status: "ok", version }` as soon as the BFF process is serving. Use this for both readiness and liveness. |
| `GET /api/auth/health` | BFF is up + auth backend is healthy. Public. Useful if you want readiness to fold in auth-backend health. |
| TCP probe on 8081 | BFF process is listening. Loosest — does not verify HTTP serving. |

Do **not** point a probe at `GET /api/oap/info`: it is authenticated, so an unauthenticated probe gets HTTP 401 and the pod never becomes Ready. It is an in-app, authenticated OAP-reachability indicator, not a probe target.

Liveness probes should use the public `GET /api/health` (or TCP-only on 8081). Wiring OAP reachability into liveness creates a cascade failure when OAP blips.

## Common mistakes

- **`server.host: 127.0.0.1` inside the container.** Listener binds loopback only; `-p` cannot route traffic in. Set `0.0.0.0`.
- **Mounting `horizon.yaml` as a directory.** `docker run -v "$PWD:/app/horizon.yaml"` mounts the whole working directory and shadows `/app`. Always mount the **file** path, not the directory.
- **State files lost on container replacement.** The image's defaults route state files to `/data/`, which is declared as a `VOLUME` but is ephemeral unless you bind / mount-PVC it. Mount a durable volume at `/data` (or override the paths via `HORIZON_*_FILE` env vars).
- **Mounting `/app/bundled_templates` to "persist" admin edits.** Admin template edits live in OAP's `ui_template` store, not in the container — the mount persists nothing. The directory is only the read-only seed / `readonly`-mode source; mount it only to replace the bundle itself.
- **Secrets in baked config.** Use `${ENV_VAR}` interpolation and pass actual secrets via env. Anything in a built image layer is recoverable by anyone who pulls the image.
- **Pinning `latest` in production.** `latest` moves silently; an automatic `pull` rolls you onto a new version without notice. Pin a SHA.
- **Multi-replica without sticky sessions.** Sessions are in-memory per BFF process. Multi-replica without sticky routing breaks logins on every other request.
