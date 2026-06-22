# Container Image

Horizon UI ships a single multi-arch container image (linux/amd64 + linux/arm64). The image bundles both the BFF and the built UI — there is no separate frontend container.

## Where to get it

Registry: **GitHub Container Registry (GHCR)** at `ghcr.io/apache/skywalking-horizon-ui`.

| Tag | Points at | Use case |
|---|---|---|
| `<40-char-sha>` | Exact commit. Immutable. | **Production.** Pin to a SHA so deploys are reproducible. |
| `X.Y.Z` | Tagged release, produced from git tag `vX.Y.Z`. | Stable release. Same image as the SHA it was built from. |
| `X.Y` | Latest patch on a minor line. Moves over time. | Track a minor release line. |
| `latest` | Newest git `vX.Y.Z` tag. Moves. | Demos / dev only — do not pin production to `latest`. |
| `main` | Head of `main`. Moves on every merge. | Smoke-test the development branch. |

```sh
docker pull ghcr.io/apache/skywalking-horizon-ui:0.7.0
docker pull ghcr.io/apache/skywalking-horizon-ui:<sha>
```

The full commit SHA is the canonical, immutable identifier. Moving tags are conveniences that point at the same SHA-built image.

## Image layout

| Path inside the container | Owner | Writable by `horizon`? | What it is |
|---|---|---|---|
| `/app/server.js` | root | no | Compiled BFF entry point. `CMD` runs `node server.js`. |
| `/app/node_modules/` | root | no | Production npm dependencies. |
| `/app/static/` | root | no | Built UI assets (Vite `dist/`). |
| `/app/horizon.example.yaml` | root | no | Example config — **read-only reference**, copy from it. |
| `/app/horizon.yaml` | n/a | n/a | Where the BFF expects the **active** config. **Not present in the image** — provide via mount or `COPY` (see below). |
| `/app/bundled_templates/` | **horizon** | **yes** | Layer + overview JSON templates. Owned by `horizon` because the admin **Layer-Templates** and **Overview-Templates** editors write into per-key files here. |
| `/data/` | **horizon** | **yes** | Declared `VOLUME`. Default destination for the audit log, setup state, alarm state, and wire debug log. Mount a PVC / named volume / host bind here for durable storage. |
| `/app/sourcemaps/` | **horizon** | (read) | Static source maps for the **Browser Logs** tab. Bind-mount or copy `.map` files here and they're loaded at boot — durable across restarts. Optional; runtime uploads work without it. See [Browser Logs & Source Maps](../operate/browser-source-maps.md). |

The runtime stage runs as the non-root user `horizon`. Two locations are owned by `horizon` so writes work without operator intervention: `bundled_templates/` (so the admin editors save) and `/data/` (so state files land somewhere durable).

## Environment variables

| Variable | Default in image | Purpose |
|---|---|---|
| `NODE_ENV` | `production` | Drives the logger format (JSON vs pretty) and Node optimizations. |
| `LOG_LEVEL` | (unset → `error` in production, `debug` in dev) | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |
| `HORIZON_CONFIG` | `/app/horizon.yaml` | Where the BFF looks for `horizon.yaml`. Override to mount elsewhere. |
| `HORIZON_STATIC_DIR` | `/app/static` | Where the BFF serves UI assets from. |
| `HORIZON_AUDIT_FILE` | `/data/horizon-audit.jsonl` | Default for `audit.file` when `horizon.yaml` doesn't override it. |
| `HORIZON_SETUP_FILE` | `/data/horizon-setup.json` | Default for `setup.file`. |
| `HORIZON_ALARMS_FILE` | `/data/horizon-alarms.json` | Default for `alarms.file`. |
| `HORIZON_WIRE_LOG_FILE` | `/data/horizon-wire.jsonl` | Default for `debugLog.file`. |
| `HORIZON_SOURCEMAPS_DIR` | `/app/sourcemaps` | Default for `sourceMaps.bootMountDir` — the directory scanned at boot for statically-provisioned `.map` files. See [Browser Logs & Source Maps](../operate/browser-source-maps.md). |

