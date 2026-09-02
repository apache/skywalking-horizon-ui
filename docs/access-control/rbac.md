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
| `events:read` | Events popout on a service banner: that service's lifecycle events. |
| `traces:read` | Traces tab on any layer, trace detail page. |
| `logs:read` | Logs tab on any layer, log detail page. |
| `browser-errors:read` | Browser Logs tab (BROWSER layer): list JS error logs, list source maps, resolve a stack. |
| `inspect:read` | The read-only inspect tools: Metrics Inspect (`/operate/inspect`), Trace Inspect (`/operate/trace-inspect`), Log Inspect (`/operate/log-inspect`). |
| `topology:read` | Topology tab, topology widgets on overviews. |
| `profile:read` | Profiling tab (results read-only) and the continuous-profiling policy list. |
| `overview:read` | Public overview dashboards. Only the rendered pages — the stored templates behind them are gated separately, under Dashboard setup below. |
| `infra-3d:read` | 3D Infrastructure Map — the map's config + live traffic metrics. |
| `ai:read` | [AI assistant](../operate/ai-assistant.md): send a chat message. Grants no data access by itself — each of the assistant's data tools re-checks its own read verb, so the assistant never reads more than the session could. |
| `mcp:read` | Connect an external agent over [MCP](../operate/mcp.md) (`POST /api/mcp`). Grants no data access by itself, for the same reason as `ai:read` — the agent's tools re-check their own read verbs. Kept separate from `ai:read` because the two differ in where the model runs: the assistant sends the conversation to the provider this Horizon is configured with, while MCP leaves the model on the caller's side, so a deployment can reasonably allow one and not the other. |

### Dashboard setup — the six configuration pages

Each page in the sidebar's **Dashboard setup** section has its own read/write pair. The **read** verb decides whether the page's row appears and whether it opens; the **write** verb decides whether it can publish. Holding only the read verb opens the page in **read-only**: the configuration is fully visible, every editing control is disabled, and the banner says which permission publishing needs. Horizon refuses the write server-side either way, so the read verb is safe to grant on its own.

| Verb pair | Page |
|---|---|
| `overview-template:read` / `overview-template:write` | Overview templates (`/admin/overview-templates`). |
| `layer-template:read` / `layer-template:write` | Layer dashboards (`/admin/layer-dashboards`). |
| `translation:read` / `translation:write` | Translations (`/admin/translations`) — the per-locale overlays for any template, whatever kind it translates. `translation:read` also reads the source templates being translated, since the page shows each translation beside the English it replaces; it does not let you change one. A translation may only replace the template's text fields — a title, an alias, a label — never a metric expression, a widget type or a layer key. |
| `alarm-setup:read` / `alarm-setup:write` | Alert page setup (`/admin/alert-page-setup`). |
| `infra-3d-setup:read` / `infra-3d-setup:write` | 3D Infra Map setup (`/admin/3d-map`). Distinct from `infra-3d:read`, which is the map itself. |
| `setup:read` / `setup:write` | Global defaults (`/admin/global-defaults`) — default theme and time window. |

None of these is granted to `viewer` or `maintainer`. Those roles read the dashboards; the stored templates behind them are an operator's to change.

### Operate — dashboards, rules, diagnostics

| Verb | Gates |
|---|---|
| `alarm-rule:read` | Alarm Rule catalog: list (read-only — alarm-rule edits go through the OAP alarm-rule YAML, not this page). |
| `alarm-rule:write` | **Reserved** — OAP's alarm-rule catalog is read-only, so there is no write for Horizon to gate. |
| `rule:read` | DSL Management — list rules, read a rule body, and download a runtime-rule dump. |
| `rule:write` | DSL Management — save a rule whose change is not structural, and inactivate a rule. |
| `rule:write:structural` | DSL Management — save an edit that moves a metric's storage identity (scope, downsampling, single ↔ labeled ↔ histogram), force a re-apply to recover a degraded rule, and revert a rule to its bundled version. |
| `rule:delete` | DSL Management — delete a rule. |
| `live-debug:read` / `live-debug:write` | Live Debugger — watch captures (the page, the active-session list, per-node status, capture history) / start and stop them. These two are the whole of the Live Debugger's access control: `live-debug:read` is enough on its own to watch, `live-debug:write` is enough on its own to start and stop, and no `rule:*` verb takes part. |
| `source-map:write` | Browser Logs — upload / remove source maps (held in BFF memory). |
| `profile:enable` | Create a profiling task on a layer, and arm a continuous-profiling policy. |

### Platform monitoring

| Verb | Gates |
|---|---|
| `cluster:read` | Cluster Status page (`/operate/cluster`). |
| `ttl:read` | Data Retention page (`/operate/ttl`). |
| `config:read` | OAP Configuration page (`/operate/config`). |

### Admin surface

