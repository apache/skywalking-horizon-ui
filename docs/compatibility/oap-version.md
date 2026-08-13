# OAP Version Requirement

## Native: OAP 11.x; partial support: OAP 10.x

Horizon UI is **built natively against Apache SkyWalking OAP 11.x** — the full feature set assumes the modules and GraphQL fields that v11 ships. **OAP 10.x is partially supported, and only with `templates.mode: readonly`** — see [Running Horizon against OAP 10.x](#running-horizon-against-oap-10x) below, which is a required step, not a tuning option. With that set, the data-plane stack (dashboards, traces, logs, topology, alarms, profiling) uses the query GraphQL port.

OAP 10 **does have persistent UI-template management**. It exposes `getTemplate` / `getAllTemplates` queries and `addTemplate` / `changeTemplate` / `disableTemplate` mutations through the query-port GraphQL `UIConfigurationManagement` API; writes are controlled by `SW_ENABLE_UPDATE_UI_TEMPLATE`. OAP 11 retired that legacy GraphQL surface and replaced it with `/ui-management/templates*` on the admin REST port. Horizon currently implements only the OAP 11 REST protocol, not an adapter for the OAP 10 GraphQL protocol. That Horizon-side protocol gap — not an absence of template storage in OAP 10 — is why readonly mode is required.

The other features on OAP's **admin port** — Inspect, DSL Management, Live Debugger, Alarm Rule editor, and Cluster Status → Admin pane — depend on modules (`admin-server`, `receiver-runtime-rule`, `dsl-debugging`, `inspect`) that a v10 OAP does not run. Horizon never compares the OAP version number; it probes the capabilities it consumes. When the admin-port modules are absent, those sidebar entries are hidden.

Older 9.x OAPs are not supported — the layer concept, the MQE language baseline Horizon assumes, and the admin port layout all settled later.

### Feature matrix vs OAP version

| Horizon feature | OAP 10.x (partial) | OAP 11.x (native) |
|---|---|---|
| Layer dashboards, overviews | ✓ | ✓ |
| Alarms (read) | ✓ — falls back to legacy `getAlarm` when `queryAlarms` is absent | ✓ — uses `queryAlarms` (server-side layer filter) |
| Traces (native + Zipkin), Logs, Topology | Partial — logs, Zipkin, and topology use compatible surfaces; native trace detail requires OAP 10.3+, and endpoint-backed selectors require OAP 10.2+ with the current Horizon queries | ✓ |
| Profiling (trace / async / pprof / eBPF) | ✓ — per the profiling modules you've turned on | ✓ |
| Cluster Status — Query pane | ✓ | ✓ |
| MQE execution / metric reads | ✓ — falls back to `core.restHost`/`core.restPort` when `sharing-server` is absent | ✓ — uses `sharing-server.default.restPort` (the v11 default) |
| Cluster Status — Admin pane (admin-server, runtime-rule, dsl-debugging, inspect) | ✗ — admin-port modules don't exist on v10; pane is hidden | ✓ |
| DSL Management, Live Debugger, Alarm Rule editor | ✗ — needs `receiver-runtime-rule` + `dsl-debugging` (v11-only) | ✓ |
| **Inspect page** (metric catalog + entity enumerator) | ✗ — `/inspect/*` endpoints don't exist | ✓ — requires `SW_INSPECT=default` on OAP |
| **OAP UI-template sync** (admin pages edit OAP-stored dashboards) | ✗ in Horizon — OAP 10 stores and manages templates through legacy GraphQL, but Horizon does not consume that protocol, so the store reads as unreachable and layer-driven pages block. `templates.mode: readonly` is required. | ✓ — Horizon consumes `/ui-management/templates*` on the admin REST port |

### Running Horizon against OAP 10.x

Set **`templates.mode: readonly`** (env `HORIZON_TEMPLATES_MODE=readonly`). On a v10 OAP this is mandatory, not optional.

In the default `live` mode Horizon treats the OAP-stored template set as the source of truth for what each layer contains, and an unreachable template store is a deliberate feature block rather than a reason to guess: layer-driven pages serve nothing instead of quietly rendering something that may not match the dashboards you published. Horizon's template client calls the OAP 11 `/ui-management/templates*` REST surface. OAP 10 has the underlying store and legacy GraphQL management operations, but it does not have that REST surface, and Horizon does not fall back to the GraphQL operations — so on v10 the store is unreachable by construction, and layer-driven pages come back empty behind the "Dashboard template store unreachable" banner. The most visible one is **Traces**, which resolves its query configuration from the layer template.

`readonly` mode removes the protocol dependency entirely: Horizon does not call either template-management API, renders every dashboard from the templates bundled in the release, and makes the whole configuration surface read-only — so the admin pages present themselves honestly as display-only instead of offering saves that cannot land. It also drops the pointless per-boot probing of an endpoint that will never answer. This is the supported way to run against v10; it does not disable or remove OAP 10's own `ui_template` data.

```yaml
templates:
  mode: readonly
```

Editing dashboards from Horizon's admin pages requires an OAP 11 deployment. Setting `SW_ENABLE_UPDATE_UI_TEMPLATE=true` on OAP 10 enables its legacy GraphQL mutations for compatible clients, but it does not make Horizon's REST client compatible; Horizon's pages remain display-only in readonly mode.

### What "partial support on v10" means in practice

- **Most data-plane pages use the v10 query port.** Dashboards, overviews, alarms (read), logs, topology, and profiling use the GraphQL query port (default `:12800`). Schema details still vary by minor: current Horizon sends `queryTrace(..., duration)` (available from OAP 10.3) and `findEndpoint(..., duration)` (available from OAP 10.2), without a fallback for earlier 10.x schemas.
- **Template management uses a different protocol.** OAP 10 serves its `ui_template` store through query-port GraphQL. OAP 11 serves it through admin-port REST. Horizon consumes only the latter, so OAP 10 requires readonly mode even though its own template API and stored templates exist.
- **Admin port is dark on v10.** The entire admin port (default `:17128`) is gone — `admin-server`, `receiver-runtime-rule`, `dsl-debugging`, and `inspect` are not run by a v10 OAP. Features that depend on those modules (Inspect, DSL Management, Live Debugger, Alarm Rule editor, and Cluster Status → Admin pane) are unavailable and the corresponding sidebar entries are hidden.
- **MQE target resolution** falls back to OAP's `core.restHost`/`core.restPort` instead of the v11 `sharing-server.default.restPort` default. Works fine, just a different code path.
- **Admin template editing** is read-only — with `templates.mode: readonly` the dashboard / overview / alert admin pages render the bundled JSON and every save is blocked. Display still works.

For the complete triage set listed here, including native trace detail, use OAP 10.3+ with `templates.mode: readonly`; earlier 10.x minors have the trace and endpoint limitations in the matrix. If you need the admin-port features or want to edit OAP-stored dashboards from Horizon, you need v11.

## Where the version is shown

Once Horizon is up:

- **Topbar status chip** — small build-version pill in the right-side cluster strip, fed by the GraphQL `version` query.
- **Cluster Status page → Query pane** (`/operate/cluster`) — version, server timezone, current timestamp, health score.

The version is fetched via:

```graphql
query { version }
```

against the OAP query port (default `:12800`), polled every 30 seconds.

## What "compatible" means in practice

Horizon does **not** lock to a specific OAP minor version. For selected capabilities, the BFF probes OAP's GraphQL schema via introspection and degrades gracefully when a newer field is missing. Currently:

- **Alarms**: prefers the modern `queryAlarms` capability (server-side layer filter) and falls back to the legacy `getAlarm` (all-layers + client-side filter) when the schema doesn't include it.
- **Per-call capability cache** ensures the probe runs once per BFF lifetime, not per request.

Horizon supports the capability fallbacks listed above; this should not be read as universal forward- or backward-compatibility for every GraphQL field. OAP 10 operation additionally loses the OAP 11 admin-port features and Horizon template editing, and older 10.x minors have the trace/endpoint limitations listed in the matrix.

## Versions of related pieces

| Piece | Where to check |
|---|---|
| OAP version | Topbar chip, Cluster Status page |
| Horizon UI version | Package `apps/ui/package.json` |
| Horizon BFF version | Package `apps/bff/package.json` |
| GraphQL query-protocol | `oap-server/server-query-plugin/.../query-protocol/*.graphqls` in apache/skywalking |
| MQE language | OAP repo (`oap-server/mqe-rt`) |

## Upgrading OAP under a running Horizon

Patch upgrades that keep the same Horizon-facing capability layout need no special coordination:

1. Roll OAP. The query port and admin port get the new build.
2. Horizon's 30-second poll picks up the new `version` string. The capability cache is keyed per BFF process lifetime — a BFF restart re-probes; a hot OAP upgrade keeps the cached capability set until the BFF restarts.

If you change the OAP capability surface during the upgrade (e.g., enable `SW_INSPECT=default` for the first time), restart the BFF to re-probe.

Moving from OAP 10 readonly mode to OAP 11 live mode is a configuration change, not a zero-coordination upgrade:

1. Enable OAP 11's `admin-server` and `ui-management` modules and expose the admin REST port.
2. Set Horizon's `oap.adminUrl` to that port and verify `/ui-management/templates` is reachable.
3. Change `templates.mode` from `readonly` to `live` and restart the BFF. Horizon then seeds its bundled templates through the REST API.