The four `HORIZON_*_FILE` env vars seed the **defaults** the config schema uses when `horizon.yaml` doesn't supply a value. An explicit value in `horizon.yaml` always wins. The intent: an operator who runs the published image with only a minimal `horizon.yaml` (no `audit/setup/alarms/debugLog` blocks) gets state files routed to `/data/` automatically, no manual path overrides needed.

`server.host` and `server.port` come from the YAML when present. If they are omitted, the image supplies defaults via `HORIZON_SERVER_HOST=0.0.0.0` and `HORIZON_SERVER_PORT=8081`. The image sets `EXPOSE 8081`; if you change `server.port`, also publish the new port.

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
          volumeMounts:
            - name: config
              mountPath: /app/horizon.yaml
              subPath: horizon.yaml
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

- `subPath: horizon.yaml` mounts the single file rather than the directory, so it doesn't shadow `/app`'s other contents.
- Mount with `readOnly: true` on the config — the BFF only reads it.
- `/data` is the image's declared `VOLUME` for runtime state (audit log, setup, alarms, wire debug). The four `HORIZON_*_FILE` env vars baked into the image point at `/data/*`, so mounting a PVC here is enough — no path overrides in `horizon.yaml` are required.
- `fsGroup: 101` is the typical alpine `nobody` GID that `adduser -S -G horizon horizon` falls into. Run `docker run --rm <image> id horizon` to confirm if you've forked the image.
- Run a single replica unless you accept that sessions are per-pod (the in-memory session store does not federate; see [session](session.md)).

### Persisting state files (`audit`, `setup`, `alarms`, `debugLog`)

The BFF writes runtime state to JSON Lines / JSON files. The image declares `/data` as a `VOLUME` and points the four defaults at `/data/*` via env vars, so **no `horizon.yaml` configuration is required** to get writable, persistable paths — operators just mount a volume at `/data`:

```sh
docker run -d --name horizon \
  -p 8081:8081 \
  -v "$PWD/horizon.yaml:/app/horizon.yaml:ro" \
  -v horizon-state:/data \
  ghcr.io/apache/skywalking-horizon-ui:0.7.0
```

Without a mounted volume the writes still land in the container's writable layer at `/data/` (ephemeral, but at least non-failing). Mounting a volume is what makes them durable.

If you want to override the locations, you can either:

- Set the env vars: `-e HORIZON_AUDIT_FILE=/var/log/horizon/audit.jsonl ...`, or
- Set the paths explicitly in `horizon.yaml`:

  ```yaml
  audit:    { file: /var/log/horizon/audit.jsonl }
  setup:    { file: /var/lib/horizon/setup.json }
  alarms:   { file: /var/lib/horizon/alarms.json }
  debugLog: { file: /var/log/horizon/wire.jsonl }
  ```

In either case the target directory must be writable by the `horizon` user. Storage classes that enforce ownership need `fsGroup` set in Kubernetes (or `chown` on bind mounts) to match the `horizon` UID/GID inside the container.

### Persisting admin-edited templates

The Layer-Templates and Overview-Templates admin editors write into `/app/bundled_templates/`. The image's `bundled_templates/` directory is owned by the `horizon` user so saves work out of the box — but it is **inside the image layer**, meaning admin edits are lost on container replacement.

To persist admin-edited templates across container restarts / image updates:

1. Copy the bundled templates out of the image once: `docker cp <container>:/app/bundled_templates ./bundled_templates`.
2. Mount that directory back in: `-v "$PWD/bundled_templates:/app/bundled_templates"`.

The mounted directory must be writable by the `horizon` user (UID/GID inside the container — check with `docker run --rm <image> id horizon`). Without persistence, admin edits behave as ephemeral overrides — useful for try-it-out, destructive for production.

