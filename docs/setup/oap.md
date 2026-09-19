# OAP Connection

Connectivity to the upstream Apache SkyWalking OAP cluster. Required for everything except the login page.

```yaml
oap:
  queryUrl: http://127.0.0.1:12800
  adminUrl: http://127.0.0.1:17128
  zipkinUrl: http://127.0.0.1:9412/zipkin
  traceql:
    nativeUrl: http://127.0.0.1:3200/skywalking
    zipkinUrl: http://127.0.0.1:3200/zipkin
  timeoutMs: 15000
  auth:
    username: skywalking
    password: "${HORIZON_OAP_PW}"
```

## Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `queryUrl` | URL string | `http://127.0.0.1:12800` | no | OAP GraphQL query endpoint. Load-balanceable — any OAP node answers. Used by all read pages. Must be a valid URL. |
| `adminUrl` | URL string | `http://127.0.0.1:17128` | no | OAP admin REST endpoint. Hosts runtime-rule, dsl-debugging, inspect, status, debugging/config endpoints. Single URL; OAP handles cluster-internal fan-out. |
| `zipkinUrl` | URL string | `http://127.0.0.1:9412/zipkin` | no | Zipkin v2 REST endpoint. Used when a layer exposes the Zipkin trace store. Defaults assume the standalone Armeria binding; for Docker / shared-port deployments use `<queryUrl>/zipkin`. |
| `traceql.nativeUrl` | URL string | empty | no | OAP's TraceQL (Grafana Tempo API) service over the SkyWalking-native spans, context path included. **Empty means off** — there is deliberately no default, because OAP ships the module disabled. See [TraceQL trace stores](#traceql-trace-stores-oaptraceql). |
| `traceql.zipkinUrl` | URL string | empty | no | The same service over the Zipkin spans, context path included. Empty means off. |
| `timeoutMs` | number | `15000` | no | Per-request HTTP timeout (milliseconds) for all OAP calls. Applies to query, admin, Zipkin. Must be positive integer. |
| `auth.username` | string | — | required if `auth` block present | Basic-auth username. Sent on every outbound OAP call. |
| `auth.password` | string | — | required if `auth` block present | Basic-auth password. Sent on every outbound OAP call. Use `${VAR}` interpolation, not a literal. |
| `mqe.host` | string | — | no | Override host for the MQE (`execExpression`) calls the Metrics Inspect page fires. When the whole `mqe` block is unset, those calls go to `queryUrl` like every other GraphQL query. See [MQE endpoint override](#mqe-endpoint-override-oapmqe). |
| `mqe.port` | number | — | no | Override port for the same calls. Must be positive integer. |

## How the BFF uses each URL

| URL | Hit by |
|---|---|
| `queryUrl` | GraphQL (`version`, `getTimeInfo`, `checkHealth`, `listLayers`, `listServices`, `getMenuItems`, `listLayerLevels`, `execExpression`, alarm queries, trace queries, log queries, topology queries, profiling queries). |
| `adminUrl` | `/debugging/config/dump`, `/runtime/rule/*`, `/dsl-debugging/*`, `/inspect/metrics`, `/inspect/entities`, `/status/alarm/*`, and — in live template mode — `/ui-management/templates*`. |
| `zipkinUrl` | Zipkin v2 trace queries, for a layer that exposes the Zipkin trace store. |
| `traceql.*` | TraceQL searches, tag and tag-value lookups, and trace-by-id reads, for a layer that exposes a TraceQL trace store. |

`queryUrl` is always required. `adminUrl` is required for OAP 11 admin features and for Horizon's live template mode; it is not required for an OAP 10 deployment running `templates.mode: readonly`. Configured query and admin URLs are health-checked independently. See [Cluster Status Check Sequence](../compatibility/cluster-status.md) for the per-pane behavior.

## TraceQL trace stores (`oap.traceql`)

OAP can answer for its traces in [Grafana Tempo's](https://grafana.com/docs/tempo/latest/traceql/) query language over Tempo's HTTP API, with one datasource per underlying store: the SkyWalking-native spans, and the Zipkin spans (which also carry OpenTelemetry traces OAP converted). Each datasource is a separate context path on OAP's TraceQL server, so Horizon takes one full URL each rather than deriving them — and either one alone is a valid configuration.

It is a separate server from the query port, **off in OAP by default**, and enabled there with:

```
SW_TRACEQL=default
SW_TRACEQL_ENABLE_DATASOURCE_SKYWALKING=true
SW_TRACEQL_ENABLE_DATASOURCE_ZIPKIN=true
```

Its default port is `3200`, with the context paths `/skywalking` and `/zipkin`. Point Horizon at the ones you enabled:

```yaml
oap:
  traceql:
    nativeUrl: http://<oap-host>:3200/skywalking
    zipkinUrl: http://<oap-host>:3200/zipkin
```

Leaving a URL empty turns that source off: its sidebar row still appears for a layer that names it, and the tab states that no URL is configured rather than searching something else. A configured URL that does not answer is reported the same way, on the page rather than in a log.

Which layers expose these stores is a layer-template decision, not a connection one — see [Layer Dashboard Templates → `traces`](../customization/layer-templates.md#traces) and [Traces](../operate/traces.md).

## MQE endpoint override (`oap.mqe`)

The Metrics Inspect page executes MQE expressions (`execExpression`) against a resolved MQE endpoint. By default that endpoint **is `queryUrl`** — the same GraphQL surface as every other query, with the same scheme and basic-auth — so most deployments never set `oap.mqe`. Set the override only when the MQE surface must be reached at a different address than `queryUrl`:

- **Both `host` and `port` set** — MQE calls go to `http://<host>:<port>` (plain HTTP), with no discovery.
- **Only one of the two set** — the missing half is discovered from the OAP admin host's configuration dump: the sharing-server REST bind when present (the OAP 11.x default layout), otherwise core's REST bind. A wildcard bind host (`0.0.0.0`, `::`) is replaced with `adminUrl`'s hostname. The combined result is plain HTTP as well.
- **Neither set (default)** — MQE calls use `queryUrl` verbatim.

The resolved target is cached for about a minute, so a hot-reloaded `oap.mqe` edit takes effect within a minute.

Env form (JSON, both fields optional): `HORIZON_OAP_MQE='{"host":"mqe.internal","port":12800}'`.

## Basic auth handling

When `auth.username` and `auth.password` are set:

- Every outbound HTTP request includes `Authorization: Basic <base64(user:pass)>`.
- The header is applied identically to `queryUrl`, `adminUrl`, and `zipkinUrl` — there is no per-port credential.
- In `horizon-wire.jsonl` (when `debugLog.enabled: true`), the header is redacted by default. See [debugLog](debug-log.md).

Production deployments should pull credentials from the environment rather than committing them to `horizon.yaml`:

```yaml
oap:
  auth:
    username: "${HORIZON_OAP_USER}"
    password: "${HORIZON_OAP_PW}"
```

## OAP capability probing

Horizon introspects selected optional GraphQL fields on first use and caches the result per BFF process lifetime. This currently provides an alarm-query fallback; it is not a general compatibility layer for every schema difference. See [OAP Version](../compatibility/oap-version.md) for the exact v10 limitations.

| Capability | Probed |
|---|---|
| `queryAlarms` (modern alarm query with server-side layer filter) | First alarms request. If missing → falls back to legacy `getAlarm` and filters client-side. |
| `getMenuItems` field set (per OAP version) | First menu request. |

The cache is per-process. After a BFF restart, the next request re-probes.

## Hot reload

Changes to any `oap.*` field are picked up on file change. The next outbound call uses the new value. **Exception**: capability cache is process-lifetime — flipping a feature on OAP that requires re-introspection needs a BFF restart.

## Common mistakes

- **`zipkinUrl` not updated for shared-port deploys.** The default `9412` is the standalone OAP. Docker images typically route Zipkin under the same port as query (`/zipkin`).
- **`adminUrl` pointing at the query port.** Admin endpoints 404 — UI surfaces "admin host unreachable". Verify the port matches OAP's `admin-server.default.port` (default 17128).
- **`auth` block present but credentials wrong.** OAP responds 401 on every query — UI shows "OAP unreachable" because Horizon does not distinguish 401 from 5xx in the banner. Check `horizon-wire.jsonl`.
