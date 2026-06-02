# RBAC: Roles & Verbs

Horizon enforces access at the BFF on every HTTP request. The UI hides controls based on the verbs the session reports, but the enforcement is server-side — a forged UI cannot escalate. The UI also gates whole pages by verb: navigating to a restricted page you lack the verb for (by URL or a stray link) redirects you home, so a viewer can't land on a maintainer page even if its data comes from a shared endpoint. This page is the full reference for the verb vocabulary, the four built-in roles, and how grants are matched against requests.

## Model

- **Subject**: an authenticated session (`username + roles`).
- **Object**: a protected request.
- **Action (verb)**: a dot-namespaced string each protected request requires.
- **Decision**: granted if any of the user's roles holds a grant that matches the required verb.

Sessions capture the **role list** at login time, and the verbs they grant are resolved from the current `rbac.roles` definitions on each request. Hot-reloading role definitions takes effect immediately; hot-reloading group mappings or local user roles requires the user to re-login (since sessions hold their original role list).

## Verb vocabulary

Known verbs are grouped into areas:

### Data reads (the public catalog)

| Verb | Gates |
|---|---|
| `metrics:read` | Layer dashboards, overview widgets that fetch MQE values. |
| `alarms:read` | Alarms page, alarm widgets on overviews. |
| `traces:read` | Traces tab on any layer, trace detail page. |
| `logs:read` | Logs tab on any layer, log detail page. |
| `topology:read` | Topology tab, topology widgets on overviews. |
| `profile:read` | Profiling tab (results read-only). |
| `overview:read` | Public overview dashboards. |
| `infra-3d:read` | 3D Infrastructure Map — the map's config + live traffic metrics. |

### Operate — dashboards, rules, diagnostics

| Verb | Gates |
|---|---|
| `overview:write` | Overview templates (`/admin/overview-templates`) and the 3D-map config (`/admin/3d-map`): edit / publish. |
| `dashboard:read` / `dashboard:write` | Layer dashboard templates admin page: list / edit. |
| `alarm-setup:read` / `alarm-setup:write` | Alarm Setup page: list / edit. |
| `alarm-rule:read` / `alarm-rule:write` | Alarm Rule catalog: list / edit. |
| `setup:read` / `setup:write` | Service / instance / endpoint setup pages. |
| `rule:read` | DSL Management — list rules. |
| `rule:write` | DSL Management — content edits (non-structural). |
| `rule:write:structural` | DSL Management — add / remove rules, change rule kind. |
| `rule:delete` | DSL Management — delete a rule. |
| `rule:debug` | DSL Management — debug a rule against sample input. |
| `live-debug:read` / `live-debug:write` | Live Debugger — observe / start sessions. |
| `profile:enable` | Create a profiling task on a layer. |

### Platform monitoring

| Verb | Gates |
|---|---|
| `cluster:read` | Cluster Status page (`/operate/cluster`). |
| `ttl:read` | Data Retention page (`/operate/ttl`). |
| `config:read` | OAP Configuration page (`/operate/config`). |
| `inspect:read` | Metrics Inspect page (`/operate/inspect`). |

### Admin surface

| Verb | Gates |
|---|---|
| `user:read` | Users admin page (`/admin/users`). |
| `user:write` | Reserved (no current write endpoint). |
| `role:read` | Roles & Permissions admin page (`/admin/roles`). |
| `role:write` | Reserved. |
| `auth:read` | Auth Status admin page (`/admin/auth-status`) + LDAP probe. |
| `audit:read` | Reserved (audit log not yet exposed via API). |

### Special

| Verb | Meaning |
|---|---|
| `admin` | Synonym for `*`. Matches anything. |
| `*` | Wildcard. Matches anything. |

## Grant matching

A user's grant string is matched against a required verb using these rules:

| Grant pattern | Matches |
|---|---|
| `*` or `admin` | Any verb. |
| `area:verb` (exact) | The exact required verb (case-sensitive). |
| `area:*` | Any verb in that area, including sub-actions: `rule:*` matches `rule:read`, `rule:write`, `rule:write:structural`, `rule:delete`, `rule:debug`. |
| `*:read` | The `read` action in any area: matches `metrics:read`, `alarms:read`, `cluster:read`, etc. Does **not** match `rule:write:structural` (the action is not `read`). |