| Verb | Gates |
|---|---|
| `user:read` | Users admin page (`/admin/users`) — the list is read-only; local users are defined in `horizon.yaml`. |
| `user:write` | **Reserved** — the user list has no write. |
| `role:read` | Shows the Roles & Permissions entry and page (`/admin/roles`). The board is drawn from the same status read as the Auth Status page, so grant `auth:read` alongside it or the page opens and reports a load failure. |
| `role:write` | **Reserved** — role definitions are edited in `horizon.yaml`, not from the UI. |
| `auth:read` | Auth Status admin page (`/admin/auth-status`) + LDAP probe. Also the data behind the Roles & Permissions board. |
| `audit:read` | Login audit page (`/admin/audit`) — who signed in, when and from where. **Not granted by any wildcard**: only a bare `*`, the administrator role, or this verb by name. |

### Special

| Verb | Meaning |
|---|---|
| `admin` | Synonym for `*`. Matches anything. Never *required* by a request — it is only ever a grant. |
| `*` | Wildcard. Matches anything. |

### Reserved verbs

Three verbs — `alarm-rule:write`, `user:write`, `role:write` — are part of the vocabulary but **nothing checks them**. Granting one opens nothing and closes nothing. They keep their names so a `horizon.yaml` that already lists one still validates, and so the name stays stable if a capability is ever bound to it.

No built-in role names a reserved verb — `admin`'s `*` matches them like everything else, which still does nothing — and the Roles & Permissions page marks each one on screen rather than presenting it as a capability. If a custom role of yours grants one, you can drop it: it is doing nothing today, and leaving it in means the grant takes effect silently on the day something enforces it.

## Grant matching

A user's grant string is matched against a required verb using these rules:

| Grant pattern | Matches |
|---|---|
| `*` or `admin` | Any verb. |
| `area:verb` (exact) | The exact required verb (case-sensitive). |
| `area:*` | Any verb in that area, including sub-actions: `rule:*` matches `rule:read`, `rule:write`, `rule:write:structural`, `rule:delete`. |
| `*:read` | The `read` action in any area: matches `metrics:read`, `alarms:read`, `cluster:read`, etc. Does **not** match `rule:write:structural` (the action is not `read`), and does **not** match `audit:read` — see below. |

Effective verbs for a session are the **union** of all grants from all roles.

## Built-in roles

Default definitions (used when `rbac.roles` is not overridden):

### `viewer`

Read-only data catalog, the read-only inspect tools, and the AI assistant. Deliberately limited — does not include `*:read` so a viewer cannot peek at rule definitions, live-debug sessions, setup screens, or cluster / TTL / config internals.

```
metrics:read, alarms:read, events:read, traces:read, logs:read, browser-errors:read, inspect:read, topology:read, profile:read, overview:read, infra-3d:read, ai:read, mcp:read
```

### `maintainer`

Viewer + platform monitoring.

```
viewer baseline + cluster:read, ttl:read, config:read
```

### `operator`

Configures observability. Inherits maintainer's reads + write access to dashboards, rules, live-debug, profiling and source maps. Alarm rules stay read-only for every role — see `alarm-rule:write`.

```
maintainer baseline +
source-map:write,
overview-template:read, overview-template:write,
layer-template:read, layer-template:write,
translation:read, translation:write,
alarm-setup:read, alarm-setup:write,
infra-3d-setup:read, infra-3d-setup:write,
setup:read, setup:write,
alarm-rule:read,
rule:read, rule:write, rule:write:structural, rule:delete,
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

The Admin → Roles page (`/admin/roles`, verbs `role:read` + `auth:read`) renders a read-only board of roles × verbs with check marks, grouped by feature area and preceded by a menu-visibility matrix showing which navigation entries each role sees. It pulls live data — what you see is exactly what the BFF will use to evaluate the next request. Use it to verify role changes after editing `horizon.yaml`.

Rows for [reserved verbs](#reserved-verbs) are marked as such. A check mark on a reserved row still reflects the grant a role holds — it just tells you the grant buys nothing.

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
  reviewer:
    - "*:read"           # all reads only
landingByRole:
  reviewer: /operate/cluster
```

`*:read` grants every read except one — useful for review access without write capability.

**One read is not included: `audit:read`.** The login audit log holds who signed in, when, from where, and their verified email addresses, so a wildcard does not reach it. Only a bare `*`, the built-in **administrator** role, or the verb named explicitly grants it:

```yaml
roles:
  reviewer:
    - "*:read"
    - "audit:read"       # named explicitly — a wildcard does not include it
```

The role above is called `reviewer` rather than `auditor` for that reason: a role named "auditor" that cannot read the audit log is a trap. Name it for what it grants.

### Separate alarm-triage role

```yaml
roles:
  alarm-triage:
    - metrics:read
    - alarms:read
    - topology:read
    - traces:read
    - logs:read
    - alarm-rule:read      # the rule behind a firing alarm
    - alarm-setup:read     # which layers the alarm overview covers
landingByRole:
  alarm-triage: /alarms
```

Reads operational data plus the alarm rule behind each firing alarm, and can open the Alert page setup to see how the alarm overview is composed. It cannot change any of it: publishing an Alert page edit needs `alarm-setup:write`, and alarm rules are read-only for every role.
