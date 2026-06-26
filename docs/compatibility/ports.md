# Network Ports

Horizon talks to OAP on three ports. Two are required; one is only used if you ship traces through Zipkin.

| Port | Protocol | OAP module | Horizon usage | Required |
|---|---|---|---|---|
| **12800** | HTTP / GraphQL | `query-graphql`, `sharing-server` | All metric, alarm, trace, log, topology, profiling reads. Cluster Status → Query pane. Menu / layer enumeration. MQE execution. | **Yes.** |
| **17128** | HTTP / REST | `admin-server` and its three sub-selectors | Runtime rule list / create / update / delete. DSL debugging. Inspect API. Config dump for module-activity probe. | **Yes** (for Cluster, Inspect, DSL Management, Live Debugger pages). |
| **9412** | HTTP / Zipkin v2 REST | `query-zipkin` | Trace export endpoint when a layer is configured with `traces.source: zipkin` or `both`. Always probed for the Cluster Status → Zipkin/OTLP pane. | Functionally only when a layer's trace source is `zipkin` or `both`. |

## `horizon.yaml` configuration

```yaml
oap:
  queryUrl: http://oap.example.com:12800        # GraphQL + /status
  adminUrl: http://oap.example.com:17128        # admin REST surface
  zipkinUrl: http://oap.example.com:9412/zipkin # Zipkin v2 (optional)
  timeoutMs: 15000
```

All three URLs are **single URLs**, not lists. OAP itself handles cluster-internal fan-out:

- Query traffic is load-balanceable — any OAP node answers a GraphQL request.
- Runtime-rule writes hit one node; OAP propagates the rule cluster-wide.
- Per-node live-debug status discovers all node IPs by DNS-resolving the admin hostname and probing each.

Point each URL at a Kubernetes Service, a VIP, a DNS round-robin, or a single OAP node — Horizon is agnostic.

## Co-located vs separated ports

Two common deployment shapes:

### Standalone / dev: distinct ports

The OAP defaults. Each module binds its own port:

- `:12800` for query
- `:17128` for admin
- `:9412` for Zipkin

This is what `horizon.yaml` shows.

### Shared port (Docker / Kubernetes presets)

Some upstream deployment presets (the Docker image, certain Helm charts) configure all three behind the **same** port via Armeria's path-based routing. In that case use:

```yaml
oap:
  queryUrl: http://oap:12800
  adminUrl: http://oap:12800
  zipkinUrl: http://oap:12800/zipkin
```

The Cluster Status page does not distinguish between separated and shared port deployments — it probes each URL independently, so either shape works.

## Outbound auth

OAP query and admin endpoints can be guarded with HTTP basic auth (typical for the public demo). When set, the credentials are sent on **every** outbound call from Horizon BFF — query, admin REST, MQE execution, status checks.

```yaml
oap:
  auth:
    username: skywalking
    password: "${HORIZON_OAP_PW}"     # env-var interpolated before YAML parse
```

The credentials are **shared** across queryUrl and adminUrl; there is no per-port credential field. If your OAP deployment uses different credentials for the two ports, file an issue.

## Inbound port (Horizon BFF)

The BFF binds a single port for browser traffic:

```yaml
server:
  host: 127.0.0.1
  port: 8081
```

The UI and the BFF are served from this single port (the BFF serves the built UI's static assets from `server.staticDir` when set). There is no separate static-asset server.

For production deployment behind a TLS terminator:

- `server.host: 0.0.0.0`
- Set `session.cookieSecure: true` so session cookies are flagged `Secure`.
- Put TLS termination (Nginx, Envoy, cloud LB) in front of the BFF.

## Health probes

| Endpoint | Returns | Use case |
|---|---|---|
| `GET /api/health` | `{ status: "ok", version }` — no auth, no OAP dependency | **Recommended** container liveness / readiness probe. |
| `GET /api/oap/info` | OAP version, server timezone, current timestamp, health score, reachable bool | Authenticated, in-app reachability indicator (topbar status chip; Cluster Status → Query pane). Not a probe target. |
| `GET /api/preflight` | Per-module enabled / disabled state from the OAP config dump | Cluster Status → Admin pane; sidebar "Operate" section visibility. |
| `GET /api/auth/health` | Auth backend state (local / LDAP reachable / unreachable) | Login page chip; admin Auth Status page. |

Wire your container liveness and readiness probes to the public `GET /api/health` — it needs no auth and does not depend on OAP. Use `GET /api/auth/health` if you also want auth-backend health folded in. `GET /api/oap/info` is **auth-gated**, so an unauthenticated probe pointed at it always returns 401 and the pod never becomes Ready — use it only as an in-app reachability indicator, not a probe.
