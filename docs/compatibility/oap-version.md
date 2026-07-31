# OAP Version Requirement

## Native: OAP 11.x; partial support: OAP 10.x

Horizon UI is **built natively against Apache SkyWalking OAP 11.x** — the full feature set assumes the modules and GraphQL fields that v11 ships. **OAP 10.x is partially supported, and only with `templates.mode: readonly`** — see [Running Horizon against OAP 10.x](#running-horizon-against-oap-10x) below, which is a required step, not a tuning option. With that set, the data-plane stack (dashboards, traces, logs, topology, alarms, profiling) renders correctly because it only touches the query GraphQL port. Everything that lives on OAP's **admin port** — Inspect, DSL Management, Live Debugger, Alarm Rule editor, Cluster Status → Admin pane, OAP UI-template sync — depends on modules (`admin-server`, `receiver-runtime-rule`, `dsl-debugging`, `inspect`) that a v10 OAP does not run. Horizon never compares the OAP version number; it detects each module by its presence in OAP's config dump and probes the GraphQL schema for the fields it needs. When the admin-port modules are absent, those sidebar entries are hidden and the admin pages fall back to bundled read-only.

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
| **OAP UI-template sync** (admin pages edit OAP-stored dashboards) | ✗ — `/ui-management/templates*` does not exist on v10 (OAP served template management over GraphQL there; v11 moved it to the admin REST port and Horizon speaks only that). Run `templates.mode: readonly` so Horizon renders its bundled templates instead. | ✓ — required for non-read-only admin editing |

### Running Horizon against OAP 10.x

Set **`templates.mode: readonly`** (env `HORIZON_TEMPLATES_MODE=readonly`). On a v10 OAP this is mandatory, not optional.

In the default `live` mode Horizon treats the OAP-stored template set as the source of truth for what each layer contains, and an unreachable template store is a deliberate feature block rather than a reason to guess: routes serve nothing instead of silently rendering something that may not match the operator's configured dashboards. On v10 the store is unreachable by construction — `/ui-management/templates*` is a v11 module — so layer-driven pages come back empty, most visibly **Traces**, which resolves its query fields from the layer template.

`readonly` mode removes the dependency entirely: Horizon never contacts the template store, renders every dashboard from the templates bundled in the release, and makes the whole configuration surface read-only. That is the same behavior Horizon had before OAP-stored templates existed, and it is the supported way to run against v10.

```yaml
templates:
  mode: readonly
```

Editing dashboards from the admin pages then requires an OAP 11 deployment; on v10 they are display-only, which matches the rest of the admin surface being unavailable there.

### What "partial support on v10" means in practice

- **Data-plane pages just work.** Dashboards, overviews, alarms (read), traces, logs, topology, and profiling all render on v10. The GraphQL query port (default `:12800`) is what they use, and the protocol is stable across both lines.
- **Admin port is dark on v10.** The entire admin port (default `:17128`) is gone — `admin-server`, `receiver-runtime-rule`, `dsl-debugging`, and `inspect` are not run by a v10 OAP. Horizon detects this by their absence from the config dump, not by reading the version number; when those modules don't report, anything that depends on them (Inspect, DSL Management, Live Debugger, Alarm Rule editor, Cluster Status → Admin pane, OAP UI-template sync) is unavailable and the corresponding sidebar entries are hidden so operators don't see broken pages.
- **MQE target resolution** falls back to OAP's `core.restHost`/`core.restPort` instead of the v11 `sharing-server.default.restPort` default. Works fine, just a different code path.
- **Admin template editing** is read-only — with `templates.mode: readonly` the dashboard / overview / alert admin pages render the bundled JSON and every save is blocked. Display still works.

If you only need triage (dashboards, alarms, traces, logs), v10 with `templates.mode: readonly` is sufficient. If you need any operate / admin functionality — or want to edit dashboards from the UI — you need v11.

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
