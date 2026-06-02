# Access Control Configuration

Role-Based Access Control. Defines the role → verb grants and the post-login landing route per role. Full behavior reference (verb vocabulary, grant matching, where each verb gates) is in [Access Control → RBAC: Roles & Verbs](../access-control/rbac.md); this page is the `horizon.yaml` shape.

## Shape

```yaml
rbac:
  enabled: true
  roles:
    viewer:     [metrics:read, alarms:read, traces:read, logs:read, topology:read, profile:read, overview:read]
    maintainer: [metrics:read, alarms:read, traces:read, logs:read, topology:read, profile:read, overview:read, cluster:read, ttl:read, config:read, inspect:read]
    operator:   [metrics:read, ..., rule:*, live-debug:*, profile:enable]
    admin:      ["*"]
  landingByRole:
    viewer: /
    maintainer: /operate/cluster
    operator: /
    admin: /operate/cluster
```

## Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `enabled` | boolean | `true` | no | When `false`, every authenticated session is granted `*` (full access). Useful for dev. **Set `true` in production.** |
| `roles` | object | the four built-ins | no | Custom role definitions. Keys are role names; values are arrays of permission strings. **Omitting this block uses the four built-ins** (`viewer`, `maintainer`, `operator`, `admin`) — see `horizon.example.yaml` for the full grants. Defining the block at all overrides the built-ins entirely; redefine all four if you want to keep them. |
| `landingByRole` | object | see below | no | Post-login redirect route per role. First role on the user wins. |

## Built-in roles (used when `roles` is not set)

| Role | Purpose | Grants |
|---|---|---|
| `viewer` | Read-only data catalog and public overviews. | `metrics:read`, `alarms:read`, `traces:read`, `logs:read`, `topology:read`, `profile:read`, `overview:read`, `infra-3d:read`. Deliberately not `*:read` so the viewer cannot see rule definitions, live-debug sessions, setup screens, or platform internals. |
| `maintainer` | Viewer + platform monitoring. | viewer baseline + `cluster:read`, `ttl:read`, `config:read`, `inspect:read`. |
| `operator` | Configures observability. | maintainer baseline + `overview:write`, `setup:read/write`, `dashboard:read/write`, `alarm-setup:read/write`, `alarm-rule:read/write`, `rule:*` (including `rule:write:structural`, `rule:delete`, `rule:debug`), `live-debug:*`, `profile:enable`. |
| `admin` | Unrestricted. | `*`. |

## Verb grammar

Grants are dot-namespaced strings. Four matching modes:

| Pattern | Meaning |
|---|---|
| `*` or `admin` | Matches any verb (admin). |
| `area:verb` | Exact match: e.g., `rule:write` grants exactly `rule:write`. |
| `area:*` | Matches any verb in that area: `rule:*` grants `rule:read`, `rule:write`, `rule:write:structural`, `rule:delete`, `rule:debug`. |
| `*:read` | Matches the `read` action across any area. |

A user's effective verbs are the **union** of all grants from all their roles.

## `landingByRole`

Default:

```yaml
landingByRole:
  viewer: /
  maintainer: /operate/cluster
  operator: /
  admin: /operate/cluster
```

The login flow returns this route as `landingRoute` in the login response. The UI router uses it as the post-login destination unless a `?redirect=` query param overrides (e.g., the user was bounced to login from a protected route — they return there after auth).

## Common shapes

### Loosen for dev

```yaml
rbac:
  enabled: false   # all authenticated users get full access
```

### Add a custom role

```yaml
rbac:
  enabled: true
  roles:
    viewer:     [...]
    maintainer: [...]
    operator:   [...]
    admin:      ["*"]
    on-call:                          # custom
      - metrics:read
      - alarms:read
      - traces:read
      - logs:read
      - topology:read
      - overview:read
      - inspect:read                  # so they can poke at the catalog
      - live-debug:read               # but not write
  landingByRole:
    on-call: /alarms                  # land directly on the alarm board
```

Custom roles are usable from both backends: assign to local users via `auth.local.users[].roles`, or map LDAP groups via `auth.ldap.groupMappings`.

## Hot reload behavior

Changes to `rbac.roles` and `rbac.landingByRole` apply on the **next route evaluation** — existing sessions pick up new grants without re-login. The session's role list is the authoritative source; the verb set is computed per request from `roles → rbac.roles` at policy check time.

`rbac.enabled: false → true` and vice versa also applies on next request, with no session invalidation.

## Enforcement

Verb checks happen on the BFF, not the UI. The UI hides controls based on the verbs the session reports, but a malicious client cannot escalate by calling the API directly — the BFF re-checks every request. See [Access Control → Admin Pages](../access-control/admin-pages.md) for the **Roles & Permissions** read-only board that visualizes the live policy.
