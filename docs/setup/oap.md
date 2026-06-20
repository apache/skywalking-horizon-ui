# OAP Connection

Connectivity to the upstream Apache SkyWalking OAP cluster. Required for everything except the login page.

```yaml
oap:
  queryUrl: http://127.0.0.1:12800
  adminUrl: http://127.0.0.1:17128
  zipkinUrl: http://127.0.0.1:9412/zipkin
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
| `zipkinUrl` | URL string | `http://127.0.0.1:9412/zipkin` | no | Zipkin v2 REST endpoint. Used when a layer's `traces.source` is `zipkin` or `both`. Defaults assume the standalone Armeria binding; for Docker / shared-port deployments use `<queryUrl>/zipkin`. |
| `timeoutMs` | number | `15000` | no | Per-request HTTP timeout (milliseconds) for all OAP calls. Applies to query, admin, Zipkin. Must be positive integer. |
| `auth.username` | string | — | required if `auth` block present | Basic-auth username. Sent on every outbound OAP call. |
| `auth.password` | string | — | required if `auth` block present | Basic-auth password. Sent on every outbound OAP call. Use `${VAR}` interpolation, not a literal. |
| `mqe.host` | string | — | no | (Reserved) Override host for MQE GraphQL. When unset, Horizon discovers it via the sharing-server config dump on OAP 11.x, falling back to `queryUrl`'s host. |
| `mqe.port` | number | — | no | (Reserved) Override port for MQE GraphQL. Must be positive integer. |

## How the BFF uses each URL

| URL | Hit by |
|---|---|
| `queryUrl` | GraphQL (`version`, `getTimeInfo`, `checkHealth`, `listLayers`, `listServices`, `getMenuItems`, `listLayerLevels`, `execExpression`, alarm queries, trace queries, log queries, topology queries, profiling queries). |
| `adminUrl` | `/debugging/config/dump`, `/runtime/rule/*`, `/dsl-debugging/*`, `/inspect/metrics`, `/inspect/entities`, `/status/alarm/*`. |
| `zipkinUrl` | Zipkin v2 trace queries when a layer declares `traces.source: zipkin` or `both`. |

The two required URLs (query + admin) are independently health-checked. See [Cluster Status Check Sequence](../compatibility/cluster-status.md) for the per-pane behavior.

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

Horizon detects optional GraphQL fields via introspection on first use, then caches the result per BFF process lifetime. This is what lets Horizon run natively against OAP 11.x while still supporting v10 for triage — newer fields are picked up automatically when present, and missing fields are routed around silently.

| Capability | Probed |
|---|---|
| `queryAlarms` (modern alarm query with server-side layer filter) | First alarms request. If missing → falls back to legacy `getAlarm` and filters client-side. |
| `getMenuItems` field set (per OAP version) | First menu request. |
| MQE target (sharing-server vs core.restPort) | First MQE call. OAP 11.x default → sharing-server; v10 → `core.restPort`. |

The cache is per-process. After a BFF restart, the next request re-probes.

## Hot reload

Changes to any `oap.*` field are picked up on file change. The next outbound call uses the new value. **Exception**: capability cache is process-lifetime — flipping a feature on OAP that requires re-introspection needs a BFF restart.

## Common mistakes

- **`zipkinUrl` not updated for shared-port deploys.** The default `9412` is the standalone OAP. Docker images typically route Zipkin under the same port as query (`/zipkin`).
- **`adminUrl` pointing at the query port.** Admin endpoints 404 — UI surfaces "admin host unreachable". Verify the port matches OAP's `admin-server.default.port` (default 17128).
- **`auth` block present but credentials wrong.** OAP responds 401 on every query — UI shows "OAP unreachable" because Horizon does not distinguish 401 from 5xx in the banner. Check `horizon-wire.jsonl`.
