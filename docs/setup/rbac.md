# Access Control Configuration

Role-Based Access Control. Defines the role → verb grants and the post-login landing route per role. Full behavior reference (verb vocabulary, grant matching, where each verb gates) is in [Access Control → RBAC: Roles & Verbs](../access-control/rbac.md); this page is the `horizon.yaml` shape.

## Shape

```yaml
rbac:
  enabled: true
  builtinRoles: replace     # or `keep` to merge onto the built-ins
  roles:
    viewer:     [metrics:read, alarms:read, events:read, traces:read, logs:read, browser-errors:read, ai-conversation:read, inspect:read, topology:read, profile:read, overview:read, infra-3d:read, ai:read, mcp:read]
    maintainer: [metrics:read, alarms:read, events:read, traces:read, logs:read, browser-errors:read, ai-conversation:read, topology:read, profile:read, overview:read, cluster:read, inspect:read, ttl:read, config:read, infra-3d:read, ai:read, mcp:read]
    operator:   [metrics:read, ..., rule:write:structural, live-debug:write, profile:enable, ai:read, mcp:read]
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
| `builtinRoles` | `replace` \| `keep` | `replace` | no | What a configured `roles` block does to the built-ins. `replace`: the block is the whole role set. `keep`: the built-ins are the base — a listed name overrides that one role, a new name is appended, the rest stay. Also merges `landingByRole`. |
| `roles` | object | the four built-ins | no | Custom role definitions. Keys are role names; values are arrays of permission strings. **Omitting this block uses the four built-ins** (`viewer`, `maintainer`, `operator`, `admin`) — the full grants are in the table below. Under the default `builtinRoles: replace`, defining the block overrides them entirely. |
| `landingByRole` | object | see below | no | Post-login redirect route per role. First role on the user wins. |

## Built-in roles (used when `roles` is not set)

| Role | Purpose | Grants |
|---|---|---|
| `viewer` | Read-only data catalog, inspect tools, public overviews, the AI assistant, and MCP. | `metrics:read`, `alarms:read`, `events:read`, `traces:read`, `logs:read`, `browser-errors:read`, `ai-conversation:read`, `inspect:read`, `topology:read`, `profile:read`, `overview:read`, `infra-3d:read`, `ai:read`, `mcp:read`. Deliberately not `*:read` so the viewer cannot see rule definitions, live-debug sessions, setup screens, or cluster / TTL / config internals. |
| `maintainer` | Viewer + platform monitoring. | viewer baseline + `cluster:read`, `ttl:read`, `config:read`. |
| `operator` | Configures observability. | maintainer baseline + `source-map:write`, the six Dashboard-setup read/write pairs (`overview-template`, `layer-template`, `translation`, `alarm-setup`, `infra-3d-setup`, `setup`), `alarm-rule:read`, `rule:read`, `rule:write`, `rule:write:structural`, `rule:delete`, `live-debug:read`/`write`, `profile:enable`. Alarm rules are read-only for every role. |
| `admin` | Unrestricted. | `*`. |

## Adding your own role

`rbac.roles` is an open map — the four built-ins have no special status, and you can define as many roles as you like beside them.

By default, **naming `roles` replaces the block entirely**: the roles that exist are exactly the ones you listed, and a user whose every role has disappeared holds no verbs and is refused everywhere. Set `builtinRoles: keep` to treat the built-ins as a base instead — then a name you list overrides that one role wholesale, a new name is appended, and everything you did not mention stays as it shipped.

A common addition is a **read-only template viewer** — someone who inspects how the dashboards are configured, and reviews translations, without being able to publish anything. Grant the read half of each Dashboard-setup pair and none of the write half:

```yaml
rbac:
  enabled: true
  builtinRoles: keep        # viewer / maintainer / operator / admin stay as they are
  roles:
    # The six Dashboard-setup pages, read-only. No `:write` anywhere.
    # Nothing else belongs here — grant it beside `viewer`, whose data reads
    # (metrics, alarms, topology, overview) render the dashboards being
    # reviewed. A user's verbs are the union of their roles'.
    template-viewer:
      - overview-template:read
      - layer-template:read
      - translation:read
      - alarm-setup:read
      - infra-3d-setup:read
      - setup:read
  landingByRole:
    template-viewer: /
```

Assign it alongside the role the person already holds — `roles: [viewer, template-viewer]` — rather than as their only role.

What the pair gets that user: all six rows under **Dashboard setup** in the sidebar, each page opening with the whole stored configuration visible and every editing control disabled, and a banner naming the permission publishing would need. Browsing still works — switching template, locale or component, refreshing from OAP, exporting, and opening a diff to compare the shipped default against what is live. Nothing it does can change OAP: Horizon refuses every publish server-side, not merely in the interface.

Grant only the pairs you mean. `translation:read` on its own is enough for a translator: it opens the Translations page and reads the source templates being translated, and nothing else — the Layer dashboards and Overview templates editors stay closed to it.

**Under `keep`, a built-in cannot be removed by leaving it out** — leaving it out is what keeps it. Grant it nothing instead, which leaves the role in place conferring no verb:

```yaml
rbac:
  builtinRoles: keep
  roles:
    admin: []
```

**`builtinRoles` defaults to `replace`,** and deliberately: a deployment that trimmed its `roles` block in order to remove a role would otherwise get it back on upgrade, and one of the roles it would get back is `admin: ["*"]`. Opt in when you want merging; never rely on it appearing by itself.

**Assigning the role.** Roles come from whichever sign-in backend is configured — a local user's `roles` list, an LDAP group mapping, or the SSO role tables. See [Authentication](auth.md). A user carries the union of every verb their roles grant, which is why a role like the one above only has to name what it adds: granting it beside `viewer` widens that user by exactly the six setup reads and nothing else. The effective role names are logged at startup, so you can confirm what a merge produced.

## Verb grammar

Grants are dot-namespaced strings. Four matching modes:

| Pattern | Meaning |
|---|---|
| `*` or `admin` | Matches any verb (admin). |
| `area:verb` | Exact match: e.g., `rule:write` grants exactly `rule:write`. |
| `area:*` | Matches any verb in that area: `rule:*` grants `rule:read`, `rule:write`, `rule:write:structural`, `rule:delete`. |
| `*:read` | Matches the `read` action across any area. |

Nothing else is a grant. A string outside these forms — a typo like `rule:*:typo`, or a fourth segment — matches no verb and confers nothing; Horizon names it in a startup warning so it does not sit in your config looking effective.

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
