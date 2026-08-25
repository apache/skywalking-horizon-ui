# Setup Quick Start

This page is the shortest path from "no Horizon" to "Horizon in front of a running OAP". It uses the released binary layout first. For containerized deployments, use [Container Image](container-image.md).

## Prerequisites

- Apache SkyWalking **OAP 11.x** (native). OAP 10.x runs the data-plane stack **only with `templates.mode: readonly`**, and subject to minor-specific trace and endpoint limitations. OAP 10 does have persistent UI-template management through legacy query-port GraphQL, but Horizon implements only OAP 11's `/ui-management/templates*` REST protocol; the default `live` mode therefore cannot read the v10 template store, and rather than render a layer whose published template it cannot read, it blocks layer-driven pages (most visibly Traces) behind the template-store banner. The admin-port features — Inspect, DSL Management, Live Debugger, Alarm Rule editor, and Cluster Status → Admin pane — are v11-only. See [Compatibility → OAP Version](../compatibility/oap-version.md) for the exact feature matrix and v10 recipe.
- Network reachability from the Horizon BFF to the OAP query port (`:12800`). The admin port (`:17128`) is additionally required for OAP 11 admin features and live template mode, but not for OAP 10 readonly operation. See [Network Ports](../compatibility/ports.md).
- A recent LTS Node.js runtime for the binary tarball. Source builds also need pnpm (pinned via Corepack).

## Five-step start

### 1. Unpack Horizon

Unpack the binary tarball (substitute the release version you downloaded for `<version>`):

```sh
tar -xzf apache-skywalking-horizon-ui-<version>-bin.tar.gz
cd apache-skywalking-horizon-ui-<version>-bin
```

The binary is self-contained: `server.js`, `node_modules/`, `static/`, bundled templates, and the config `horizon.yaml` are already present. There is no `pnpm install` step. `horizon.yaml` is **env-driven** — every field is a `${HORIZON_…:default}` variable, so you can leave the file as-is and set only the environment variables you need (starting with your OAP address), or edit the file directly.

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
HORIZON_CONFIG=./horizon.yaml node server.js
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
HORIZON_CONFIG=./horizon.yaml node dist/server.js
```

## Production checklist

- [ ] `server.host: 0.0.0.0` and TLS terminator in front.
- [ ] `session.cookieSecure: true`.
- [ ] `auth.local.users` empty in production (use LDAP) **or** all passwords are strong + hashes never in version control.
- [ ] `debugLog.enabled: false` (or rotate aggressively).
- [ ] OAP credentials, LDAP bind password, and break-glass hash use `${ENV_VAR}` interpolation, not literal values.
- [ ] Container readiness probe wired to the public `GET /api/health` (not `/api/oap/info`, which is authenticated and returns 401 to an unauthenticated probe).

## Hot reload

`horizon.yaml` is watched. Most changes apply without restarting the BFF:

- Auth backend switch: applies on next login.
- RBAC role redefinition: applies on next route call.
- OAP URL change: the BFF uses the new address on its next outbound call. Lists already on screen can lag up to a minute, because the browser caches services and layers it fetched earlier — reload the page to see the new deployment immediately.

Some changes still require a BFF restart:

- `server.host` / `server.port` (the listener has already bound).
- `templates.mode` (the template source is chosen at boot).
- Anything that changes the capability cache — flipping a feature on the OAP side that Horizon probes once per process.

An edit that fails validation does not apply — the BFF logs an error naming each failing field and keeps serving the previous valid config. See [`horizon.yaml` Reference → Hot reload behavior](horizon-yaml.md#hot-reload-behavior) for the full list of live vs. restart-required fields.

## Where things go

| Artifact | Path (default) | Override |
|---|---|---|
| Config | `./horizon.yaml` | `HORIZON_CONFIG=` |
| Wire debug log | `./horizon-wire.jsonl` | `debugLog.file` |
| Bundled overview / layer templates | inside the BFF bundle | not user-editable as files; edit via admin pages (edits are stored in OAP's `ui_template` store) |

All paths are resolved relative to the BFF working directory.
