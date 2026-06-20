# Cluster Status Check Sequence

The Cluster Status page (`/operate/cluster`, sidebar **Operate → Cluster**) is the operator's single pane for "is the OAP backend healthy and configured correctly?" It runs **three independent checks in parallel** — the Query and Admin OAP ports plus a Zipkin/OTLP trace-source probe — they do not block each other, and the page surfaces each pane's result independently.

The panes are independent: a healthy `:12800` with broken `:17128` is a real and recoverable state (forgot to expose the admin port behind a Kubernetes Service), and Horizon makes that diagnosis obvious. The Zipkin/OTLP pane is informational for the trace menu — a red dot there is not a cluster-wide outage.

## Pane A — Query / GraphQL port (`:12800`)

**Single GraphQL call** fired every 30 seconds:

```graphql
query {
  version
  getTimeInfo { timezone, currentTimestamp }
  checkHealth { score, details }
}
```

### What the pane shows

| Field | Source | Notes |
|---|---|---|
| Reachable | HTTP success of the GraphQL call | Hard fail → whole pane shows red banner. |
| Version | `version` | The OAP build string. |
| Server timezone | `getTimeInfo.timezone` | UTC offset like `+0800`. Used for time-range conversion throughout the UI. |
| Server timestamp | `getTimeInfo.currentTimestamp` | Epoch ms. UI shows skew vs browser clock if non-trivial. |
| Health score | `checkHealth.score` | `0` = OK, `>0` = degraded, `<0` = not started. |

### Failure modes

- **Hard fail (unreachable)**: GraphQL endpoint refused / timed out / 5xx. `reachable: false`. Whole UI shows a top-of-page "OAP unreachable" banner — query pages cannot render.
- **Soft fail (degraded)**: `score > 0` — OAP is up but degraded (storage lag, receiver backlog, internal queue depth). Shown as a yellow "degraded (score N)" chip; details from `checkHealth.details`.
- **Soft fail (not started)**: `score < 0` — OAP process is running but has not finished initialization yet. Shown as "not started"; usually transient during a rolling restart.

### Poll cadence

- Stale-time: 20 s
- Refetch interval: 30 s

## Pane B — Admin host (`:17128`)

**Single admin REST call** fired every 60 seconds:

```
GET <adminUrl>/debugging/config/dump
```

OAP returns a flat key/value map. Each required module is reported as enabled when **any** key with that module's prefix appears in the dump.

### What you see (per refresh)

If the admin host is unreachable, every module shows off and the whole pane goes red. If it is reachable, each module shows enabled or disabled independently based on whether its keys appear in the config dump:

- **`admin-server`** — when off, the admin host responded but does not expose the admin selector. The dump endpoint is itself served by admin-server, so in practice this means a custom OAP build. When admin-server is off the dump is empty, so the other three modules all show off as well — one root cause, not three stacked warnings.
- **`receiver-runtime-rule`** — when off, DSL Management, alarm rules, and the cluster rule matrix are disabled. Yellow badge.
- **`dsl-debugging`** — when off, the Live Debugger is disabled. Yellow badge.
- **`inspect`** — when off, the Inspect page is disabled. Yellow badge.

### What the pane shows

| Module | Hint shown when off |
|---|---|
| `admin-server` | "Confirm `SW_ADMIN_SERVER=default` is set on OAP and port 17128 is exposed." |
| `receiver-runtime-rule` | "Set `SW_RECEIVER_RUNTIME_RULE=default` on OAP to enable DSL Management." |
| `dsl-debugging` | "Set `SW_DSL_DEBUGGING=default` on OAP to enable the Live Debugger." |
| `inspect` | "Set `SW_INSPECT=default` on OAP to enable the Inspect page." |

### Poll cadence

- Stale-time: 30 s
- Refetch interval: 60 s

## Pane C — Zipkin / OTLP traces

A third pane probes OAP's Zipkin v2 REST endpoint and reports reachability. It feeds only the Zipkin/OTLP trace menu — a red dot here is **not** a cluster-wide outage; the rest of the UI keeps working and only Zipkin/OTLP trace views are affected.

## Reading the page during an incident

The triage flow during "Horizon shows banners I don't understand":

1. **Is the Query pane green?** If not, OAP itself is down / unreachable — fix OAP first, the rest is downstream.
2. **Is the Admin pane green?** If not, expose port 17128 and / or turn on the four selectors — see the per-module hints.
3. **Is the health score `> 0`?** OAP is up but degraded — pull `details` from `checkHealth` (visible in the Query pane) and triage on the OAP side.

