# Setup Quick Start

This page is the shortest path from "no Horizon" to "Horizon in front of a running OAP". It uses the released binary layout first. For containerized deployments, use [Container Image](container-image.md).

## Prerequisites

- Apache SkyWalking **OAP 11.x** (native). OAP 10.x runs the data-plane stack (dashboards, traces, logs, topology, alarms, profiling) but the entire admin port — Inspect, DSL Management, Live Debugger, Alarm Rule editor, Cluster Status → Admin pane, and OAP UI-template sync — is v11-only. See [Compatibility → OAP Version](../compatibility/oap-version.md) for the feature-vs-version matrix.
- Network reachability from the Horizon BFF to the OAP query port (`:12800`) and admin port (`:17128`). See [Network Ports](../compatibility/ports.md).
- Node.js 20+ for the binary tarball. Source builds also need pnpm 10+.

## Five-step start

### 1. Unpack Horizon

Unpack the binary tarball (substitute the release version you downloaded for `<version>`) and copy the example config:

```sh
tar -xzf apache-skywalking-horizon-ui-<version>-bin.tar.gz
cd apache-skywalking-horizon-ui-<version>-bin
cp horizon.example.yaml horizon.yaml
```

The binary is self-contained: `server.js`, `node_modules/`, `static/`, and bundled templates are already present. There is no `pnpm install` step.

### 2. Point Horizon at OAP

Edit the `oap` block:

```yaml
oap:
  queryUrl: http://<oap-host>:12800
  adminUrl: http://<oap-host>:17128
  zipkinUrl: http://<oap-host>:9412/zipkin   # only if using Zipkin
```

If OAP requires basic auth (the public demo does):

```yaml
oap:
  auth:
    username: skywalking
    password: skywalking
```

### 3. Add at least one local user

With no users configured, Horizon starts but no login can succeed. Generate an Argon2id hash with the source checkout helper or any Argon2id-capable password tool:

```sh
pnpm --filter bff cli:hash
```

Paste the hash into `auth.local.users`:

```yaml
auth:
  backend: local
  local:
    users:
      - username: admin
        passwordHash: "$argon2id$v=19$..."
        roles: [admin]
```

For LDAP setup instead, see [Access Control → LDAP Backend](../access-control/ldap-backend.md).

### 4. Start the BFF

From inside the unpacked binary directory:

```sh
HORIZON_CONFIG=./horizon.yaml HORIZON_STATIC_DIR=./static node server.js
```

Horizon defaults to `127.0.0.1:8081`. For production, bind to `0.0.0.0` and put TLS termination in front:

```yaml
server:
  host: 0.0.0.0
  port: 8081
session:
  cookieSecure: true
```

### 5. Open the UI

Browse to `http://<bff-host>:8081/`. Log in with the user you created. The first thing to check is the **Cluster Status** page (`/operate/cluster`):

- Query pane should be green — version, timezone, health score visible.
- Admin pane should be green if you set `SW_ADMIN_SERVER=default` and the rest of the selectors on OAP.

If either pane is red or yellow, see [Cluster Status Check Sequence](../compatibility/cluster-status.md) for triage.

## Container start

For Docker or Kubernetes, mount the same `horizon.yaml` and `/data` state volume:

```sh
docker run -d --name horizon \
  -p 8081:8081 \
  -v "$PWD/horizon.yaml:/app/horizon.yaml:ro" \
  -v horizon-state:/data \
  ghcr.io/apache/skywalking-horizon-ui:<version>
```

See [Container Image](container-image.md) for image tags, Kubernetes YAML, log handling, and probes.

## Source build

Use source builds when you are developing Horizon itself:

```sh
pnpm install
pnpm package
HORIZON_CONFIG=./horizon.yaml HORIZON_STATIC_DIR=./dist/static node dist/server.js
```

## Production checklist

- [ ] `server.host: 0.0.0.0` and TLS terminator in front.
- [ ] `session.cookieSecure: true`.
- [ ] `auth.local.users` empty in production (use LDAP) **or** all passwords are strong + hashes never in version control.
- [ ] `audit.file` writes to durable storage (not a container tmpfs).
- [ ] `debugLog.enabled: false` (or rotate aggressively).
- [ ] OAP credentials, LDAP bind password, and break-glass hash use `${ENV_VAR}` interpolation, not literal values.
- [ ] Container readiness probe wired to `GET /api/oap/info` (or accept that the UI surfaces unreachable as a banner).

## Hot reload

`horizon.yaml` is watched. Most changes apply without restarting the BFF:

- Auth backend switch: applies on next login.
- RBAC role redefinition: applies on next route call.
- OAP URL change: applies on next outbound call.

Two changes still require a BFF restart:

- `server.host` / `server.port` (the listener has already bound).
- Anything that changes the capability cache — flipping a feature on the OAP side that Horizon probes only at BFF startup.

## Where things go

| Artifact | Path (default) | Override |
|---|---|---|
| Config | `./horizon.yaml` | `HORIZON_CONFIG=` |
| Audit log | `./horizon-audit.jsonl` | `audit.file` |
| Setup state | `./horizon-setup.json` | `setup.file` |
| Alarm rules | `./horizon-alarms.json` | `alarms.file` |
| Wire debug log | `./horizon-wire.jsonl` | `debugLog.file` |
| Bundled overview / layer templates | inside the BFF bundle | not user-editable as files; edit via admin pages |

All paths are resolved relative to the BFF working directory.
