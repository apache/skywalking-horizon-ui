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
| `alarms:read` | Alarms page and named alarm pages, alarm widgets on overviews. |
| `events:read` | Events popout on a service banner: that service's lifecycle events. |
| `traces:read` | Traces tab on any layer, trace detail page. |
| `logs:read` | Logs tab on any layer, log detail page. |
| `browser-errors:read` | Browser Logs tab (BROWSER layer): list JS error logs, list source maps, resolve a stack. |
| `ai-conversation:read` | AI agent conversations (AI_AGENT layer): list the conversations the AI Sessionizer pushed and open one. Distinct from `ai:read`, which is the AI assistant. |
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
| `alarm-setup:read` / `alarm-setup:write` | Alarm pages setup (`/admin/alert-page-setup`): the default and named alarm pages. |
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
| `cluster:read` | Cluster Status page (`/operate/cluster`), and the **Platform monitoring layers** — the OAP, BanyanDB, agent and Satellite self-observability dashboards, and any other layer whose template sets `visibility: operate`. A role that reads layer data (`metrics:read`, `traces:read`, …) without `cluster:read` does not see those layers and cannot read their services, by page, by URL or through the AI assistant, and their services' rows are left out of the all-services Logs and Events views; an explicit [layer grant](#limiting-a-verb-to-layers-and-service-groups) such as `metrics:read@BANYANDB` opens one without it. |
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
| `area:*` | Any verb in that area, including sub-actions: `rule:*` matches `rule:read`, `rule:write`, `rule:write:structural`, `rule:delete`. The `*` is the whole second segment — `rule:*:anything` is not a narrower form of this, it is malformed, and grants nothing. |
| `*:read` | The `read` action in any area: matches `metrics:read`, `alarms:read`, `cluster:read`, etc. Does **not** match `rule:write:structural` (the action is not `read`), and does **not** match `audit:read` — see below. |

Effective verbs for a session are the **union** of all grants from all roles.

## Limiting a verb to layers and service groups

A data verb can carry the layer it applies to, and optionally one or more of the layer's OAP service groups:

```
<verb>@<LAYER>                          # every service of the layer
<verb>@<LAYER>[<group1>, <group2>, …]   # only the services of these groups
```

The role then reads those services only, and the sidebar shows that layer only:

| Grant | Reaches |
|---|---|
| `metrics:read@GENERAL` | Every service of the GENERAL layer. |
| `metrics:read@GENERAL[payments]` | The GENERAL services whose OAP service group is `payments` — the `payments::` prefix of the service name. |
| `metrics:read@GENERAL[payments,risk]` | Both groups. |
| `metrics:read@GENERAL[-]` | The GENERAL services that have no group. |
| `"*:read@GENERAL[payments]"` | Every read that can carry a layer, on those services. Quote a grant that starts with `*`. |
| `metrics:read` (no `@`) | What it has always meant: every layer, except the Platform monitoring layers, which also need `cluster:read`. |

Layer keys are the ones the sidebar and the layer templates use (`GENERAL`, `K8S_SERVICE`, `VIRTUAL_DATABASE`, …), in any case. A group is OAP's own service group, so a layer that is [split by service group](../customization/layer-templates.md) shows one sidebar entry per group, and each entry can be granted to a different role.

Only verbs whose data belongs to a service can carry a layer: `metrics:read`, `traces:read`, `logs:read`, `browser-errors:read`, `ai-conversation:read`, `events:read`, `alarms:read`, `topology:read`, `profile:read` and `profile:enable`. Any other verb written with `@` grants nothing, and Horizon names it in a startup warning.

**What the role sees.** The sidebar lists the layers, and the group entries, that the role's layer grants reach — each with all of its pages, as for any role; a page whose data the role cannot read answers with a refusal. The Zipkin and TraceQL pages have no per-service control of their own and follow the layer's visibility. Every request is checked on its own: a page, an API call, and every read the AI assistant or an MCP agent makes on the role's behalf must name a service the grant covers, whichever layer's page or URL it arrives through. A service that reports into several layers is one service to OAP, so granting any of those layers grants it. An explicit grant on a Platform monitoring layer, such as `metrics:read@BANYANDB`, opens that layer without `cluster:read`.

**What the role still sees of other services.** Links between services are navigation, not access: the page a link opens is checked like any other. The views that draw relationships still draw what OAP returns around the role's own services, but never the metrics of a service the role may not read. The topology map draws every connected service, in any layer or group; a service the role may not read keeps its name and says its metrics are **blocked**, and a call between two services shows its client-side and server-side values when the role reads either end, and none when it reads neither. A call the role reads only through its destination carries only its relation metrics: a metric of another scope written into a call's panel is read for the calling service, which the role may not read. A service OAP could not say the owner of right now shows its metrics as **unavailable** rather than blocked. The instance map and the API dependency graph draw the other service's instances and endpoints the same way, and the hierarchy view names the same workload's services in other layers, without metrics. A network-profiling graph is the profiling of one instance: the role that may read that instance sees all of its processes and calls, whichever services they are. An MQE expression is read through its entity's service: a relation metric is readable from the service that makes the call. `baseline(...)` is looked up by service name alone, so it runs only where every service of that name is readable — for a node, its own name; for a call, the calling service's. Pod logs are read per pod, the way Kubernetes grants them: an instance the role may read opens every container of its pod, sidecars included.

