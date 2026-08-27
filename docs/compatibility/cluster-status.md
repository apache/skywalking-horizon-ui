# Cluster Status Check Sequence

The Cluster Status page (`/operate/cluster`, sidebar **Operate → Cluster**) is the operator's single pane for "is the OAP backend healthy and configured correctly?" It runs **three independent checks in parallel** — the Query and Admin OAP ports plus a Zipkin/OTLP trace-source probe — they do not block each other, and the page surfaces each pane's result independently.

The panes are independent: a healthy `:12800` with broken `:17128` is a real and recoverable state (forgot to expose the admin port behind a Kubernetes Service), and Horizon makes that diagnosis obvious. The Zipkin/OTLP pane is informational for the trace menu — a red dot there is not a cluster-wide outage.

The page header carries a single **refresh both** button that re-runs every check immediately — use it after fixing a network rule or an OAP selector instead of waiting for the next poll.

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

**Per-feature reachability probes.** Horizon checks each admin feature by firing a safe GET at the **real REST path that feature calls**, and colors the row by whether the path responds. Health is the live probe, not config-presence: a build that serves the path reads as reachable even if its config dump looks unfamiliar, and a path that 404s reads as unreachable even when the module's selector appears in the OAP config.

Every round starts with the admin host itself:

```
GET <adminUrl>/debugging/config/dump
```

If that call fails, the pane shows a red **Admin host unreachable** block with the error and the exact URL tried, and every feature row reads unreachable — one root cause, not five stacked failures. Fix the network / port exposure / `SW_ADMIN_SERVER=default` first; individual selectors are irrelevant until the host answers.

When the host answers, each feature is probed on its own path and gets its own row:

| Feature | Probe path | Gates |
|---|---|---|
| `admin-server` | `/debugging/config/dump` | Everything on the admin port — its probe is the config-dump call itself. |
| `receiver-runtime-rule` | `/runtime/rule/list` | DSL Management (catalog, editor save/load, OAL catalog), the cluster rule matrix, the Live Debugger rule picker, Inspect source attribution. |
| `dsl-debugging` | `/dsl-debugging/status` | The Live Debugger (MAL / LAL / OAL session start / poll / stop). |
| `inspect` | `/inspect/metrics` | The Inspect pages. |
| `ui-management` | `/ui-management/templates` | Dashboard templates — the layer / overview / alert / 3D template store the config surface reads and writes. |

### Row states

- **reachable** (green) — the GET got an HTTP answer other than 404 or a 5xx. An auth challenge (401) or a bad-request answer (400) still proves the route is served, so it counts as reachable.
- **unreachable** (red) — the path returned 404 (the route isn't registered: selector off, renamed, or absent in this OAP build), returned a 5xx, or failed at the network level. The pages the feature gates show a warning banner naming the env-var to set.
- **readonly · bundled** (yellow) — the `ui-management` row only, when Horizon runs with templates in readonly mode. Horizon serves its bundled dashboard templates and never calls the template store, so the path is not probed. This is informational, not a failure — but it does keep the pane badge at "4/5 reachable" instead of "all reachable".

The pane badge summarizes the rows: **all reachable**, **N/M reachable** when some rows are not live-reachable, or **unreachable** when the admin host itself is down.

### The "selector detected" footnote

Under each row's state chip there is a footnote — **selector detected** or **selector not detected** — reporting whether any key with that module's prefix appears in OAP's config dump, i.e. whether the running release advertises that selector. This is the old config-presence check, kept as an informational hint only: a custom build can be perfectly reachable with no selector detected, or advertise a selector whose endpoint still 404s. The reachable/unreachable chip is the verdict.

### Timestamps and re-checking

The pane header and each row carry a **checked … ago** stamp — when the displayed probe round actually ran. It can lag the page's own refresh slightly, because concurrent viewers share one probe round for up to 30 seconds. **refresh both** forces a fresh probe round immediately.

### Poll cadence

- Refetch interval: 60 s
- Probe rounds are shared across viewers for up to 30 s; **refresh both** bypasses the sharing

## Pane B2 — Dashboard templates

Pane B says whether the `ui-management` **endpoint answers**. This pane says what actually came back from it: how many of your templates Horizon is serving, when it last read them, and — if a read failed — what the failure said.

- **The counts** — how many layer templates, overviews, alert pages and translation overlays are being served **from OAP**. These are the templates you published, so the figures are checkable against what you pushed.
- **Loaded / next in** — how long ago Horizon last reached the store, and how many seconds until it looks again, so it is clear the cycle is still running.
- **Last error** — the message from the most recent failed read, kept only while it is still the current trouble and cleared as soon as a read succeeds. "Unreachable" alone covers a 404 from a module nobody enabled, a 401 from wrong credentials and a timeout from a slow admin port; the message tells you which.

The badge distinguishes two situations that look alike and are not:

- **stale · store unreachable** — the store cannot be read right now, but Horizon is still rendering the templates from its last successful read. Your dashboards are up; they are simply not current. A warning, not an outage.
- **unreachable** — the store cannot be read and Horizon has never read it, so there is nothing of yours to show and the template-backed pages stay empty.
- **readonly · bundled** — `templates.mode: readonly`; the store is deliberately never called, so nothing here is a fault.

See [Layer templates](../customization/layer-templates.md) for what renders in each case and why the bundled templates are never substituted.

## Pane C — Zipkin / OTLP traces

A third pane probes OAP's Zipkin v2 REST endpoint and reports reachability. It feeds only the Zipkin/OTLP trace menu — a red dot here is **not** a cluster-wide outage; the rest of the UI keeps working and only Zipkin/OTLP trace views are affected.

## Reading the page during an incident

The triage flow during "Horizon shows banners I don't understand":

1. **Is the Query pane green?** If not, OAP itself is down / unreachable — fix OAP first, the rest is downstream.
2. **Does the Admin pane say "Admin host unreachable"?** The admin port isn't answering at all — expose port 17128 and confirm `SW_ADMIN_SERVER=default`. Don't chase individual selectors yet.
3. **Admin host up but a row reads unreachable?** That one feature's endpoint isn't served — usually its selector is off. The row's Gates column says what breaks and which env-var enables it (e.g. `SW_INSPECT=default`); set it on OAP, restart, then hit **refresh both**.
4. **Is the health score `> 0`?** OAP is up but degraded — pull `details` from `checkHealth` (visible in the Query pane) and triage on the OAP side.
