# OAP Version Requirement

## Native: OAP 11.x; partial support: OAP 10.x

Horizon UI is **built natively against Apache SkyWalking OAP 11.x** — the full feature set assumes the modules and GraphQL fields that v11 ships. **OAP 10.x is partially supported**: the data-plane stack (dashboards, traces, logs, topology, alarms, profiling) renders correctly because it only touches the query GraphQL port. Everything that lives on OAP's **admin port** — Inspect, DSL Management, Live Debugger, Alarm Rule editor, Cluster Status → Admin pane, OAP UI-template sync — depends on modules (`admin-server`, `receiver-runtime-rule`, `dsl-debugging`, `inspect`) that a v10 OAP does not run. Horizon never compares the OAP version number; it detects each module by its presence in OAP's config dump and probes the GraphQL schema for the fields it needs. When the admin-port modules are absent, those sidebar entries are hidden and the admin pages fall back to bundled read-only.

Older 9.x OAPs are not supported — the layer concept, the MQE language baseline Horizon assumes, and the admin port layout all settled later.

### Feature matrix vs OAP version

| Horizon feature | OAP 10.x (partial) | OAP 11.x (native) |
|---|---|---|
| Layer dashboards, overviews | ✓ | ✓ |
| Alarms (read) | ✓ — falls back to legacy `getAlarm` when `queryAlarms` is absent | ✓ — uses `queryAlarms` (server-side layer filter) |
| Traces (native + Zipkin), Logs, Topology | ✓ | ✓ |
| Profiling (trace / async / pprof / eBPF) | ✓ — per the profiling modules you've turned on | ✓ |
| Cluster Status — Query pane | ✓ | ✓ |
| MQE execution / metric reads | ✓ — falls back to `core.restHost`/`core.restPort` when `sharing-server` is absent | ✓ — uses `sharing-server.default.restPort` (the v11 default) |
| Cluster Status — Admin pane (admin-server, runtime-rule, dsl-debugging, inspect) | ✗ — admin-port modules don't exist on v10; pane is hidden | ✓ |
| DSL Management, Live Debugger, Alarm Rule editor | ✗ — needs `receiver-runtime-rule` + `dsl-debugging` (v11-only) | ✓ |
| **Inspect page** (metric catalog + entity enumerator) | ✗ — `/inspect/*` endpoints don't exist | ✓ — requires `SW_INSPECT=default` on OAP |
| **OAP UI-template sync** (admin pages edit OAP-stored dashboards) | ✗ — `/ui-management/templates*` not available; admin pages are read-only against bundled | ✓ — required for non-read-only admin editing |

### What "partial support on v10" means in practice

- **Data-plane pages just work.** Dashboards, overviews, alarms (read), traces, logs, topology, and profiling all render on v10. The GraphQL query port (default `:12800`) is what they use, and the protocol is stable across both lines.
- **Admin port is dark on v10.** The entire admin port (default `:17128`) is gone — `admin-server`, `receiver-runtime-rule`, `dsl-debugging`, and `inspect` are not run by a v10 OAP. Horizon detects this by their absence from the config dump, not by reading the version number; when those modules don't report, anything that depends on them (Inspect, DSL Management, Live Debugger, Alarm Rule editor, Cluster Status → Admin pane, OAP UI-template sync) is unavailable and the corresponding sidebar entries are hidden so operators don't see broken pages.
- **MQE target resolution** falls back to OAP's `core.restHost`/`core.restPort` instead of the v11 `sharing-server.default.restPort` default. Works fine, just a different code path.
- **Admin template editing** is read-only — the dashboard / overview / alert admin pages render bundled JSON and show the OAP-unreachable banner. Saves are blocked. Display still works.

If you only need triage (dashboards, alarms, traces, logs), v10 is sufficient. If you need any operate / admin functionality, you need v11.

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

Horizon does **not** lock to a specific OAP minor version. The BFF probes OAP's GraphQL schema via introspection and degrades gracefully when newer features are missing:

- **Alarms**: prefers the modern `queryAlarms` capability (server-side layer filter) and falls back to the legacy `getAlarm` (all-layers + client-side filter) when the schema doesn't include it.
- **Per-call capability cache** ensures the probe runs once per BFF lifetime, not per request.

This means a Horizon release built against OAP 11.x will continue to work against future v11 patch releases, picking up new server-side capabilities automatically when they appear — and will also keep working against v10 at the cost of Inspect + admin template editing.

## Versions of related pieces

| Piece | Where to check |
|---|---|
| OAP version | Topbar chip, Cluster Status page |
| Horizon UI version | Package `apps/ui/package.json` |
| Horizon BFF version | Package `apps/bff/package.json` |
| GraphQL query-protocol | `oap-server/server-query-plugin/.../query-protocol/*.graphqls` in apache/skywalking |
| MQE language | OAP repo (`oap-server/mqe-rt`) |

## Upgrading OAP under a running Horizon

OAP upgrades are zero-coordination from Horizon's side:

1. Roll OAP. The query port and admin port get the new build.
2. Horizon's 30-second poll picks up the new `version` string. The capability cache is keyed per BFF process lifetime — a BFF restart re-probes; a hot OAP upgrade keeps the cached capability set until the BFF restarts.

If you change the OAP capability surface during the upgrade (e.g., enable `SW_INSPECT=default` for the first time), restart the BFF to re-probe.
