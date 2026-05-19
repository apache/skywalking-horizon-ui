# Cluster Status & Metadata

Path: `/operate/cluster`. Verb: `cluster:read` (granted by maintainer, operator, admin).

This is the operator's single pane for "is the OAP backend wired correctly?". It surfaces:

- **Live health** of the two OAP ports.
- **Required-module state** for the four admin selectors.
- **Cluster member discovery** (OAP nodes behind the configured URL).

The triage flow during a banner-heavy incident lives here. The full check sequence is documented in [Compatibility → Cluster Status Check Sequence](../compatibility/cluster-status.md); this page focuses on what the operator sees and does.

## Page anatomy

```
┌─────────────────────────────────────────────────────────────────┐
│ Cluster Status                                                  │
├─────────────────────────────────────────────────────────────────┤
│  Query (:12800)                  │  Admin (:17128)              │
│  ─────────────────────           │  ─────────────────────       │
│  Reachable  ✓                    │  Reachable  ✓                │
│  Version    11.0.0               │  admin-server         ✓      │
│  Timezone   +0800                │  receiver-runtime-rule ✓     │
│  Timestamp  2026-05-18 09:14:02  │  dsl-debugging        ✓      │
│  Health     0 (OK)               │  inspect              ✓      │
├─────────────────────────────────────────────────────────────────┤
│ Cluster members                                                 │
│ ────────────────                                                │
│  Host                Port   Role        Heartbeat                │
│  oap-1.example.com   12800  receiver    2s ago                  │
│  oap-2.example.com   12800  receiver    1s ago                  │
│  oap-3.example.com   12800  receiver    3s ago                  │
└─────────────────────────────────────────────────────────────────┘
```

## Live health (top row)

Two **independent** panes, refreshed in parallel.

### Query pane

- **Source:** `GET /api/oap/info` → BFF GraphQL call to OAP.
- **Refresh:** 30 s.
- **Fields:** reachable, version, server timezone (UTC offset), server timestamp, health score.
- **Failure modes:** see [Cluster Status Check Sequence](../compatibility/cluster-status.md#pane-a--query--graphql-port-12800).

### Admin pane

- **Source:** `GET /api/preflight` → BFF call to OAP `/debugging/config/dump`.
- **Refresh:** 60 s.
- **Per-module rows:** `admin-server`, `receiver-runtime-rule`, `dsl-debugging`, `inspect`.
- Each row carries a tooltip with the env-var needed to enable it (e.g. `SW_INSPECT=default`).
- **Failure modes:** see [Cluster Status Check Sequence](../compatibility/cluster-status.md#pane-b--admin-host-17128).

## Cluster members

- **Source:** `GET <queryUrl>/status/cluster/nodes` (status client, `packages/api-client/src/status.ts`).
- **Returns:** per-node host, port, role, last heartbeat.
- **Refresh:** Same cadence as the Query pane.

This is **informational only**. A 3-node OAP cluster behind one DNS name should show three rows. One row means the DNS resolves to a single IP (intentional in some deployments). Zero rows means OAP did not return cluster data — usually a single-node deployment without cluster module enabled, which is fine.

The cluster-members section is **not** required for Horizon to function; it is a sanity check that the operator's expectation matches reality.

## Coming soon strip

The page documents upcoming additions inline. These are not implemented today; the strip is there so operators know what's on the roadmap and what is and isn't currently surfaced:

- **Per-node module activity matrix** — module × provider × node grid. Requires per-node admin calls (currently the dump is consumed cluster-wide).
- **Storage backend health** — BanyanDB / Elasticsearch / JDBC: connection pool, index lag, throughput.
- **Receiver activity** — gRPC / HTTP / Kafka / OTLP: throughput, queue depth.
- **Effective-configuration tree** — two-node diff of merged config (advanced troubleshooting).
- **TTL & retention grid** — hot / warm / cold storage timeline per metric scope.

When these land, this page is where they will surface; the data flow will follow the same pattern as today's panes (BFF preflight call → cached → polled).

## Reading the page during an incident

1. **Both panes green?** Backend is fine; the problem is elsewhere (network from browser, BFF process, OAP-side data ingestion).
2. **Query pane red?** OAP itself is unreachable. Check the OAP process, the query port, network ACLs. Nothing in Horizon can proceed without this pane green.
3. **Query green, Admin red?** OAP is up but the admin port is not reachable. Likely causes: admin port not exposed by your Kubernetes Service, firewall rule, OAP missing `SW_ADMIN_SERVER=default`. Operate-section features (Cluster, Inspect, DSL Management, Live Debugger) are unavailable until fixed.
4. **Admin pane mostly green but one yellow?** That feature is degraded — e.g., `dsl-debugging` off means the Live Debugger doesn't work. Set the corresponding env-var on OAP and restart.
5. **Query pane shows health > 0?** OAP is up but degraded. The pane shows the score; `details` from `checkHealth` (also visible) names the degraded subsystem (storage lag, receiver backlog).
6. **Cluster members count off?** Either DNS / Service is misconfigured, or an OAP node is down. The Cluster Status page does not page or alert — it shows. Wire your own alerting on `/api/preflight` and `/api/oap/info` if you want notifications.

## Related

- [Compatibility → Cluster Status Check Sequence](../compatibility/cluster-status.md) — per-pane behavior.
- [Compatibility → Required OAP Modules](../compatibility/required-modules.md) — which modules gate which features.
- [Operate → Inspect](inspect.md) — the page that depends on the `inspect` module.
