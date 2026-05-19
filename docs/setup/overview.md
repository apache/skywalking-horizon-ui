# Setup Quick Start

This page is the smallest possible path from "no Horizon" to "Horizon in front of a running OAP". For per-section field reference, see the rest of the **Setup** chapter. For a containerized deployment, see [Container Image](container-image.md) instead — it covers image tags, env vars, volume mounts, and a Kubernetes example.

## Prerequisites

- Apache SkyWalking **OAP 11.x** (native). OAP 10.x runs the data-plane stack (dashboards, traces, logs, topology, alarms, profiling) but the entire admin port — Inspect, DSL Management, Live Debugger, Alarm Rule editor, Cluster Status → Admin pane, and OAP UI-template sync — is v11-only. See [Compatibility → OAP Version](../compatibility/oap-version.md) for the feature-vs-version matrix.
- Network reachability from the Horizon BFF to the OAP query port (`:12800`) and admin port (`:17128`). See [Network Ports](../compatibility/ports.md).
- Node.js 20+, pnpm 10+ (for source builds; pinned via Corepack). A pre-built artifact only needs Node.js.

## Five-step start

### 1. Place `horizon.yaml` next to the BFF

Copy `horizon.example.yaml` (in the repo root) to `horizon.yaml` in your working directory. The BFF looks for `./horizon.yaml` by default; override with `HORIZON_CONFIG=/path/to/file`.

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

With no users configured, the BFF boots so the login page can show the setup-required state, but no login can succeed. Generate an argon2 hash:

```sh
pnpm --filter bff cli:hash
# prompts for the password, prints the hash
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

```sh
pnpm --filter bff dev
# or, for a built artifact:
node apps/bff/dist/server.js
```

The BFF defaults to `127.0.0.1:8081`. For production, bind to `0.0.0.0` and put TLS termination in front:

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