## Logging

The BFF uses [pino](https://github.com/pinojs/pino) and writes **structured JSON** to **stdout** in production — visible via `docker logs <container>` and ready for any log aggregator (Fluent Bit, Vector, Promtail, Filebeat, Datadog) without extra parsers.

| Mode | How to enter | Output |
|---|---|---|
| Production | The image sets `NODE_ENV=production`. Anything that isn't explicitly `NODE_ENV=development` is treated as production — including the local binary `node dist/server.js`. | One JSON object per line on stdout. **Default level `error`** — quiet by default; only warnings, errors, and fatals reach stdout. Fields: `level`, `time`, `pid`, `hostname`, plus per-event keys (`reqId`, `req`, `res`, `responseTime`, `msg`, …). |
| Development | `pnpm --filter bff dev` (the `dev` script sets `NODE_ENV=development` explicitly). | Pretty-printed, colorized, with timestamps via `pino-pretty`. **Default level `debug`** — full lifecycle chatter + per-request access logs. Human-readable. |

Adjust the floor with `LOG_LEVEL` when triaging:

```sh
docker run -e LOG_LEVEL=info ...    # add per-request access logs + lifecycle
docker run -e LOG_LEVEL=debug ...   # add the loader / capability-probe chatter
docker run -e LOG_LEVEL=trace ...   # every pino-instrumented site
docker run -e LOG_LEVEL=warn ...    # even quieter than the default
NODE_ENV=production LOG_LEVEL=info node dist/server.js
```

### Per-request logging

The server request logger is on by default and emits one `incoming request` line + one `request completed` line per HTTP request, both tagged with a stable `reqId`. These are level-`info` (30) events — **suppressed under the production default `error`**. Bump to `LOG_LEVEL=info` to surface them; example pair under that level:

```json
{"level":30,"time":1779109372598,"pid":1,"hostname":"...","reqId":"req-1","req":{"method":"GET","url":"/api/auth/health","host":"127.0.0.1:8081","remoteAddress":"192.168.65.1","remotePort":60655},"msg":"incoming request"}
{"level":30,"time":1779109372614,"pid":1,"hostname":"...","reqId":"req-1","res":{"statusCode":200},"responseTime":14.93,"msg":"request completed"}
```

Genuine request errors (5xx, request-handler exceptions) are still logged at `error` (50) — they reach stdout under any default that includes `error`.

This is separate from the **audit log** (which records sensitive operations — login, rule edits, break-glass — to a JSONL file at `audit.file`; see [Access Control → Audit Log](../access-control/audit-log.md)) and the **wire-debug log** (which records OAP HTTP request/response payloads when `debugLog.enabled: true`; see [Setup → debugLog](debug-log.md)). Three orthogonal channels:

| Channel | Where | What | Toggle |
|---|---|---|---|
| App logs | stdout (JSON in prod, pretty in dev) | Lifecycle + per-request | Always on. `LOG_LEVEL` adjusts. |
| Audit log | `audit.file` (JSONL) | Logins, RBAC-gated mutations | Always on. Path = `audit.file`. |
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
- **Forking the image without preserving `/app/bundled_templates` ownership.** The image `chown`s this dir to `horizon` so admin saves work. A naive `COPY --from=base /app /app` in a child image resets ownership to root → admin Layer-Templates / Overview-Templates saves EACCES. Either re-`chown` in your child image, or mount your own writable directory at `/app/bundled_templates`.
- **Secrets in baked config.** Use `${ENV_VAR}` interpolation and pass actual secrets via env. Anything in a built image layer is recoverable by anyone who pulls the image.
- **Pinning `latest` in production.** `latest` moves silently; an automatic `pull` rolls you onto a new version without notice. Pin a SHA.
- **Multi-replica without sticky sessions.** Sessions are in-memory per BFF process. Multi-replica without sticky routing breaks logins on every other request.
