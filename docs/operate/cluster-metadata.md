# Cluster Status

Path: `/operate/cluster`. Verb: `cluster:read` (granted by maintainer, operator, admin).

This is the operator's single pane for "is the OAP backend wired correctly?". It surfaces:

- **Live health** of the OAP query and admin ports.
- **Per-feature reachability** of the admin features Horizon depends on — each probed at the REST path it actually uses.
- **Zipkin / OTLP trace-source reachability** for the trace menu.

The triage flow during a banner-heavy incident lives here. The full check sequence is documented in [Compatibility → Cluster Status Check Sequence](../compatibility/cluster-status.md); this page focuses on what the operator sees and does.

## Page anatomy

```
┌───────────────────────────────────────────────────────────────────────┐
│ OAP cluster                                          [refresh both]   │
├───────────────────────────────────────────────────────────────────────┤
│  Query / GraphQL (:12800)                                healthy      │
│  Version 11.x  ·  Timezone UTC+8  ·  Server clock  ·  Health score 0  │
├───────────────────────────────────────────────────────────────────────┤
│  Admin host (:17128)          all reachable          checked 12s ago  │
│  Feature                 State        Probe path                      │
│  admin-server            reachable    /debugging/config/dump          │
│  receiver-runtime-rule   reachable    /runtime/rule/list              │
│  dsl-debugging           reachable    /dsl-debugging/status           │
│  inspect                 reachable    /inspect/metrics                │
│  ui-management           reachable    /ui-management/templates        │
├───────────────────────────────────────────────────────────────────────┤
│ Zipkin / OTLP traces                                     reachable    │
└───────────────────────────────────────────────────────────────────────┘
```

The **refresh both** button (top right) re-runs every check immediately — use it after fixing a network rule or an OAP selector instead of waiting for the next poll.

## Live health (top row)

The Query and Admin panes are **independent**, refreshed in parallel. A third Zipkin/OTLP pane (below) probes the trace source separately.

### Query pane

- **Refresh:** 30 s.
- **Fields:** reachable, version, server timezone (UTC offset), server timestamp, health score.
- **Failure modes:** see [Cluster Status Check Sequence](../compatibility/cluster-status.md#pane-a--query--graphql-port-12800).

### Admin pane

- **Refresh:** 60 s; **refresh both** forces an immediate re-check.
- **Per-feature rows:** `admin-server`, `receiver-runtime-rule`, `dsl-debugging`, `inspect`, `ui-management` (the dashboard-template store).
- Each row shows a state chip — **reachable** (green), **unreachable** (red), or **readonly · bundled** (yellow, `ui-management` when Horizon runs templates in readonly mode and never calls the store) — plus the REST path that was probed and a **checked … ago** stamp for when the probe actually ran.
- Under the chip, a **selector detected / selector not detected** footnote reports whether the module's selector appears in OAP's config dump. It is an informational hint only; the reachability chip is the verdict.
- The Gates column of each row says what breaks when the feature is unreachable and names the env-var that enables it on OAP (e.g. `SW_INSPECT=default`).
- The pane badge summarizes the rows: **all reachable**, **N/M reachable**, or **unreachable** when the admin host itself is down.
- **Failure modes:** see [Cluster Status Check Sequence](../compatibility/cluster-status.md#pane-b--admin-host-17128).

## Zipkin / OTLP traces pane

A third pane probes OAP's Zipkin v2 REST endpoint and reports reachability. It feeds only the Zipkin/OTLP trace menu — a red dot here is **not** a cluster-wide outage. The rest of the UI keeps working when this pane is red; only Zipkin/OTLP trace views are affected.

## Reading the page during an incident

1. **Both panes green?** Backend is fine; the problem is elsewhere (network from browser, BFF process, OAP-side data ingestion).
2. **Query pane red?** OAP itself is unreachable. Check the OAP process, the query port, network ACLs. Nothing in Horizon can proceed without this pane green.
3. **Query green, Admin pane "Admin host unreachable"?** OAP is up but the admin port is not answering. Likely causes: admin port not exposed by your Kubernetes Service, firewall rule, OAP missing `SW_ADMIN_SERVER=default`. Every feature row reads unreachable — one root cause, not five. Operate-section features (Cluster, Inspect, DSL Management, Live Debugger) are unavailable until fixed.
4. **Admin host up but one row red?** That feature's endpoint isn't served — usually its selector is off on OAP (or the module is absent in that build). The row names the env-var to set; set it, restart OAP, then hit **refresh both**.
5. **`ui-management` row yellow ("readonly · bundled")?** Expected when Horizon runs with templates in readonly mode — the template store is never called, so it is not probed. Not a failure.
6. **Query pane shows health > 0?** OAP is up but degraded. The pane shows the score; `details` from `checkHealth` (also visible) names the degraded subsystem (storage lag, receiver backlog).

## Related

- [Compatibility → Cluster Status Check Sequence](../compatibility/cluster-status.md) — per-pane behavior.
- [Compatibility → Required OAP Modules](../compatibility/required-modules.md) — which modules gate which features.
- [Operate → Inspect](inspect.md) — the page that depends on the `inspect` module.
