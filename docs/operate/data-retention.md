# Data Retention

Path: `/operate/ttl`. Verb: `ttl:read` (granted by maintainer, operator, admin).

The Data Retention page shows how long the connected OAP keeps records and metrics. It is read-only; change retention in OAP configuration, then refresh Horizon.

## What You See

The page has two sections:

| Section | What it means |
|---|---|
| Records | Event-style data such as Normal records, traces, Zipkin traces, logs, and browser error logs. |
| Metrics | Aggregated metric tiers: minute, hour, day, and metadata when the OAP backend exposes it. |

Values are shown in days.

## Stages

Retention is reported in two stages:

- **HOT + WARM** — the default view, the collapsed value OAP returns for each data class.
- **COLD** — a separate cold-storage stage, present only on a BanyanDB backend. When the backend exposes it, the page renders a **Data lifecycle** bar; otherwise the page shows a single uniform stage and no cold pane.

On a BanyanDB backend, a **cold-stage** toggle appears in the topbar. Enabling it switches reads to cold-only, so recent windows go empty — pick an older time range when the toggle is on. `no cold stage` next to a value means the connected OAP has no cold storage stage for that data class.

## Requirements

- OAP query port reachable from Horizon.
- The logged-in user has `ttl:read`.
- OAP supports `getRecordsTTL` and `getMetricsTTL`.

If the page reports OAP unreachable, check `oap.queryUrl` and the network path to the query port.

## During Operations

Use this page before changing dashboard time windows, alert retention, or storage sizing. If a user expects old traces or metrics and Horizon cannot find them, compare the requested time range with this page first.