**Traces cross layers.** A trace follows a request through services of any layer, so Horizon does not narrow traces by layer. A role with `traces:read` on a layer reads that layer's trace tabs — the SkyWalking trace list for the service picked on the page, and the Zipkin and TraceQL stores the layer lists — and opens any trace by its id, every span included. Traces are not narrowed by group either: the Zipkin and TraceQL searches reach every service in those stores.

**Alarms.** With `alarms:read` limited to layers, every alarm page, the alarm count in the sidebar and the top bar, the overview **Alarms** widget and the 3D map show the alarms of the services the grant covers: an alarm on a service, on one of its instances or endpoints, or on a relation whose source or destination is one of those services. OAP gives a relation's destination by name only, so when a normal and a conjectured service share that name, a role that reads the relation only through its destination sees it when it may read both. An alarm's snapshot — the values its rule evaluated, a `baseline` among them — is part of the alarm: a role that may see the alarm sees it whole. Which named alarm pages a role sees follows from the same grant — see [Alarm Pages](../customization/alarm-pages.md). A page arranges the alarms a role may read; it never grants any.

**Evaluation records.** They belong to a call from an application service to a GenAI provider, and the page's two conditions follow the two sides' grants: the provider needs `logs:read` on VIRTUAL_GENAI, and the calling service `logs:read` on its own layer. Each provider or caller picked must be readable. A condition left unpicked reads every service on its side, so it needs that side whole: every provider is the whole VIRTUAL_GENAI layer, and every caller needs `logs:read` without `@`. A role granted part of a side is not offered "all" there and must pick one of its own; a role without a grant on both sides reads no records.

**What needs the verb without a layer.** A query that would read every service cannot be narrowed, so a role whose grant carries `@` cannot use it — even a grant on a whole layer, such as `metrics:read@GENERAL`:

- the SkyWalking trace list, the Logs tab and the Browser Logs tab need a service picked (there is no "all services" choice);
- an overview KPI that totals a whole layer on the server — the default for a KPI; the layer header and a page-side KPI are computed from the role's own services;
- log tag autocomplete, source maps, and any alarm list from an OAP older than the `queryAlarms` API;
- keeping a network-profiling task alive.

**Combining roles.** Grants from all of a user's roles are pooled, and a verb without a layer in ANY role lifts the limit for that verb: a user who also holds the built-in `viewer` role reads every layer a plain grant reaches. An OAuth scope narrows by verb and keeps the layer: `horizon:read` over `metrics:*@GENERAL` leaves `metrics:read@GENERAL`.

**Keep a team's role narrow.** Anything else a user holds adds to the team role, so check where else roles come from: the stock `viewer` role, an LDAP `{ group: "*", role: viewer }` mapping (the sample configuration has one), or single sign-on's `defaultRoles`, which is `viewer` unless you change it. And two read verbs cannot carry a layer and query any service: `inspect:read` (Metrics, Trace and Log Inspect) and `infra-3d:read` (the 3D map). Leave them out of a team's role.

A role with no `@` grant is unaffected by any of this: it sees the menu and the data it always has.

### Page by page

What each page checks for a role limited to layers or service groups. "Readable" means the role's grant for the page's verb reaches the service; a role without `cluster:read` also finds services that are only in a Platform monitoring layer unreadable.

With a layer granted only in part, query a specific service of your own: a picker does not offer "all" for a condition whose side your grant covers only in part, and a request that leaves it out is refused. The alarm pages are the exception — they list the alarms your grant covers without a service picked — and so are the Zipkin and TraceQL searches, which traces cross.

