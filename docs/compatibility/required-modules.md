# Required OAP Modules

Horizon UI talks to OAP through **two ports**:

- `:12800` — GraphQL query port (always required).
- `:17128` — admin REST port (required for Cluster Status, Inspect, DSL Management, Live Debugger, and — in live template mode — the dashboard-template store).

The admin-port endpoints are gated by per-module selectors on the OAP side. Horizon verifies each feature by **probing the real REST path that feature calls** and reporting per-feature reachability; the config-dump selector scan survives only as an informational "selector detected" footnote on the Cluster Status page.

OAP 10 has a separate, legacy template-management API on the query GraphQL port (`getTemplate`, `getAllTemplates`, `addTemplate`, `changeTemplate`, and `disableTemplate`). The table below describes the OAP 11 admin modules that Horizon actually consumes. Horizon does not adapt the OAP 10 GraphQL template API to its `/ui-management/templates*` client, so v10 deployments must use `templates.mode: readonly` despite having their own `ui_template` store.

## Module table

| Module | OAP env-var | Min OAP | Endpoints Horizon hits | What breaks when unreachable |
|---|---|---|---|---|
| **admin-server** | `SW_ADMIN_SERVER=default` | 11.x | `GET /debugging/config/dump` (plus it hosts every other admin endpoint) | Everything on the admin port. The admin-host check is the config-dump call itself; when it fails, every other feature reads unreachable — one root cause, not five stacked warnings (and OAP itself fails to start the other admin modules without it). |
| **receiver-runtime-rule** | `SW_RECEIVER_RUNTIME_RULE=default` | 11.x | `GET /runtime/rule/list`, `GET /runtime/rule`, `POST /runtime/rule/addOrUpdate`, `POST /runtime/rule/delete`, `GET /runtime/rule/bundled` | DSL Management page; alarm rule editor save/load; cluster-status rule matrix; Live Debugger rule picker; Inspect page source attribution. |
| **dsl-debugging** | `SW_DSL_DEBUGGING=default` | 11.x | `GET /dsl-debugging/status`, session start / poll / stop under `/dsl-debugging/*` | Live Debugger (MAL / LAL / OAL session start, poll, stop); cluster-status DSL health pane. |
| **inspect** | `SW_INSPECT=default` | 11.x | `GET /inspect/metrics`, `GET /inspect/entities`, `POST /inspect/values` | Inspect page (returns 404 from OAP). |
| **ui-management** | `SW_UI_MANAGEMENT=default` | 11.x | `/ui-management/templates*` | Dashboard templates — the layer / overview / alert / 3D template store the config surface reads and writes. Unreachable in live template mode makes the dashboard-template admin surface read-only, and Horizon keeps rendering the templates it last read successfully (see [Layer templates](../customization/layer-templates.md)); in readonly mode the store is never called. |

All five are recommended on v11. **admin-server** is non-optional for the v11 admin surface; the rest can be left off if you do not need the corresponding feature, but the Cluster Status page will surface warnings.

The entire admin-port surface (all five modules) is **OAP 11.x only**. On OAP 10.x the data-plane stack is available in readonly template mode, subject to the minor-version query-schema caveats in the compatibility matrix; the admin-port features (DSL Management, Live Debugger, Alarm Rule editor, Cluster Status → Admin pane, and Inspect) are unavailable. Horizon template sync is also unavailable because Horizon has no adapter for OAP 10's otherwise-existing GraphQL template API. See [OAP Version](oap-version.md) for the full feature-vs-version matrix.

## How Horizon checks feature state

1. Every check round starts with `GET <adminUrl>/debugging/config/dump`. If this call fails, the admin host itself is unreachable: the Cluster Status page shows one red **Admin host unreachable** block with the exact URL tried, and every feature reads unreachable. Fix the network / port exposure / `SW_ADMIN_SERVER=default` first — individual selectors are irrelevant until the host answers.
2. When the host answers, Horizon fires a safe GET at each feature's own probe path (see the table) and reports the result per feature:
   - **reachable** (green badge) — the path answered with anything other than 404 or a 5xx. Even an auth challenge (401) or a bad request (400) proves the route is served.
   - **unreachable** (red badge) — the path returned 404 (selector off, renamed, or absent in this OAP build), returned a 5xx, or failed at the network level. The pages that feature gates show a warning banner naming the env-var to set.
   - **readonly · bundled** (yellow badge) — `ui-management` only, when Horizon runs with templates in readonly mode: the template store is never called, so it is not probed. Informational, not a failure.
3. The config dump is additionally scanned for each module's key prefix; the result appears as a per-row **selector detected / selector not detected** footnote. It is informational only — reachability of the real path is the verdict, since a custom build can be reachable with no selector advertised, or advertise a selector whose endpoint 404s.

The result is exposed to the UI via `GET /api/preflight`. While the Cluster Status page is open it re-checks every 60 seconds, every row is stamped with when it was last checked, and the page's **refresh both** button forces an immediate re-check.

## Recommended OAP environment for Horizon

The minimum set:

```sh
SW_CORE_GRPC_SSL_ENABLED=false           # if applicable to your deployment
SW_ADMIN_SERVER=default
SW_RECEIVER_RUNTIME_RULE=default
SW_DSL_DEBUGGING=default
SW_INSPECT=default
SW_UI_MANAGEMENT=default
```

Without these selectors active, Horizon falls back to a "query-only" mode: dashboards and triage screens work, but the entire **Operate** section of the sidebar (Cluster, Inspect, DSL Management, Live Debugger) is degraded, and in live template mode the dashboard-template admin surface is blocked.

## Port not exposed vs selector off

A common state in Kubernetes deployments: the OAP container has `SW_INSPECT=default` but the Service does not expose port 17128. The per-feature probes tell the two failure shapes apart:

- **Whole admin host unreachable** — the initial `GET /debugging/config/dump` fails and every row reads unreachable. This is a network / port-exposure / `SW_ADMIN_SERVER` problem; the Cluster Status page shows the exact URL it tried. No individual selector will fix it.
- **Host up, one feature unreachable** — the other rows answer but one path 404s. That feature's selector is off (or the module is absent in this OAP build). Set the row's env-var, restart OAP, and use **refresh both** on the Cluster Status page to re-check.

See [Cluster Status Check Sequence](cluster-status.md) for the detailed per-pane behavior.