Effective verbs for a session are the **union** of all grants from all roles.

## Built-in roles

Default definitions (used when `rbac.roles` is not overridden):

### `viewer`

Read-only data catalog. Deliberately limited — does not include `*:read` so a viewer cannot peek at rule definitions, live-debug sessions, setup screens, or platform internals.

```
metrics:read, alarms:read, traces:read, logs:read, topology:read, profile:read, overview:read
```

### `maintainer`

Viewer + platform monitoring.

```
viewer baseline + cluster:read, ttl:read, config:read, inspect:read
```

### `operator`

Configures observability. Inherits maintainer's reads + write access to dashboards, alarms, rules, live-debug, profiling.

```
maintainer baseline +
overview:read, overview:write,
setup:read, setup:write,
dashboard:read, dashboard:write,
alarm-setup:read, alarm-setup:write,
alarm-rule:read, alarm-rule:write,
rule:read, rule:write, rule:write:structural, rule:delete, rule:debug,
live-debug:read, live-debug:write,
profile:enable
```

### `admin`

Unrestricted. `"*"`.

## Role assignment

| Backend | Assignment |
|---|---|
| Local | `auth.local.users[].roles: [role1, role2, ...]` in `horizon.yaml`. |
| LDAP | `auth.ldap.groupMappings`: each group DN → one role. A user matching multiple groups gets the union of all matching roles. |

A user with no role gets no verbs. The session is created (login succeeds) but everything is denied. The login response carries an empty verb list; the UI shows "no access" for every protected feature.

## Landing route per role

After login, the user lands on the route configured for their role in `rbac.landingByRole` — unless they were bounced to login from a protected route, in which case they return to where they came from.

Default mapping:

```yaml
landingByRole:
  viewer:     /
  maintainer: /operate/cluster
  operator:   /
  admin:      /operate/cluster
```

When a user has multiple roles, the **first role on the user** wins. Order matters in `auth.local.users[].roles` and in LDAP group-mapping resolution.

## Enforcement

Access is enforced server-side, not in the browser. Every protected request is checked for a valid session (an unauthenticated request is rejected with `401`) and then for the verb that request requires (a session lacking the verb is rejected with `403`). The UI hides controls a session cannot use, but a forged UI cannot bypass these checks.

Enforcement is fail-safe: a request with no explicit verb still requires a valid session, so a misconfiguration cannot accidentally expose a protected endpoint to anonymous callers.

## Disabling RBAC for dev

```yaml
rbac:
  enabled: false
```

Every authenticated session is granted `*`. Useful for local development. **Never set `false` in production.** When disabled, the Admin → Roles page shows a red banner.

## Visualizing the policy

The Admin → Roles page (`/admin/roles`, verb `role:read`) renders a read-only board of roles × verbs with check marks. It pulls live data — what you see is exactly what the BFF will use to evaluate the next request. Use it to verify role changes after editing `horizon.yaml`.

## Common patterns

### Read-only role for a new team

```yaml
roles:
  on-call:
    - metrics:read
    - alarms:read
    - traces:read
    - logs:read
    - topology:read
    - overview:read
    - inspect:read       # so they can browse the catalog
landingByRole:
  on-call: /alarms       # land on the alarm board
```

### Lockdown for an external auditor

```yaml
roles:
  auditor:
    - "*:read"           # all reads only
landingByRole:
  auditor: /operate/cluster
```

`*:read` grants every read — useful for audit access without write capability.

### Separate alarm-tuning role

```yaml
roles:
  alarm-tuner:
    - metrics:read, alarms:read, topology:read, traces:read, logs:read
    - alarm-setup:read, alarm-setup:write
    - alarm-rule:read, alarm-rule:write
    - rule:read, rule:debug
```

Can view operational data and edit alarm rules but cannot touch DSL rule structure or live-debug.
