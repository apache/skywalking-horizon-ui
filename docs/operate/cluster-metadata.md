# Cluster Status

Path: `/operate/cluster`. Verb: `cluster:read` (granted by maintainer, operator, admin).

This is the operator's single pane for "is the OAP backend wired correctly?". It surfaces:

- **Live health** of the OAP query and admin ports.
- **Required-module state** for the four admin selectors.
- **Zipkin / OTLP trace-source reachability** for the trace menu.

The triage flow during a banner-heavy incident lives here. The full check sequence is documented in [Compatibility → Cluster Status Check Sequence](../compatibility/cluster-status.md); this page focuses on what the operator sees and does.

## Page anatomy

```
┌─────────────────────────────────────────────────────────────────┐
│ OAP cluster                                                     │
├─────────────────────────────────────────────────────────────────┤
│  Query (:12800)                  │  Admin (:17128)              │
│  ─────────────────────           │  ─────────────────────       │
│  Reachable  ✓                    │  Reachable  ✓                │
│  Version    11.0.0               │  admin-server         ✓      │
│  Timezone   +0800                │  receiver-runtime-rule ✓     │
│  Timestamp  2026-05-18 09:14:02  │  dsl-debugging        ✓      │
│  Health     0 (OK)               │  inspect              ✓      │
├─────────────────────────────────────────────────────────────────┤
│ Zipkin / OTLP traces                                            │
│ ────────────────────                                            │
│  Reachable  ✓                                                   │
└─────────────────────────────────────────────────────────────────┘
```

## Live health (top row)

The Query and Admin panes are **independent**, refreshed in parallel. A third Zipkin/OTLP pane (below) probes the trace source separately.

### Query pane

- **Refresh:** 30 s.
- **Fields:** reachable, version, server timezone (UTC offset), server timestamp, health score.
- **Failure modes:** see [Cluster Status Check Sequence](../compatibility/cluster-status.md#pane-a--query--graphql-port-12800).

### Admin pane

- **Refresh:** 60 s.
- **Per-module rows:** `admin-server`, `receiver-runtime-rule`, `dsl-debugging`, `inspect`.
- Each row carries a tooltip with the env-var needed to enable it (e.g. `SW_INSPECT=default`).
- **Failure modes:** see [Cluster Status Check Sequence](../compatibility/cluster-status.md#pane-b--admin-host-17128).

## Zipkin / OTLP traces pane

A third pane probes OAP's Zipkin v2 REST endpoint and reports reachability. It feeds only the Zipkin/OTLP trace menu — a red dot here is **not** a cluster-wide outage. The rest of the UI keeps working when this pane is red; only Zipkin/OTLP trace views are affected.

## Reading the page during an incident

1. **Both panes green?** Backend is fine; the problem is elsewhere (network from browser, BFF process, OAP-side data ingestion).
2. **Query pane red?** OAP itself is unreachable. Check the OAP process, the query port, network ACLs. Nothing in Horizon can proceed without this pane green.
3. **Query green, Admin red?** OAP is up but the admin port is not reachable. Likely causes: admin port not exposed by your Kubernetes Service, firewall rule, OAP missing `SW_ADMIN_SERVER=default`. Operate-section features (Cluster, Inspect, DSL Management, Live Debugger) are unavailable until fixed.
4. **Admin pane mostly green but one yellow?** That feature is degraded — e.g., `dsl-debugging` off means the Live Debugger doesn't work. Set the corresponding env-var on OAP and restart.
5. **Query pane shows health > 0?** OAP is up but degraded. The pane shows the score; `details` from `checkHealth` (also visible) names the degraded subsystem (storage lag, receiver backlog).

## Related

- [Compatibility → Cluster Status Check Sequence](../compatibility/cluster-status.md) — per-pane behavior.
- [Compatibility → Required OAP Modules](../compatibility/required-modules.md) — which modules gate which features.
- [Operate → Inspect](inspect.md) — the page that depends on the `inspect` module.