| Page or read | Verb | What is checked, and what the role sees |
|---|---|---|
| Sidebar | the page verbs | Only the layers, and the group entries of a layer split by service group, that a grant reaches. A group entry opened by its address that the grant does not reach answers "No access to this layer". The layer's own address, which is the services with no group, opens the reader's first group entry instead when the grant does not reach those services, unless it names a service. |
| Service pickers and lists | the page verbs | Only readable services. A link naming a service outside the list shows the page's first service, with a note saying so. |
| Service, instance and endpoint dashboards | `metrics:read` | The picked service must be readable. A refused read says why instead of loading. |
| Layer header KPIs | `metrics:read` | Computed from the role's own services, like the service list below them; the service count is theirs too. |
| Overview KPI tiles | `metrics:read` | A KPI that totals a layer on the server — the default — needs the verb without `@`, and shows no value otherwise. A page-side KPI (`aggregateOnPage`), a ranking and a service count are computed from the role's own services. |
| Topology map | `topology:read` | The focus services must be readable. Every connected service is drawn; one the role may not read shows **blocked** instead of its metrics, and its metrics are not read — one OAP could not place shows **unavailable**. A call shows both its client-side and server-side values when the role reads either end, only its relation metrics when that end is the destination. The **All services** map is one hop out from the role's services; the Depth control (1–3 hops) applies to a focused map. |
| Instance map | `topology:read` | Opens when the role reads either service. The other service's instances show **blocked**; the calls between the two carry their values. |
| API dependency graph | `topology:read` | The focus service and endpoint must be readable. Endpoints of other services show **blocked**; expanding one of them is refused. |
| Deployment map | `topology:read` | One service, which must be readable. |
| Service hierarchy | `topology:read` | The focus service must be readable; related services in other layers are named, without metrics. |
| Traces | `traces:read` | The SkyWalking trace list needs a picked, readable service, or an exact trace id, from a role that does not read every layer. A trace opened by id, and the Zipkin and TraceQL searches, are not narrowed. |
| Logs, browser logs, pod logs | `logs:read`, `browser-errors:read` | A picked, readable service (and instance or endpoint, or a browser version or page path of one); pod logs per pod. Log tag autocomplete and source maps need the verb without `@`, and the Browser Logs page does not offer source maps to a role with `@`. |
| Evaluation records | `logs:read` on VIRTUAL_GENAI and on the callers' layers | Each condition follows its own side's grant, as described above. |
| Events | `events:read` | A named, readable service. |
| Alarms, the alarm count, the Alarms widget | `alarms:read` | The alarms of readable services, as described above; alarm pages list only what their pins cover. |
| AI agent conversations | `ai-conversation:read` | A named, readable service. |
| Profiling | `profile:read`, `profile:enable` | On the page's layer and a readable service: its tasks, policies and results, and the analysis of a task's own segments or schedules. An eBPF task's schedules are read for a picked, readable service from a role that does not read every layer. Network profiling reads the profiled instance: its processes and the calls between them, whichever services they are. Keeping a network-profiling task alive needs the verb without `@`. |
| MQE in the template editor, Metrics Inspect | `metrics:read`, `inspect:read` | Through the expression's entity service; an expression that names no service needs `inspect:read`. |
| 3D map | `infra-3d:read` | Draws only the services of the role's own sidebar layers; the verb cannot carry a layer. |
| AI assistant and MCP agents | `ai:read`, `mcp:read` + each tool's verb | Every tool checks its read as the matching page does — the layer it names included — and a map or graph it returns withholds the same metrics. Listing services and layers takes any page verb, as the pickers do. |

## Built-in roles

Default definitions (used when `rbac.roles` is not overridden):

### `viewer`

Read-only data catalog, the read-only inspect tools, and the AI assistant. Deliberately limited — does not include `*:read` so a viewer cannot peek at rule definitions, live-debug sessions, setup screens, or cluster / TTL / config internals.

```
metrics:read, alarms:read, events:read, traces:read, logs:read, browser-errors:read, ai-conversation:read, inspect:read, topology:read, profile:read, overview:read, infra-3d:read, ai:read, mcp:read
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

Access is enforced server-side, not in the browser. Every protected request is checked for a valid session (an unauthenticated request is rejected with `401`), then for the verb that request requires, and then — for a request that reads a layer or a service — for the layer and every service it names (a session lacking any of these is rejected with `403`). The UI hides controls a session cannot use, but a forged UI cannot bypass these checks.

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

### A team that sees only its own services

```yaml
roles:
  payments-viewer:
    - "metrics:read@GENERAL[payments]"
    - "traces:read@GENERAL[payments]"
    - "logs:read@GENERAL[payments]"
    - "topology:read@GENERAL[payments]"
    - "alarms:read@GENERAL[payments]"
    - "metrics:read@K8S_SERVICE[payments-prod]"   # the team's own Kubernetes cluster
    - ai:read                      # the assistant reads what the grants above allow, no more
landingByRole:
  payments-viewer: /alarms/payments   # a named alarm page pinning GENERAL[payments]
```

Service groups come from the service name (`payments::checkout`), so this works when every service the team runs carries the prefix. On the Kubernetes layers OAP builds the name from the cluster — `<cluster>::<service>.<namespace>` on `K8S_SERVICE` — so there the group is the cluster: `metrics:read@K8S_SERVICE[payments-prod]` reaches every service of the `payments-prod` cluster, which fits a cluster per team, and a namespace cannot be granted on its own.

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
    - alarm-setup:read     # how the alarm pages are composed
landingByRole:
  alarm-triage: /alarms
```

Reads operational data plus the alarm rule behind each firing alarm, and can open the Alarm pages setup to see how the alarm pages are composed. It cannot change any of it: saving an alarm page needs `alarm-setup:write`, and alarm rules are read-only for every role.
