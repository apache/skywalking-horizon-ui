# Changelog

Notable changes to Apache SkyWalking Horizon UI, written from the operator's point of view — what's new on screen and what's now possible, not the file-by-file implementation. For per-commit detail, see the git log.

The version line is shared by every package in the monorepo (apps + shared packages) plus the BFF's `HORIZON_VERSION` default.

## 1.0.0

### AI assistant (new)

- **Ask about your system in plain language and get answers built from the real dashboard widgets — not just text.** A new floating **AI Assistant** launcher (right edge, after login) opens a chat: describe what you want to know ("what's unhealthy right now?", "investigate latency for a service") and the assistant reads **live OAP data** through the same query path the dashboards use, then streams back an ordered narrative with **inline charts, top-N lists and tables** drawn by the same widget components you see across the UI. Figures are numbered so the prose can reference them. Open it as a side drawer, expand to a full page (`/ai`), or open in a new tab; past conversations are kept locally in your browser.
- **Read-only, and it inherits your permissions.** The assistant can list layers/services, read active **alarms** (the "what's unhealthy" signal), browse the per-layer **metric catalog** (the curated MQE for each metric), drill a service down to its instances/endpoints, and render those metrics — every data tool checks the same read verb you already hold, so the assistant never sees more than you can, and it never changes configuration, rules, or dashboards.
- **It renders the real feature views inline — same components, focused on the service.** Rather than a link you open, the assistant mounts the *actual* product views inside the chat, read-only and scoped to the service: ask for **topology** and it embeds the real service map focused one hop (hex nodes, edges, RPM/latency, zoom controls); ask how a service maps across layers and it shows the real **Smartscape hierarchy** fan; ask for **traces** and it embeds the Traces view — the trace list and the span **waterfall**, with the click-a-trace → open-its-spans interaction intact — for **both** trace modes: a native SkyWalking layer embeds by service, and a **Zipkin**-tracing layer (mesh / k8s) is embedded too by first listing the Zipkin services and matching yours to a Zipkin-side name (they key on their own service universe); ask for **logs** and it embeds the layer Logs view — the stored log stream with its row → detail popout; for a browser app, ask for **browser errors** and it embeds the client-side JS error list with its row → stack-trace detail; ask for **deployment** and it embeds the real Deployment view — the instance-to-instance call graph within the service, with pan/zoom and node/edge detail; ask for **API dependencies** and it embeds the real API-dependency view — the service's busiest endpoint and its upstream/downstream dependency chain, where you can expand any node; name a **source and destination service** and it embeds the real **Instance map** — the instances of each service and the calls between them. One renderer per surface across the product, so what you see in the chat is exactly what the layer tab shows. (The layer service list still opens as a card for now.)
- **Read live Kubernetes pod logs, right in the chat.** For a k8s workload the assistant pulls a pod container's on-demand logs (the error stack) and shows the fetched lines inline as a read-only result — the same on-demand-log path as the Pod Logs tab, so nothing is stored and it inherits your `logs:read` permission. It's a result, not a console: no tail or refresh controls (operate a live tail in the Pod Logs tab); when a content filter was applied the block shows it, so an empty result reads as "nothing matched this filter" rather than a silent pod. On-demand logs are gated off by default on OAP; when they're disabled the assistant says so instead of failing. K8S (cluster/node) and K8S_SERVICE (service/pod) metrics read through the normal catalog like any other layer.
- **It can propose profiling — and only you start it.** When metrics and traces can't localise a cause, the assistant presents a **decision card** explaining what it found, why profiling would help, and what it expects to reveal; nothing runs until you **approve it in the popout**, and only if you hold the profiling permission. On approve it starts the trace-profiling task; you then ask it to analyze the results once they've collected. It never triggers anything on its own.
- **Guided root-cause analysis.** Ask "what's the root cause?" and the assistant follows built-in investigation playbooks — a master method (locate the root service → calling chain → error stack; walk the dependency topology upstream and fix a sick upstream first; a remote / Virtual_* dependency exposes only its client-side edge metric) plus latency, error-rate/SLA, saturation, middleware, **Kubernetes-workload**, and service-mesh specializations. It can also follow the **cross-layer hierarchy** from a service down into its backing infra/database layer, where memory / disk / connection causes live. Because a database / cache / MQ is a topology leaf with nothing downstream to walk, the middleware playbook now bottoms out there and pivots to its **logs + Kubernetes hierarchy (its pods' memory / disk / connection pressure) + the network edge**; the Kubernetes-workload playbook works pod restarts / OOMKilled / CrashLoopBackOff → pod logs → limits-vs-usage headroom → node pressure.
- **Bring your own LLM — vendor-neutral, and off by default.** Enable it with the new `ai:` config block (`HORIZON_AI_*`). The default transport is **OpenAI-compatible** (any OpenAI-shaped endpoint — a hosted model, a local model, or an AI gateway; set model + base URL + API key); **Amazon Bedrock** is also supported (`provider: bedrock`). The API key is a secret, env-only, redacted from logs and excluded from the audit trail. The launcher stays hidden until the feature is enabled and a usable provider is configured.
- **Both prompts are yours.** The assistant's system prompt (`ai.systemPrompt`) and the starter example chips shown in an empty chat (`ai.starters`) ship with sensible defaults and can be replaced entirely in `horizon.yaml`.
- **Starter chips can ask for a service first.** A starter that names a `<service>` (e.g. "Investigate latency for &lt;service&gt;") opens a one-field fill-in on click: type the service free-form — a partial name or a description is fine — and it's dropped into the prompt before sending. You don't have to know the exact name or its layer; the assistant matches what you typed to a real service through its own cross-layer search. Plain starters without a placeholder still send in one click. The bundled starters include these service-scoped prompts; operator-supplied `ai.starters` can use the same `<service>` / `<layer>` convention.

### Traces & logs

- **Custom time ranges on the Traces and Logs tabs now return results when your browser and the OAP server sit in different timezones.** A custom range (and the metric→trace drill's centered window) was sent as a browser-local wall-clock string that the server re-read in its own timezone — so on a UTC-container deployment the window shifted by your UTC offset and came back empty, while the rolling presets kept working. Both paths now send absolute timestamps and the server applies the OAP timezone offset, consistent with every other query surface.

### Deployment & configuration

- **Run on the bundled templates, read-only — no OAP ui_template API needed.** A new `templates.mode` setting (`HORIZON_TEMPLATES_MODE`) adds a `readonly` mode: Horizon renders every dashboard / overview / alert-page / 3D-map / translation from the **local bundle** and never calls OAP's ui_template admin API. The whole config surface goes **read-only** — the admin pages still open and show the bundled config, but editing and publishing are disabled (and the BFF rejects a write even if it's fired directly). OAP's **query** API is still used and health-checked, so metrics / traces / logs / topology work exactly as before; only the config-template store is local. Default stays `live` (seed-to-OAP, editable). The Cluster Status page shows the active mode and ui_template availability.
- **The container image runs with environment variables only — no mounted config file.** There is now **one committed, env-driven `horizon.yaml`** (the former `horizon.example.yaml` / local-copy split is gone): every field is a `${HORIZON_…:default}` token, and the image bakes that same file. So `docker run -e HORIZON_OAP_QUERY_URL=… -e HORIZON_AUTH_LOCAL_USERS='[…]' …` is enough — no `-v` mount, no repackaging. Previously `oap.*`, `auth.*`, users, LDAP, RBAC, and performance tuning were YAML-only. Lists and secrets (users, LDAP, OAP auth) are set as **single-line** JSON-string env vars; precedence is env > file > built-in default. The config file itself is the complete, self-documenting env-var reference, mirrored in the [container-image docs](docs/setup/container-image.md). Mounting your own `horizon.yaml` still works and overrides the baked one.
- **Cluster Status now reports admin-feature reachability, not just config-presence.** The admin-host pane fires a safe GET at the real REST path each feature calls on OAP — dashboard templates → `/ui-management/templates`, DSL management → `/runtime/rule/list`, live debugger → `/dsl-debugging/status`, Inspect → `/inspect/metrics` — and colors each row by whether that path actually responds. A feature whose module is loaded but whose endpoint 404s (a renamed or forked module, a selector that's on-but-broken) now reads **unreachable** instead of a misleading green; the config-dump selector check is kept only as an informational "selector detected" footnote. Dashboard templates (ui_template) join the same table as a feature — shown as "readonly · bundled" when running in `readonly` mode — each row shows how long ago it was last checked, and the page can force a fresh re-check on demand.

### General Service — PHP runtime (PHM)

- **Six instance dashboard line widgets for PHP Health Metrics** — process CPU utilization, memory used/peak, virtual memory, thread count, and open file descriptors (`meter_instance_php_*`). Each line widget uses `visibleWhen` so widgets render only when the PHP agent reports PHM data (Linux `/proc` sampling of the parent PHP process via `getppid()`).

### General Service — Node.js runtime

- **Six instance dashboard line widgets for Node.js runtime metrics** — process CPU, V8 heap used/total/limit, RSS, and external memory (`meter_instance_nodejs_*`). Each line widget uses `visibleWhen` so widgets render only when the Node.js agent reports runtime data.

### General Service — metric-to-trace drill-down

- **Removed the deprecated "Layer-scoped" widget toggle from the dashboard editor.** It emitted OAP's `scope: All` entity — deprecated in the query-protocol since OAP 9.4.0 — and no bundled dashboard used it. Any legacy stored dashboard that still carries the flag now renders at normal service scope (the unknown key is ignored). Layer-wide rollups belong on the Overview dashboards.

- **Click a latency or error point on a General-service chart to open the matching traces.** Drill-capable line widgets — Avg Response Time, Response Time Percentile, Error Rate, Apdex, Success Rate, and MQ consume latency, across the Service, Instance, and Endpoint scopes — carry a **traces** flag in their header, and their datapoints are clickable. Clicking a point opens the native Traces list in a **new browser tab**, pre-filtered to that service (and the selected instance / endpoint) and centered on the clicked bucket's time window. A latency widget opens slowest-first with a minimum trace duration of the clicked value; an error-rate / success-rate widget opens with the trace status set to Error. Throughput (Traffic) and runtime/resource widgets offer no drill — only latency and success/error metrics have a natural trace criterion. Dashboard authors enable the drill per line widget with a new **Trace drill** option in the widget editor (none / latency / error). It's config-driven and not bound to a specific layer — it works on any dashboard whose layer has native traces (the Traces component on in native or both mode), with the bundled General service widgets shipped enabled.

### Profiling

- **Profiling task creation is consistent and tells you upfront what it needs.** Across all five task types (Trace / eBPF / Network / pprof / Async) the **New Task** button enables as soon as the basic entity is chosen and always carries a tooltip, and inside the create box a missing target — no profilable processes, or no instances on the service — is shown as a clear message next to a disabled **Create** rather than a silently greyed-out button.

- **Network profiling picks its target instance in the create box and checks it has processes before you submit.** The create modal selects the instance inline and lists that instance's rover-monitored processes; if it has none, **Create** is blocked with a clear reason (OAP rejects a network task on a process-less instance) instead of failing after submit.

- **pprof and async-profiling tasks open a detail modal with their captured logs.**

- **K8S_SERVICE gains a Network Profiling tab.** Kubernetes services, already observed by SkyWalking Rover's eBPF probes, now expose Network Profiling — pick a pod and capture the process-to-process network conversations as a topology, the same capability the Mesh layer offers.

- **Profiling create dialogs are clearer and harder to misuse.** After a create the hint counts down to its single list refresh (`refreshing in Ns`), Escape closes the Async and pprof create dialogs, and Analyze stays disabled until at least one instance is selected.

- **The Async result's event-type picker shows only what the task captured.** It lists just the JFR trees the selected task's events produce (EXECUTION_SAMPLE, LOCK, OBJECT_ALLOCATION_*), dropping options like PROFILER_LIVE_OBJECT that no Horizon-created task can produce — so you can't pick a type that renders an empty graph.

### Alarms

- **The alarm timeline reads more clearly** — a clearer selection band and legend, and the detail sidebar reflows cleanly on narrow windows. Hovering the timeline now hints both affordances — click a minute to filter, or drag across the timeline to select a range — so range-selection is no longer hidden.

### Events

- **A per-service events popout on the service banner.** Every layer drill-down's service banner gains an Events button that opens a modal for that one service's lifecycle events — agent restarts, Kubernetes events, and other point-in-time records from OAP `queryEvents` — without leaving the page you're on. The service is fixed, so the view is a swimlane of **instance × time**: one row per service instance in its own color, each event a bar on a time axis (an event with no end time is an instant marker), Error events ringed red. Overlapping events on one instance stack into sub-lanes; the time axis marks the date at day boundaries; the popout owns its own window (6h / 1d / 2d plus a custom range up to 7 days) and queries at second precision.

- **Built for scale and honest about limits.** A rolling restart of a large service is one bar per instance stacked at the same moment — the granularity is the point, and a search box filters the instance rows by name for services that run hundreds of them. Scrolling is fully internal (sticky time-axis header + sticky instance column, horizontal scroll for long ranges, opened scrolled to the newest events). The newest events are fetched up to a configurable cap (200 by default); the popout shows "newest N · all in range shown" or, when the window holds more, "more available — narrow the range". Clicking a bar opens a detail panel with the instance, Started / Ended / Duration, message, and reported parameters. The button is permission-gated; viewer / maintainer / operator roles gain `events:read`. Events are lifecycle facts, not alerts — for threshold breaches, the Alarms page is unchanged.

### User experience

- **Escape closes any dismissible panel** — modals, row popouts, and the topology focus / node-filter dropdowns all dismiss on Esc.

- **Switching service clears the dependent filters** (log level / tags, browser-error category) back to a clean state, so a stale filter never silently hides the new service's data.

- **Denser Kubernetes dashboard tables** — the K8s layer's table widgets show more rows without scrolling.

- **Live debugger reads cleanly on tall and wide results.** The LAL pipeline matrix's frozen first column now stays pinned when you scroll the grid sideways (it used to drift off with the rest of the matrix), clicking a source line flashes the whole matching step row — not just its label — and the MAL / LAL / OAL debugger pages now scroll as one page for tall captures instead of trapping the result in a fixed-height inner box.

- **The LAL pipeline matrix renders Envoy access-log (ALS) and any non-generic log format.** Each cell now shows whatever fields OAP serialized for the record rather than a fixed `LogData` subset — so an `EnvoyAccessLogBuilder` snapshot displays its service / endpoint / response data where it used to render blank, a record whose raw proto input OAP couldn't serialize surfaces the reason (`jsonformat-failed …`) instead of an empty cell, and each cell names its payload class. The free-text search and the cell popout follow the same format-agnostic rendering.

- **The LAL matrix gains per-row filtering and is correct across cluster nodes.** A filter on each step row — shown only when that row has gaps — narrows the grid to the records that actually produced data for that step (e.g. just the records that emitted output), and the row counts now reflect the whole capture rather than the visible page. Each OAP node's matrix filters and column-pins independently, so acting on one node's grid no longer changes another's. Oversized cells are height-capped so one huge record can't blow out the grid, and statement-mode step labels read `function @7` rather than a raw template.

- **Inspect a LAL cell's full data and diff pipeline stages.** Every cell carries a persistent button — `VIEW` on the input row, `DIFF` on the builder rows — that opens the complete payload in a syntax-highlighted JSON viewer with the nested log `content` inlined as real JSON. For the builder snapshots a compare picker renders the captured DSL itself, with per-statement steps marked on their line and the `extractor` / `sink` block snapshots drawn as selectable ranges; picking one shows a side-by-side diff, so you can see exactly what a statement or stage changed in the built log.

### Dashboards

- **Cards can render values as colored status chips.** A card widget with `format: enum` now takes an optional chip color per value-map entry — `ok` (green), `warn` (amber), `err` (red), `info` (blue), `neutral` (grey) — and renders each matched value, or metric label, as a colored chip instead of a bare number. Set it in the layer-dashboard admin's value-map editor, next to the existing value → label mapping.

- **The Kubernetes Node Status card now reads as a status, not a number.** Instead of a raw `1`, it shows the node's active conditions as colored chips — `Ready` in green, the `*Pressure` / `NetworkUnavailable` conditions in amber/red — so node health is legible at a glance.

- **The Kubernetes Node dashboard gains a Pod Total card.** A compact card now sits directly under Node Status showing the current count of pods scheduled on the selected node (all phases) — the latest value of the same metric the "Pods on Node" trend already charts — so the space beside the status card is no longer blank.

- **Satellite event and queue widgets break out per pipeline.** The SO11Y_SATELLITE Receive Events, Fetch Events, Queue Input / Output, and Queue Used widgets now label each series by its Satellite pipeline (`tracingpipe`, `jvmpipe`, `logpipe`, …) instead of collapsing every line onto a single `all`, so you can see which collection pipeline drives the rate.

### Performance & behavior tuning

- **New `performance` section in `horizon.yaml`.** Tune how hard the BFF fans metric queries out to OAP — per-route bulk (request) sizes and concurrency for the topology, 3D-map, landing, and dashboard fan-outs — plus protective caps: the service-map render valve (`topologyMaxNodes` / `topologyMaxEdges`) and per-request record caps for traces / logs / browser logs. Operational, hot-reloaded, per-deployment; defaults match the previous built-in values, so the whole block is optional. Raise it for a beefy OAP + storage backend, lower it to protect a modest deployment; every value clamps to a hard ceiling.
- **3D-map fan-out tuning moved out of the dashboard template into `horizon.yaml`** (`performance.bulk.infra3d`). These metric concurrency / batch knobs were operational settings misplaced in a published-to-OAP dashboard template (not even surfaced in the admin editor); a stale template still carrying the old `pipeline` block is accepted and stripped on save, so a 3D config that was synced before the move converges back to `synced` after one re-push (instead of showing `diverged` forever).
- **Unified page-size pickers across the event lists.** Traces, Logs, and Browser Logs share a `20 / 30 / 50 / 100` page-size dropdown — and Browser Logs gains a picker it never had (it had a fixed 100). Each picker's max matches the server-side fetch cap in `performance.limits.maxPageSize`.
- **Node memory sizing guidance.** The container image now sets a default `NODE_OPTIONS=--max-old-space-size`, and the docs cover sizing the Node heap to your container memory limit and the in-memory source-map budget.

### Trace explorer

- **Zipkin traces now render with the full native trace experience.** The Zipkin trace detail and popout gained the KPI strip, service legend, the duration-distribution scatter (drag to filter, click to open), time-positioned waterfall bars (service · operation inside the bar, kind/status affordances), and a centered span-detail modal — matching the SkyWalking-native trace view. Zipkin annotation codes (`cr` / `cs` / `sr` / `ss` …) show an inline plain-language hint.
- **Shareable trace links are unified.** Native and Zipkin traces both open from a single `?traceId=` link under the layer's trace tab; the viewer auto-selects native vs Zipkin by the trace-ID shape, so `/layer/<layer>/trace?traceId=…` always opens the right one.
- **Trace filters are searchable, on-theme dropdowns.** The native Service / Instance / Endpoint pickers and the Zipkin Service / Remote service / Span name pickers use a dark type-to-filter dropdown that reopens correctly after a pick.

### Logs

- **Log and browser-error lists query on demand, not on every edit.** The per-layer Logs tab, cross-layer Log inspect, and the Browser Errors tab now stage condition changes and fetch only when you press **Run query** — a fresh tab shows a "Pick your conditions, then click Run query" prompt, and switching service resets to that prompt (clearing the level / tag / category filters), so the previous service's data never lingers under the new one.
- **Log inspect uses the full width.** The cross-layer Log inspect form (Target + Tags / Trace ID / Time / Limit conditions) now spans the whole page instead of sharing a two-column strip with empty space.
- **Clicking a log row opens a centered popout.** Both the cross-layer Log inspect and the per-layer Logs tab now open the same full-payload popout on row click — format-aware pretty-print (JSON pretty-printed by content type), the tags table, service / instance / endpoint / time meta, a copy button, and the trace link. Escape or the close button dismisses it.
- **Log inspect can now query Browser errors across the page.** A new **Browser** source on Log inspect (beside Raw) queries the BROWSER layer's JS error logs from anywhere — pick a browser service or type a service name (or leave it blank for all services), then narrow by category (AJAX / RESOURCE / VUE / PROMISE / JS / UNKNOWN), version, page, and time window, and read the error list (message, category, page path, app version, time, minified `line:col`). Upload and manage source maps inline, then click a row to open a popout with the error meta, the raw stack, and the source-map de-obfuscation control — resolve the minified stack back to the original frames + source snippet.
- **Tag fields autocomplete on theme.** The Tags filter on Trace inspect, Log inspect, and the per-layer Traces / Logs tabs now suggests tag keys (before `=`) and per-key values (after) in a dark, dense dropdown anchored under the field, replacing the browser's native `<datalist>` popup. On Trace / Log inspect, pressing Enter commits the current tag and starts the next, mirroring the per-layer chip tabs.
- **Log inspect can now read Kubernetes Pod logs across the page.** A new **Kubernetes Pod logs** source on Log inspect (beside Raw and Browser) tails a specific pod's container logs on demand from the K8s API through OAP — pick a Kubernetes layer, then **pick or type** a service, choose a pod and container, set a trailing window (30s … 30m) and optional keyword filters, and read the dense, read-only log lines (timestamp + content). The Layer field lists only Kubernetes-deployed layers (the ones that actually carry pods) and auto-selects the single one when there's exactly one; the pod and container auto-select when there's only one to choose, so the common single-replica case is one click. These logs are streamed live and never persisted, so there is no cold-stage. When on-demand pod-log tailing is disabled on OAP, or the pod can't be resolved, the page surfaces OAP's reason as a hint instead of an empty pane.

### Metrics Inspect

- **Inspect can now chart a "foreign" metric — one the connected OAP doesn't define.** When a metric is written into shared storage by another OAP (an older version, or a different distribution, that the OAP behind Horizon doesn't carry the analysis rule for), it never shows up in the catalog drawer. The + add metric drawer now has a **Foreign metric** tab (beside the catalog browse): type the metric name, pick its scope (Service / ServiceInstance / Endpoint / the three relations), and give its storage **value column** (default `value`) and **value type** (`LONG` / `INT` / `DOUBLE` / `LABELED`) — those last two come from the catalog of the OAP that *does* define the metric. Stage several with **+ add to list** and add them in one go — the drawer's shared footer counts the pending selection and respects the board cap, exactly like the catalog tab. Each resulting widget behaves like any other: it enumerates the entities holding data for the metric, defaults to the top one, and **plots the value series** — stepping or multi-selecting entities, switching chart type, and refetching all work. The connected OAP can't evaluate a foreign metric through normal MQE, so the values are read through its admin surface with the column + type you supplied. Marked with a `FOREIGN` pill and the value type; persists on the board across refreshes like any other widget.

### Bundled layer dashboards

- **Single-value metrics now render as cards, not flat lines, on several layer dashboards.** Widgets whose expression collapses the window to one number (a `latest(...)` total) had been mis-ported as line charts — drawn as a lone dot that misreads as a time series and shares one axis with an unrelated average trend. Each is now split into a proper single-value **card** (the total) plus a trend **line** (the average), matching the metric's shape, the way booster-ui rendered them. Affects the **Virtual GenAI** (Input / Output Tokens, Estimated Cost — provider and model scopes), **Elasticsearch** (deleted documents), **ClickHouse** (Zookeeper sessions / watches), **RabbitMQ** (connection / publisher / consumer / channel / queue totals, allocated memory), **RocketMQ** (max CommitLog disk ratio, max producer / consumer message size), and **APISIX** (etcd reachability) dashboards; every changed dashboard row still tiles to full width.

### Layer dashboard editor

- **New `tab` widget — a sized slot with named tab panels, each holding its own widgets, edited inline.** A layer dashboard widget can now be a `tab` container: a grid slot you size with span / row span, holding any number of **named tabs**, where each tab is its own little dashboard — its own set of widgets (card / line / top / record / table) in a sub-grid. Switching a tab swaps the whole set, and only the active tab's widgets are queried (lazy) — an unopened tab costs nothing, and a previously-viewed tab stays warm. Author it in the Layer dashboards admin: add a widget, set its type to `tab`, then on the tile a **segmented tab bar** switches the active panel and a per-tab **`+ widget`** drops a widget into it — you build each tab's layout **right where it sits**, no separate screen: click a widget to edit it in the drawer, drag its corner to resize it, or drag it out of the tab to move it back to the top level. Manage the tabs (add / rename / reorder / delete) from the drawer's Tabs list. The tab slot is framed by an open top/bottom rule with rounded corners so its inner widgets stay full-width. Drag a top-level widget onto a tab to move it in; a tab can't nest a tab. Useful for packing related views — traffic / latency / Apdex, or one panel per subsystem — into one dense slot.
- **`+ Add widget` now lets you pick the kind.** The add button opens a grouped menu — `Tab group` first, then the five widget kinds (card, line, top, record, table) — each with a one-line description, instead of always dropping in a card you then have to retype. The editor header stays pinned so the button is always reachable, and selecting a widget reserves a right-hand column for the edit drawer (the canvas re-shrinks to fit) with the drawer pinned in view as you scroll.
- **The widget editor pins in place beside the canvas and always opens complete.** On the Layer dashboards admin, clicking a widget — anywhere on the board, including the bottom rows — now opens the per-widget editor pinned next to the canvas and fully visible, without scrolling the page (a sticky panel used to get clipped past the bottom of a tall board, hiding the editor's top or its `Up` / `Down` / `Delete` row). The move / delete controls sit in a pinned footer, and the editor tucks away when you scroll up to the scope config above. Adding a widget scrolls the new widget into view, next to the editor that opens for it.

### Compare on a layer dashboard

- **One-click exit from comparison.** The compare bar gains a **Clear all** button that drops every locked entity — including the current one, whose chip has no per-entity × — and returns the page to the single-entity view. Previously, when your only lock was the current entity, there was no way to leave compare from the bar.

## 0.7.0

### Browser errors & source maps

- **New "Browser Logs" tab on the BROWSER layer** — lists the JS error logs the browser agent reports (message, category, page, app version, time, and the minified `line:col`), filterable by category and time window. Expanding a row shows the raw stack alongside a de-obfuscated view.
- **Source-map de-obfuscation (issue [#6784](https://github.com/apache/skywalking/issues/6784)).** Upload a `.map` file from the tab and resolve any error's minified stack back to the original source — file, line, column, symbol name, and a source snippet — by picking which map to apply. Maps are held in the BFF's **memory only** (no backend storage): they're surfaced as *temporary*, evicted least-recently-used when the configured budget is hit, and lost on restart. For durable provisioning, mount `.map` files into the server's static source-map directory (`HORIZON_SOURCEMAPS_DIR`, `/app/sourcemaps` in the image) — those reload automatically and can't be deleted from the UI. Budgets are configurable via the new `sourceMaps` block in `horizon.yaml` (per-file and total in-memory caps; defaults 64 MiB / 512 MiB). Upload/delete require the new `source-map:write` permission; viewing + resolving ride on `browser-errors:read`.

### Layers

- **Split a layer's menu by service group.** A new per-layer **Split menu by service group** toggle (Layer dashboards admin, right after **Alias**; default off) fans the layer out into one **level-0 sidebar entry per OAP `Service.group`** — the `<group>::` prefix. The entry's display name leads with the group so it reads everywhere (sidebar, page header, KPI tile) and survives narrow-sidebar truncation — e.g. `agent · General Service`. Each entry is scoped to its group: the service header + its picker, the topology map + its in-box selector, the dashboards, and the service roster all show only that group's services. A layer's group entries stay contiguous in the sidebar (sorted by group), and the cross-group view returns by turning the toggle back off (off = one combined entry holding all groups). The group value is OAP-supplied data and is shown verbatim (not translated). Travels with template export/import like every other layer setting.
- **The navigation sidebar is now resizable** — drag the divider between the sidebar and the page to widen or narrow it (double-click the divider to reset to the default width); the chosen width persists per browser. Useful when long entries — like group-split names (`agent · General Service`) or deep namespaces — would otherwise truncate.
- **The per-layer service picker shows each service's group.** When a layer has no topology-cluster naming rule, the service-list rows now surface the OAP `<group>::` prefix (e.g. `agent`) as the group chip — so the group is visible there as it already is on the topology map.
- **Every layer OAP reports now appears in the sidebar**, including ones with no Horizon template (they render with default capabilities — a plain Service page). The previous hard-coded hidden-layer list (which dropped `BanyanDB`) is gone; a layer is hidden only when an admin explicitly disables its template, or when it is listed in the new config-driven `layers.excluded` block in `horizon.yaml` (defaults: `FAAS` and `VIRTUAL_GATEWAY`; clear the list to surface every reported layer).
- **The admin Layer dashboards page is now layer-list-oriented.** It lists every available layer — not just the ones shipping a bundled JSON or living on OAP. A layer with no template yet opens on a blank default you can configure (components, metric columns, widgets, topology) and **Save**, which publishes the template to OAP on first save. No per-layer JSON has to be shipped for a layer to be configurable. The picker gains a **Not configured** filter (beside Diverged / Local) and the sync banner spells out "N templates match bundled defaults · M layers not configured yet".
- **Removed the legacy per-layer `overview` block** from every bundled layer template (and its translation overlays). It no longer rendered anything — the standalone **Overview Dashboards** replaced the old per-layer Overview tile — so it was dead config; the per-layer KPI strip is driven by the layer-header columns.

### Airflow monitoring layer (SWIP-7)

- New **Airflow** layer under **Workflow Scheduler** — service dashboard (scheduler / executor / pool KPIs and trends), Components dashboard (per-host scheduler and triggerer metrics for **Airflow 3.x** native OTel), and a 3D Infra Map load ring for **Tasks Executable**. Pairs with OAP backend SWIP-7 (`meter_airflow_*` / `meter_airflow_instance_*`).

### BanyanDB self-observability layer (SWIP-15)

- New **BanyanDB** layer under **Self-Observability**, modeling a clustered, role- and tier-aware BanyanDB deployment scraped through its FODC proxy. The cluster is one **Cluster** (service), each container is one **Container** (instance, carrying its `container_name` role and `node_type` tier as attributes), and each storage **Group** is an endpoint:
  - **Cluster** dashboard — write / query / error-rate KPIs, CPU / memory / disk capacity, a throughput + errors trend, and a **Containers by Role** table.
  - **Container** dashboard adapts to the selected container's role: every container shows CPU / memory / Go-runtime resources (and, where the system collector runs, uptime / disk / network); a **liaison** adds ingestion, query, gRPC errors, the tier-2 publish pipeline and write-queue depth; a **data** node adds storage totals, merge/compaction, inverted index, subscribe queue and retention; a **lifecycle** sidecar shows migration cycles and last-run time / status. Liaison and data panels are gated on the container's role attribute; resource panels the lifecycle sidecar doesn't emit, and the lifecycle migration panels themselves, self-gate on data presence so they surface only once that container actually reports them (the lifecycle panels stay hidden until the first migration cycle runs). This template targets the **clustered** model; a single-process standalone BanyanDB (`container_name=standalone`) shows the shared resource / Go panels but not the role-specific ingestion / storage panels — those extend to standalone once the entity-gate membership operator (SWIP-15 §6) lands.
  - **Group** dashboard — metrics split **per data-model** (measure / stream / trace / property): each model gets write rate, query latency, stored data, merge rate / latency / partitions, series write + term-search and total series, plus the type-agnostic subscribe / publish queue (throughput, p99, batch + message rate, publish bytes). Because a BanyanDB group stores one catalog, only the matching model's panels render for a given group — gated by the model's series-count flag — so a `measure` group shows the measure panels, a `property` group its index-write / merge / term-search / series panels, and so on.
  - A **Deployment** tab renders the cluster's container **inventory** — every container grouped into its node's role/tier box (liaison, data hot/warm/cold) and its pod, with per-role health metrics (liaison query rate + gRPC errors, data ingest rate + disk usage, lifecycle migration cycles + last-run status). The node health-ring legend names **each role's own** ring metric **and its colour-band thresholds** (driven by the layer template) instead of a single shared, hard-coded one. Container-to-container call **edges** carry **role-pair-specific** metrics off the SWIP-15 instance-relation families: a **liaison → data** edge shows write / query / part-sync throughput + p99 (one per queue `operation`), a **liaison → liaison** edge shows write-forward + control, and a **lifecycle → data** edge shows tier-migration volume / rate / p99. The edge prints up to **3** of the pair's metrics inline (short aliases like `W` / `R`, flowing onto one line or stacking by edge length); the selected-edge panel keeps the full client | server breakdown, and the **Flows** sub-tab tables every edge per role-pair. Edges render once the OAP build includes the `SERVICE_INSTANCE_RELATION` scope (the `migration_*` family also needs the lifecycle sidecar reporting); until then the tab shows the inventory without edges.
  - The whole deployment model — clustering / grouping rules, per-role node metrics, and role-pair edge metrics — is editable from the **Layer dashboards** admin → **Deployment** scope.
- Pairs with OAP backend SWIP-15 (`meter_banyandb_*` cluster / `meter_banyandb_instance_*` container / `meter_banyandb_endpoint_*` group). Queue-batch and lifecycle last-run panels appear once the cluster runs a BanyanDB build that emits those metrics.

### Dashboard widget value formatting

- Card widgets gain a **`enum`** format with a **value→label map**: a coded metric (e.g. a 1/0 success gauge) renders a readable label (`1 → OK`, `0 → Failed`) instead of the raw number. Labels are **translatable per locale** (BFF-side template i18n overlay) and the map is editable in the Layer dashboards admin. BanyanDB's lifecycle **Last Sync** card uses it.
- New **`duration`** format renders a SECONDS metric as a human time-ago (`5m 20s ago`; compact `5m` / `2h` on axes) — used by BanyanDB's **Time Since Last Sync** card.

### Record widgets — jump to trace & copy

- **Record widgets now drill into the originating trace.** Each sampled row gets a **jump-to-trace icon** at the row head — shown only when the sample actually carries a trace id (these are sampled, so it can be absent) — that opens the trace waterfall in the global popout. It resolves the trace **by id, not by layer**, so it works even though the trace belongs to the calling service on a different layer (a virtual-target layer has no traces tab of its own). The statement text itself is **click-to-copy**. For example, the **Slow Statements** record widget on a Virtual Database / Cache / MQ service.

### Instance-list badge

- The badge on each row of the **instance list** (Containers / Pods / Nodes / …) is now **configurable per layer** (`instances.badge` on the layer template) — it can show any instance **attribute** instead of the fixed agent `language`. BanyanDB shows `container_name` (**liaison / data / lifecycle**), the role that actually distinguishes a container; agent-traced layers keep `language` (Java / Go / …). The badge is now **hidden when the value is empty or `UNKNOWN`**, so OpenTelemetry-scraped layers (which report no agent language) drop the meaningless `UNKNOWN` chip across the board.

### Dashboard widget visibility

- Layer-dashboard widgets gain a structured **Visible when** gate (Layer dashboards admin → widget drawer) so a widget only renders when it's relevant to the selected entity. Two kinds:
  - **MQE metric** — show the widget only when an expression *has value*, or when any value is **>** / **<** a threshold. Naming the widget's *own* metric self-gates it (the JVM widgets appear only on JVM instances, the MQ widgets only on MQ producers, …); naming a *different* metric gates a whole group on one shared signal — that metric is checked once and the entire group's queries are **skipped** when it's empty, so e.g. a non-JVM instance no longer runs the JVM widget queries at all.
  - **Entity attribute** — on the Instance scope, gate on the selected instance's attributes, e.g. *language equals JAVA* (case-insensitive) or an attribute simply being present. Service / Endpoint entities carry no attributes, so entity gates are ignored on those scopes.
- Gates are evaluated server-side; gated-out widgets just don't appear in the grid. **Note:** a layer dashboard saved before this release that used the old free-text predicate loses its gate (the widget renders ungated) until you re-set the gate in the new editor and save the dashboard.

### Topology node filter & component icons

- The per-layer **Topology** map (and the embedded topology widget on the Services / Mesh overview dashboards) gains a **Filter** control to hide the conjectured peers that clutter a dense map. One auto-derived facet — by **layer**, presented exactly as the sidebar shows it: each row carries the layer's own icon and its localized display name (*General Service*, *Virtual Database*, *Java Agent*, …), plus an **Others** bucket for nodes OAP couldn't resolve, alongside a standalone **User** toggle. The layer rows self-populate from whatever the map currently shows and re-derive on every refresh / depth / time change. Unchecking a row hides those nodes and their now-dangling edges; the **Others** bucket is where uninstrumented "undefined" peers (e.g. a bare `rcmd:80`) land, so one click clears them, while your real databases / queues / caches — separated by their own `VIRTUAL_*` layer rows — stay on the map. Filtering is client-side and defaults to showing everything.
- **Technology component icons on the nodes.** Service-map nodes now render the icon for their detected component — the same icon set the trace waterfall uses, so a PostgreSQL node looks like PostgreSQL — falling back to the generic service / external / user glyph when the component ships no icon or couldn't be resolved.
- The topology's **service selector** (the "All services" picker) now **groups its list by service group** — OAP's `Service.group` (the `<group>::` prefix, e.g. `agent`) shown under a value-first `<name> [GROUP]` header — so a layer whose services share a group reads grouped instead of as one flat list. This is a per-service attribute and needs no per-layer naming-rule setup; services with no group stay in a single header-less section. Clicking a group header **batch-selects or unselects every service in that group** — the header carries a filled / half / hollow marker for all / some / none of its services focused.

### Instance topology

- The per-layer **Topology** map gains an **instance map** drill-down on layers that enable instance topology. Click a call between two services and then **Instance map →** to open it: the instances of each service as two columns (left = client, right = server) with the instance-level calls between them — pan/zoom, animated client→server flow, the same node health-ring + per-call client/server metric sidebar the service map uses, and a node popover with **Open instance dashboard**. A back button returns to the service map; a toolbar pair-picker swaps the two services. The two service pickers are **relationship-aware**, drawn from the service-topology call graph (including conjectured / cross-layer callees like `rcmd:80`, named the same as on the service map): the server list is the chosen client's callees and the client list is the chosen server's callers, each re-deriving when the other changes without resetting your current pick. A side the graph leaves no real choice for (e.g. a single caller) shows as plain text instead of a one-option dropdown. Each service's instances sit inside a labelled grouping box — named with the service, using the same `<group>::` prefix handling as the service map so a name reads identically on both — and a ring-colour legend explains what the node health bands (green → red) mean for the configured ring metric. Labels follow the layer's own terms (e.g. *Pods* on Kubernetes, *Sidecars* on the data plane).
- **Configurable like the service map.** The Layer-dashboards admin → **Topology** scope now has an **Enable instance topology** toggle and its own node / server-edge / client-edge metric editors, kept visually separate from the service-topology metrics so the two are never confused. Enabled out of the box on **General**, **Service Mesh**, **Kubernetes Service**, and **Cilium Service**; the config rides each layer's topology template (so it travels with template export/import).
- When OAP's template store is unreachable, the instance map now shows the same empty + connectivity-banner state as the service map, rather than a misleading "not supported" — block and unsupported are no longer conflated.
- **Localized across all eight UI languages.** The instance-map UI, the template-store-unreachable banner, and the remaining alarm / live-debugger strings are now translated in zh-CN, ja, ko, es, pt, de and fr (English stays the source) — no feature renders English-only for non-English operators.

### Lock & compare entities on a layer dashboard

- **Lock several services, instances, or endpoints — including ones from different services — and compare them in place.** Compare is standard on every service / instance / endpoint layer dashboard — no flag, nothing to enable. Pin entities from the service picker or the instance / endpoint list; instance and endpoint pins are cross-service, so instances belonging to different services can be compared side by side. A persistent, scope-aware **comparison bar** shows the cohort regardless of how the underlying list paginates or which entity is currently selected.
- **The entity you're viewing is always part of the comparison** — it appears first, tagged `CURRENT` in the accent color (and still drives the header KPIs); pinned entities add to it, each in its own stable hue (up to six pins). The comparison-bar chips are display-only: clicking a chip never changes what you're viewing (no disruptive reload) and `×` unpins — switch the focused entity from the top selector / list as usual.
- **Each widget compares inline in its own tile** — line widgets overlay one hued series per entity; card widgets show one row per entity; top-N and record widgets get per-entity tabs plus a merged "All" tab; table widgets gain an **Entity** column that groups rows by entity and folds each entity's long tail into one `(others)` row (summed for counts, count-only for latencies / percentiles where a sum would mislead). With nothing locked, every page renders exactly as before.
- **Labeled series lead with the meaningful dimension** — a multi-label series reads `<label> · <service> · <instance>` so the label (e.g. a JVM thread state) survives when a long instance / endpoint id has to truncate; entities stay distinguishable by color. A widget that only some compared entities expose (e.g. JVM widgets when a Java service is pinned alongside a non-JVM one) shows whenever *any* compared entity has it.
- **Progressive, per-entity loading** — each entity loads as its own request; tiles fill in as entities arrive and one slow or failed entity never blanks the others.
- The Topology, Deployment, trace, and log pages are unaffected — comparison applies to the service / instance / endpoint dashboards only.
- **Widget tooltips and legends show the widget title, never the raw MQE expression**, for un-labeled single-series line widgets; the multi-series tooltip is a fixed, aligned table — the entity name truncates and the values form one clean right-aligned column with the unit in the header.

### Charts & bundled metrics

- **Large numbers on chart axes and tooltips now use compact SI suffixes** (`45.1k`, `1.34M`, `2.5G`) instead of scientific notation (`4.51e4`), which operators found hard to read.
- **Go runtime "Metadata Mspan" and "Metadata Mcache" widgets now report KB**, fixing values that were displayed as a mislabeled "MB" of raw bytes (≈1000× too large) — they now read in the same KB scale as the other Go metadata-size widgets.

### Deployment

- New per-layer **Deployment** tab — the **deployment topology of all of a service's instances**: the instance-to-instance call graph **within a single service**. Where the instance map drills into the instances *between* two services, this shows how one service's own instances are deployed and talk to each other (e.g. a clustered store's nodes calling each other). Pick a service from the layer's Service header and the tab draws its instances as health-ring nodes with the intra-service calls between them — pan/zoom, animated edge flow, the per-call client/server metric sidebar, and a node popover that shows the instance's attributes and an **Open instance dashboard** link. Self-calls and back-and-forth pairs are drawn distinctly.
- **Node clustering.** Instances can group into labelled boxes by a single **instance attribute** (e.g. role / tier), by **several attributes** combined into one key (e.g. `node_role` + `node_type`, where an attribute absent on a node drops out — so a BanyanDB cluster splits its data nodes into hot / warm / cold boxes while the liaison nodes, which carry no tier, stay one box), or by a **name regex** run on the instance name — so a fleet of mixed-role nodes reads as one box per role instead of a flat cloud. The boxes lay out left→right along the calls between them, so an upstream→downstream chain reads in order.
- **Optional + configurable.** Off by default for every layer; a layer opts in from the Layer-dashboards admin → **Deployment** scope, which has its own node / server-edge / client-edge metric editors (instance scope) plus the clustering-rule picker. The config is a self-contained block on the layer template, so it travels with template export/import and is independent of the service-map topology config.
- **Pod / sibling model.** Instances render as **hexagons** and can bundle into pods: a pod's **main** container is a full hex with its **sibling** containers attached as smaller hexes around its edges. Three independent rules drive it — **cluster** (the dashed boxes), **sibling** (which containers form one pod), and **role** (per-container-type metrics + which container is the main). Edges resolve to the exact container, so cross-pod sidecar links (e.g. a lifecycle agent calling its peer in another pod) connect the small hexes. The model can be previewed before real data exists via the admin's draft **Preview** flow — edit the Deployment scope and preview the live page without publishing.
- **Tiered layout + draggable pods.** Each cluster box lays its pods out by call depth — sources on the left, the pods they call to the right — so a hot → warm → cold lifecycle chain reads as left-to-right tiers. Pods stack vertically within a tier, and a tier with more than four pods wraps into additional stacked columns of four. Drag any pod to rearrange; its cluster box re-flows to keep every node enclosed.
- **Role-to-role edge metrics + a Flows view.** Deployment edge metrics are keyed by the **(source-role → target-role)** pair, so each kind of link shows its own metrics rather than one flat set — a `liaison → data` edge can surface write / query / part-sync throughput while a `lifecycle → data` edge surfaces migration volume. Pairs match most-specific-first with a `*` wildcard fallback. Each pair names a **primary** metric that prints **inline on the edge** in the map, so the headline number reads at a glance without opening anything; the selected-edge sidebar shows that pair's full metric set. A new **Flows** sub-tab (next to Topology) lays the edges out as **one aligned table per role-pair** — click a row to jump to that edge in the graph.

### API dependency

- The per-layer **API dependency** tab renders an endpoint's caller → callee chain as a graph. Pick an endpoint and it lays out in columns by direction — callers on the left, the focus endpoint in the centre, callees on the right — with the same node health-ring border, SLA-coloured RPM, and latency you read on the service map; edges animate the call direction and label the heaviest by RPM.
- **Expand to walk the chain.** A selected endpoint shows a single **+** handle that pulls in *its* own callers and callees in one click (new callers land left, callees right). The handle spins while the dependency query is in flight; when an endpoint is a leaf with nothing further to load it fades and a brief banner says so — a silent "nothing happened" never reads as a bug.
- **Rearrange freely.** Drag any node box to pull a dense graph apart — edges follow live. Pan, wheel-zoom, and a fit button act on the whole canvas, and a node holds a steady on-screen size whether or not the detail sidebar is open.
- **Drill straight out, in a new tab.** The node detail's **Open endpoint** and **Service →**, and the service-map node/edge jumps (**Open service**, **API map →**, **Instance map →**), now open in a new browser tab — so you keep the graph you're exploring while the drill-down opens alongside it.
- Nodes share the service-map's visual vocabulary (SLA-band border, an agent badge on instrumented endpoints, the focus star), and the tab is localized across all eight UI languages.

### Dashboard template portability

- Every template admin page — Overview templates, Layer dashboards, and the 3D-map config — now has **Export** and **Import** actions. Export downloads the *in-use* version (what end users render: the version live on OAP, or the bundled default when OAP has none) as a JSON file, for backup, sharing, or moving a dashboard to another OAP. Import reads a JSON file, validates it, and loads it as a local draft in this browser — preview it, then publish with “Check diff & push” as usual. Importing never writes OAP directly. Overview import can recreate a deleted dashboard or seed a brand-new one; layer import targets a layer already present on this deployment.
- The **Translations** page has matching **Export** / **Import**, scoped to the current language: export the in-use translation for a template + locale as a JSON file, or import one as a local draft to review and push. (Source templates and their translations are edited on separate pages, so their import/export are separate too — each on its own page.)

### Template store reliability

- **Runtime config is strictly what's on OAP.** Layer dashboards, overviews, and topology now render only the version published to OAP's UI-template store (or the in-code minimal default for a layer that has none). The disk-bundled templates reach a running UI **only** by being synced to OAP (first boot / admin reset) or through the admin **Preview** button — they are never a silent live fallback. So an operator always sees the live published config, not a stale bundled copy masquerading as current.
- **Unreachable template store is a visible block, not a quiet fallback.** When OAP's UI-template host can't be reached, a banner (same red treatment as the OAP-query-unreachable strip) reports it, and the dashboard / overview / topology surfaces stay empty rather than back-filling bundled defaults that could be read as real. The sidebar still navigates so the rest of the app is reachable.
- The admin **Preview** button now drives **every** template-rendered page — the **overview detail** view and the per-layer **topology** (incl. the **instance map**), **API dependency**, **traces**, and **network-profiling** pages — not just the layer dashboards. Previewing renders the draft's metrics/config against live OAP, so an edit to topology or dependency metrics is visible before you publish. Preview and the absent-remote path stay strictly separate: a draft renders only in `?mode=preview`; normal reads never carry one.
- **Editors no longer silently fall back to the bundled default.** When a layer / overview / translation has no version published to OAP, the editor shows a *"No published version on OAP"* panel instead of quietly loading the shipped bundled copy as if it were live. Bundled now reaches the editor only when you click **Reset to bundled** — matching the runtime, which renders the published version or blocks, never the bundle.

### Layer landing & service list

- **The layer landing now shows your services, not just an arbitrary 25.** It used to cap the metric fan-out at the first 25 services *by list order* — so larger layers hid the rest, and the "top" services weren't even the true top (the cap happened before the ranking). Now it probes **all** services up to a configurable cap and, when a layer exceeds it, runs a cheap single- metric ranking pass to pick the **true top-N** by the landing's order-by column. The service picker surfaces **"top N of M"** so the trim is never silent. Queries drain through a bounded-concurrency pool, so a big layer fans out in controlled waves rather than a thundering herd.
- New `query.landingServiceCap` in `horizon.yaml` (default **100**) tunes how many services a landing probes per request — raise it if your OAP + storage can take the larger fan-out, lower it to protect a modest deployment.
- **The service picker now lists the *whole* layer, not only the metric-probed top-N.** Services that ranked below the metric cap on the order-by column now appear as their own rows with **`low`** in that column (and `—` for the others, which were never probed) instead of being hidden — every service stays browsable, searchable, and selectable regardless of the cap. The header chip reads **"metrics: top N"** to make the metric trim explicit.
- **Removed the stale "Landing KPI tile" controls** (Headline / Trend line) from the Layer-dashboards admin. They no longer matched the rendered layer header — which shows every configured metric column as its own KPI with its own trend line — so editing them changed nothing on screen. The header is driven entirely by the service-list columns + default sort; the preview now reflects that.
- **Selecting a low-traffic (below-cap) service now works on *every* tab**, not just the dashboard. Logs, traces, and endpoint-dependency resolved the picked service's name from the landing sample only — so a tail service queried as blank (and Logs even snapped the pick back to the top service). All per-layer tabs now resolve the name from the full roster, so a `low` service drills in everywhere.
- **Profiling scopes no longer show an editor grid that goes nowhere.** Trace / eBPF / async profiling are built-in runtime views with nothing to author, so the admin now shows a "configured at runtime" note for them instead of a widget grid whose widgets never rendered.

### Access control & permissions

- The **Roles & Permissions** board now lists `infra-3d:read` — the permission to view the **3D Infrastructure Map** — under the data-catalog group, with a matching "3D infrastructure map" row in the menu-visibility matrix. It was already enforced and granted to every built-in role (viewer and up), but it never appeared on the board, so an admin couldn't see who held it.
- Editing a **layer dashboard template** is now gated on the `dashboard:write` permission the editor already advertises; publishing overview, alert, and 3D-map configs stays on `overview:write`. The required permission is resolved per template kind at save time. Built-in roles are unaffected (`operator` and `admin` hold both), but a custom role granted only `dashboard:write` can now save layer dashboards.
- The **Cluster Status debug view** (`/api/debug/status`) now requires only `live-debug:read`. It previously also demanded `cluster:read`, so a role granted live-debug access but not cluster-read was wrongly blocked.
- Saving a **local draft** of a template (the "Save local" action) now enforces the same per-kind permission as publishing — a layer draft needs `dashboard:write`, other kinds `overview:write` — instead of a blanket `overview:write`.

### Performance hardening

- **Layer dashboards skip a redundant service lookup on every load.** The dashboard route used to issue its own `listServices` to auto-pick the service and carry its entity-scope flags; it now reads the shared per-layer service catalog the sidebar already keeps warm, so a dashboard's first paint costs one fewer OAP round-trip in the common case. It still falls back to a live lookup for a just-registered service, a cold snapshot, or to surface an OAP outage (the "OAP unreachable" state now follows the actual widget fetch, so a warm cache can't mask a backend that's gone away).
- **The alarms list and count fire their two startup probes in parallel.** The server-time offset and backend-capability probes that precede every alarms query now run concurrently instead of one-after-the-other.
- **The 3D Infra Map loads its metrics in parallel.** Per-node metric values used to fetch one batch at a time; they now load in bounded-concurrency batches, so the load rings and traffic values fill in sooner on large layers. A new `metricConcurrency` setting in the Infra Map config (default 4) caps how many metric batches run at once.
- **Oversized layer topologies fail with a clear message instead of an unreadable map.** When a layer's service graph exceeds the render ceiling (5,000 services or 15,000 calls), the service map shows a "Topology too large to render" notice with the live counts and a hint to pick a specific service or lower the depth, rather than attempting to lay out a graph too dense to read.
- **Partial metric-load failures are now surfaced on every topology map.** If some metric batches fail to load (a transient OAP error) on the service map, instance topology, deployment, or endpoint-dependency map, a banner now explains that blank values may be unavailable rather than zero — and on the endpoint-dependency map, that some endpoints or links may be missing — so a backend hiccup isn't misread as real "no traffic" data.

### Fixes

- **Metrics Inspect** — the crosshair value tooltip is no longer clipped behind the navigation sidebar when you hover near a widget's left edge; it now renders above the page chrome.
- **3D Infrastructure Map config** — "Check diff & push" now requires saving a local draft first (it was selectable while edits were still unsaved), and the push dialog renders the side-by-side before/after JSON diff instead of an empty panel.
- **The API-dependency tab now honors the topbar time picker.** It was pinned to the last hour regardless of the selected range; changing the range (and expanding a node) now re-queries the chosen window, like the service map and instance map already did.
- **A dashboard no longer blanks entirely when one metric group fails.** A transient backend error (timeout / 5xx / query-complexity limit) on a single batch of widgets now marks only those widgets as failed; the rest of the dashboard renders normally instead of every cell going blank.
- **Trace list rows pick the correct root span on BanyanDB.** A multi-service trace could surface a downstream span's endpoint / duration / start time in the list; the row now reliably reflects the trace's true entry span.
- **Correct timestamps right after repointing OAP.** The server-timezone offset is now cached per OAP URL, so a configuration reload that switches to a different-timezone OAP re-probes immediately instead of serving the previous server's offset for up to a minute.
- **Baseline security response headers** (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`) are now sent on every response.
- Removed an internal `?mockTop=` debug query parameter that padded top-N widgets with synthetic rows; it no longer ships in release builds.
- **The profiling pages now use more of the page height.** The Trace / eBPF / Async / pprof / network profiling layouts were sized off a viewport offset that over-counted the chrome above them, leaving dead space at the bottom on taller screens; they now extend closer to the bottom of the view.
- **Overview dashboard templates are validated before save.** A malformed overview (missing a required field, an unknown widget type) is now rejected with a clear field-level error instead of being written to OAP — restoring a guard that was lost when overview editing moved to the OAP-backed save path.

### Documentation & release tooling

- A further accuracy pass corrected the Cluster Status page (three panes — Query, Admin, Zipkin/OTLP — and no per-node member list), the Kubernetes readiness-probe guidance (point it at the public `/api/health`, not the authenticated `/api/oap/info`), the layer-template `components` default (only the service dashboard is on when a key is omitted) and the `aliases` authoring key, the removed `visibleWhen` free-text and embedded-i18n template shapes, and the data-retention cold-stage controls.
- The website docs were brought current with the 0.6.0 build and the configuration pages restructured around the admin UI — the JSON shape is now a reference appendix, not an authoring surface (these admin pages are structured editors, not raw-JSON editors). Accuracy fixes span the RBAC verbs (incl. `infra-3d:read`), the audit-log action set, the Metrics Inspect API paths, the layer-template component flags, and the redesigned 3D-map config + loading stages. A new `docs/CLAUDE.md` records the doc-writing principles, and the i18n docs gain a language × scope coverage matrix plus a translation step in the add-a-layer recipe.
- The container image is published to Docker Hub by CI on every `v*` tag; the post-vote finalize script now only verifies the published tags (the manual local-push fallback and Docker Hub login preflight were removed).

### Layer drill-down fixes

- The per-layer **Instance** and **Endpoint** pages now honor the layer's configured aliases in their section headers and in the service-picker's name column — e.g. ActiveMQ reads **Brokers** / **Destinations** and Virtual MQ reads **Topics** / **MQ clusters**, matching the sidebar — instead of the generic "Instance" / "Endpoint" / "Service" labels. Layers that define no alias still read the generic words.
- A layer's Instance or Endpoint page no longer hangs on a perpetual "Reading data…" when the selected service reports no instances or endpoints (or a search matches nothing). It now shows the empty picker and renders the metric widgets in their normal "no data" state, so the layout stays visible and ready for services that do report them.
- **Clearer cluster boundaries on every topology view.** The dashed grouping boxes — namespaces on the service map, per-service boxes on the instance map, role/tier clusters on the Deployment tab — now draw with a bolder, brighter dashed border and a fully transparent background, so the boundary reads clearly on every theme (light themes included) instead of fading into the canvas. The Deployment tab also packs its cluster boxes evenly: boxes sit at a uniform spacing with no dead corridor between tiers and no blank strip before the first box.

### Live debugger

- **MAL sample groups.** A captured step that fans out to many samples no longer dumps every label set on screen: the samples are grouped by metric name into a one-line summary — `<metric> · N samples · values=…` — and you expand only the groups you care about to see each sample's full labels. Groups are collapsed by default.
- **Diff is the default when a group is expanded.** A multi-sample group opens straight into diff view: the labels shared by every sample collapse into a dimmed "common" block and only the labels that differ are highlighted per sample — so it is immediate which label distinguishes each one (e.g. `node_role` / `pod_name`) and what value it maps to. A **diff** toggle beside the group's header switches back to the full per-sample label list. The "common" set is computed across the whole group, not just the rendered rows.
- **Multiple output entities collapse the same way.** When a record materialises one metric for several entities (e.g. a per-endpoint write rate over `sw_metricsMinute` / `sw_metricsHour` / `sw_metricsDay`), the repeated meter cards fold into one block: a shared header (metric / function / time bucket), a `N outputs · values=…` summary, and a diff that surfaces only the entity fields that actually differ — whichever they are, not a fixed field — with each output's value beside it.
- **Readable sample values.** Long fractional values from `rate()` / `avg()` (e.g. `57.0333333333…`) are trimmed to a few significant digits for display so they stop overflowing the value column; integer counters still render exact, and the precise value stays available on hover.

### DSL management — live apply progress & recovery

- **A structural rule change now shows live apply progress.** Saving an edit that moves a metric's storage shape (scope, downsampling, or the metric set) no longer just flashes "submitted" — the editor tracks the apply across the cluster through a phase stepper (Compiled → Confirming across the cluster → Committing → Done) and reports success only once OAP confirms the change is durable. **Revert to bundled** (also a schema change) goes through the same stepper. Body- and filter-only edits still apply instantly with no stepper. You can navigate away mid-apply; reloading the editor resumes the progress.
- **"Applied — cluster propagation unconfirmed" is a warning, not an error.** When a structural change is committed and durable but one or more nodes hadn't confirmed the new schema within OAP's fence budget, the editor names the lagging nodes and explains they self-converge on their next scan — the rule is applied, not rolled back. Reloading the editor reads it back as applied (from the stored rule).
- **A failed apply is called out as rolled back** — the cluster stays on the previous rule, the failure reason is shown inline, and your edit is kept in the editor so you can fix and save again. A compile error now surfaces as an inline diagnostic under the editor instead of a transient toast.
- **Force re-apply to recover.** A degraded or transiently-failed apply offers a one-click **Force re-apply (recover)** that re-runs the apply across the cluster to re-confirm the schema and un-stick any waiting node — gated behind a confirm that spells out it briefly pauses collection for that rule's metrics, even when the content is unchanged. This subsumes the old Advanced `force` toggle for the recovery case.

## 0.6.0

This release is the production-readiness pass for Horizon UI: every page now renders correctly across the eight supported languages on non-UTC OAP deployments, with deliberate caps and validation on the load surfaces that operators reach. The pillars below describe the operator- visible result.

### Eight-locale internationalization

Horizon now ships with eight first-class UI languages — English (source) plus zh-CN, ja, ko, es, pt, de, fr — selectable from the top-bar locale chip on every page (including the pre-auth login). The choice persists per device.

- **UI chrome.** Every routed page and every shared sub-component renders through `vue-i18n`; non-English locales now cover every admin page (Roles, Users, Auth status, Alert page setup, Global defaults, 3D-map config), every operate page (Alerting rules, DSL catalog / editor / dump, OAL catalog, Live debugger + MAL / LAL / OAL, Capture history, Metrics inspect, OAP config, TTL), the alarms surface, and the shared modals. Long lede paragraphs that previously rendered as `English | one translated word | English` mid-sentence are now single translation units — inline `<code>` and links interpolate without splitting the prose. Missing leaves still fall back to English so partial catalogs degrade invisibly.
- **BFF-shipped templates.** All 42 layer dashboards and both overview dashboards carry per-locale overlay catalogs alongside the source template. Coverage is ~2,300 translatable leaves per non-English locale across the layer set. The BFF picks the locale from the request's `X-Horizon-Locale` header (auto-set by the SPA), merges the overlay onto the source, and serves the localised template to the renderer — translation resolves once on the BFF, never on every chart mount.
- **Operator-runnable Translations page.** A new admin surface (Dashboard setup → Translations) edits the per-locale overlays through the live preview: pick a target language, click any widget in the rendered dashboard, type the translation. Per-locale status chips on the template picker show at a glance which dashboards have drafts, which are synced, which diverge from disk, and which are empty for a given locale. Push writes the sibling overlay row on OAP; pushing zh-CN never touches ja.
- **Tech-term policy.** Product, project, and protocol names (SkyWalking, Kubernetes, OAP, MQE, eBPF, Zipkin, OpenTelemetry, Istio, GraphQL, etc.), OAP scope enums (Service, ServiceInstance, Endpoint, Process), layer keys, MQE function names, env vars, HTTP status codes, and per-language runtimes (JVM, Go, Python, …) stay verbatim in every locale per CLAUDE.md. Phrases containing tech terms are translated around the term (`HTTP Connections` → `HTTP 连接` / `HTTP 接続`), not transliterated.
- **OAP-supplied data is never translated.** Service names, alarm rule names, trace span operation names, log messages — anything arriving over the OAP wire — render verbatim regardless of locale.
- **Validator gate.** `i18n:validate` is stricter: every source template must have a sibling overlay file per advertised locale, and empty `{}` overlays are now a finding (used to pass silently — surfaced as "structurally complete" while every translatable string still rendered in English).

### Typography + self-hosted fonts

- **Inter + JetBrains Mono are now self-hosted.** The Google Fonts CDN dependency is gone — air-gapped or firewalled deployments render the intended typography instead of silently falling back to system fonts.
- **One typescale across every page.** Older admin pages that drifted to a mixed pixel palette (9.5 / 10 / 10.5 / 11 / 11.5 / 12 / 14 / 18 / 20 / 22) now share the same six-step scale + uppercase-label vocabulary as the newer dashboards. Sidebar, kpi labels, table headers, kickers all line up.

### Wire-correctness on non-UTC OAP

Every BFF query route now spells `Duration.start` / `end` in the OAP server's timezone (probed once per minute, cached). Previously only the alarms route did this; dashboards / landing / topology / endpoint / endpoint-dependency / instance / eBPF / traces / logs / trace-tag all emitted UTC, which silently shifted every query on non-UTC OAP installs by the server's offset.

Traces and logs additionally query at SECOND precision now (records, not metric buckets) — a trace that just finished falls inside the window instead of getting rounded off the MINUTE boundary.

### Performance hardening

- **Landing batches no longer 5xx on wide layers.** The per-layer landing route used to build one GraphQL with up to 250 aliased fragments (25 services × 10 metric columns) and trip OAP's per-request complexity ceiling, blanking every cell. Chunks at 6 services per round-trip and fires them in parallel — same pattern the dashboard route already uses.
- **Trace waterfall opens fast on huge traces.** Rows render lazily via the browser's `content-visibility` window — a 5000-span trace no longer freezes the main thread on open.
- **Backgrounded tabs stop polling.** The shared auto-refresh ticker pauses when the tab is hidden and resumes (with one immediate tick) on return. An unattended browser no longer streams queries at the topbar interval × every subscribed widget.

### RBAC + input-validation hardening

- **`/api/health` no longer leaks the active session count** to unauthenticated callers — the public liveness probe returns only status + version. The authenticated `/api/auth/health` surface still carries detail.
- **`pageSize` capped server-side** on every trace / log route (trace 200, log 100). OAP forwards `paging.pageSize` straight to the storage `LIMIT`, so a client posting `pageSize: 50000` previously cascaded the load to OAP. The UI picker's matching cap is now defended at the BFF boundary too.
- **Profiling task bodies validated.** Async-profiler, pprof, eBPF fixed-task, and network-profiling create routes now sanitize and bound their bodies — duration caps, target-instance and event-list caps, payload-size clamps. Closes a DoS vector where a user with `profile:enable` could submit a multi-hour profile that pegs the target instance's CPU.

### Diff modal console error fixed

The four admin "Check diff & push" modals (Layer dashboards, Overview templates, Translations, the shared TemplateDiffModal) used to log `Uncaught (in promise) Error: Missing requestHandler or method: resetSchema` (two per modal — one per diff pane) the moment the operator opened them. Monaco's JSON language service was sending the message to a worker that didn't know how to handle it. Now wired correctly — the diff itself rendered all along, but the console is quiet again.

### DSL / OAL catalog renames + admin editor seeding

- **Catalog pages spell out the language name** in the header: `Metrics Analysis Language - OpenTelemetry Rules` (and `… - Telegraf Rules` / `… - Log MAL Rules`); LAL renders as `Log Analysis Language`; the OAL browse as `Observability Analysis Language`. The sidebar keeps the abbreviated MAL · OTEL form for space.
- **Layer Dashboards + Overview Templates editor opens REMOTE on diverged rows.** The runtime menu already renders remote content when the row is diverged, but the editor used to seed from bundled — so operators were editing a copy that silently disagreed with what end users saw. Priority is now local → remote (diverged / remote-only) → bundled; the source pill on both editors reads `from local / from remote / from bundled` consistently.
- **Rule card arrow stays next to the rule name.** Short names like `default` / `mesh-dp` / `vm` used to float in the middle of the card with a big gap from the ▶ run arrow — the arrow + name are now grouped on the left, with the status pill alone pushed right.

### Sync-status counters don't include translation rows

Per-locale overlay rows on OAP share their parent template's kind, so they were inflating the `remote-only` and `diverged` counts on the Overview Templates and Layer Dashboards admin pages (the banners would read `14 remote-only` / `294 remote-only` when most of those entries were translation rows that belong on the Translations page only). Filtered at bundle assembly so the sync-status banners count source rows only.

### Cluster Status + admin polish

- **Cluster Status — Pane B + Pane C fully translatable.** Module column headers, gate descriptions (the SWIP-13 affects strings), per-row enabled/missing badges, the admin-host status badge (`loading…` / `unreachable` / `all selectors on` / `{n} selectors off`), the admin-host-unreachable hint, the Zipkin / OTLP pane lede, the Endpoint card heading, the Zipkin badge and the Zipkin-unreachable hint all now render in the active locale.
- **Hide redundant BUNDLED chrome when synced.** On the Overview templates and Layer dashboards admin pages, when the row's sync badge is `synced` the BUNDLED and REMOTE versions are byte-equal, so the `from {source}` pill and the `Reset to / Preview Bundled` dropdown items add no information and are hidden. LOCAL drafts always show; BUNDLED resurfaces the moment the row diverges.
- **Translations picker prefers the English bundle.** REMOTE-only rows with non-English titles (legacy duplicates from prior import cycles) no longer appear as separate dashboards in the picker — the picker lists the canonical English bundled dashboards once each, and the preview renders the English source as the baseline.

### Alerting rules — running entities show their OAP node

The **Operate › Alerting rules** detail pane's **Currently watching** list now spans the whole cluster and tags each entity with the OAP node evaluating it. Each OAP instance evaluates a rule independently over the slice of entities it holds, so the watched set is the union across nodes — the page previously showed only the first responding node's entities, which misread as "these are all the entities the rule watches." The list now aggregates every instance's entities and labels each row with its node (e.g. `SERVICE  agent::app  NODE 10.116.3.26_11800`), with the per-entity alarm message on hover. The per-node load-state table is unchanged. Single-instance deployments simply show one node label per row.

Clicking a watched entity now opens a **running-context popup** — the live evaluation window the rule is computing for that entity, per OAP node. It shows the current state (`FIRING` / `SILENCED_FIRING` / `RECOVERY_OBSERVATION`), the window size and silence / recovery countdowns, the window end, the last-alarm time and message, and the per-metric snapshot the expression was evaluated against — rendered as a sparkline plus per-bucket values so an operator can see exactly why a rule is (or isn't) firing. Nodes not evaluating the entity are marked as such, and a raw-JSON disclosure carries the full payload.

### Live debugger fixes

A clutch of small but visible bugs were caught while exercising the i18n surfaces:

- **History → debug deep-link rendered blank.** MAL and LAL views crashed silently on `?historyId=…` because `loadHistorical` reset refs (`selectedRow`, `expandedEntities`, `foldedRecords`; `selectedCell` for LAL) that the file declared further down. The `watch(historyId, …, { immediate: true })` fires during setup, so the TDZ ReferenceError aborted setup before the page rendered, with no console trace. Resettable refs are now hoisted above their consumer.
- **Captured records wiped on stop.** After `stop()`, the per-DSL view did one final `session()` refresh against an already-cleaned- up OAP, which returned nodes-only-with-empty-records and overwrote the rich live snapshot in localStorage. `save()` now refuses to shrink an existing entry's `recordCount` for the same `sessionId` — only metadata (`retentionDeadline`, `retentionMillis`) updates.
- **Stable node ordering.** MAL / LAL / OAL node cards now sort by `nodeId ?? peer` so they don't reshuffle between polls.
- **Tab buttons jumped nowhere.** `LiveDebuggerView.selectTab` pushed `/debug/<tab>` (a path that doesn't exist); fixed to `/operate/live-debug/<tab>`. Same correction in `DebugHistoryView.loadEntry` deep-links and surrounding doc-comments in `RuleCard.vue` / `DslEditorView.vue`.
- **Empty-capture placeholder.** When a saved session has zero populated nodes, `DebugView` now shows an explicit "This capture has no records" rather than rendering blank, so an honest empty capture is visibly different from a bug.
- **Per-locale lookup widened.** Per-DSL views look up the historyId via `history.all` (not the widget-filtered `history.entries`); the route already pinned us to the right widget, and double-filtering by `widget` was a silent way for a stale field to drop the entry.

### Other small fixes

- **MAL / LAL editor gutter glyph.** The green ▶ live-debug entrance on every `- name:` row was referencing an unstyled CSS class — Monaco reserved the gutter and wired clicks, but the icon was invisible. Restored.
- **Rule catalog cards.** Duplicate BUNDLED pill removed; the header status pill already conveyed it.
- **K8s instance Node Status.** Switched from a single-scalar card (rendering just `1`) to a table of currently-true Kubernetes conditions, matching the cluster-scope sibling and aligning widget heights.

### Upstream `ui-management` compatibility

Aligned with upstream [skywalking#13884](https://github.com/apache/skywalking/pull/13884) ("remove auto generate id for UI templates"): Horizon now sends `id = <envelope name>` on `POST /ui-management/templates`. Current OAP requires it (POSTs without `id` are rejected); legacy OAP releases ignored the field and auto-generated UUIDs, so the same payload works against both. Horizon already treated `r.id` as opaque; mixed-id deployments self-heal via `reconcileDuplicates` on the next boot.

### Smartscape service hierarchy

OAP 10's cross-layer service hierarchy is now reachable from any layer's service map — a logical service projected across observation layers (GENERAL agent ↔ MESH sidecar ↔ MESH_DP data-plane ↔ K8S_SERVICE pod) is one click away on every selected hex.

- **Lazy-probed chip on the selected hex.** Picking a node fires one `getServiceHierarchy` call; if the service has cross-layer peers, a small chevron-stack chip clips to the hex's right edge. No probe, no chip on services with no peers.
- **Focus + context + suggestions overlay.** Click the chip and the topology dims under a transparent canvas; the focused hex re-renders bright at the exact same screen position and scale as the underlying hex (the topology's d3 zoom transform is mirrored onto the overlay). Peers fan vertically from the focus column using OAP's `listLayerLevels` order — higher-level (request-near) layers above, lower-level (infra-near) layers below, matching booster-ui's hierarchy rendering rule.
- **Auto-refresh pauses while the overlay is open** so the background topology and KPI panels don't shift under the operator. Closing the overlay (`×` button, ESC, or click-on-dim) resumes the ticker and fires one immediate tick so the page snaps back to live data.
- **Two-step peer open.** First click on a peer hex arms it (selection halo + side `↗ Open in <Layer>` action chip); second click on the chip opens the destination layer in a new browser tab, pre-selecting the peer service. Peers in layers Horizon has no template for render dimmed with a `cursor: not-allowed`; clicking them logs *"No layer template configured for &lt;Layer&gt;"* to the event log instead.
- **URL-pinned service validator on the destination tab.** Every per-layer page now validates the URL-hydrated `?service=<id>` against the layer's real service roster (the new `GET /api/layer/:key/services`, served from the BFF's 60s catalog cache so it adds no extra OAP traffic). A genuinely missing id pops a `Service not found in this layer` modal with a one-click fallback to the first available service; a valid id is trusted even when landing's top-N rollup doesn't sample it (the cause of the previous silent service-swap on low-traffic deep links).
- **Service-name resolution** on the layer dashboard now consults the roster after landing's top-N, so deep links to low-traffic services no longer sit on *"Resolving service…"* forever waiting for a row that won't arrive.

### On-demand pod logs (live tail)

A new per-layer **Pod Logs** tab live-tails a Kubernetes pod's container logs, pulled on demand from the K8s API through OAP and never persisted.

- **Instance-pinned tail.** Pick a pod, pick one of its containers, press Start; the trailing window (30s / 1m / 5m / 15m / 30m) streams into a read-only log pane and refreshes on a chosen interval (2s / 5s / 10s / 30s) until paused. A header strip shows the container, line count, a live dot, and "updated Ns ago".
- **Include / Exclude filtering** forwards to OAP's content keyword filters — full-line regex, so a substring match reads `.*error.*`.
- **Enabled on the Kubernetes-deployed layers** — Kubernetes Services (`K8S_SERVICE`), Istio Managed Services (`MESH`), and Istio Data Plane (`MESH_DP`) — whose service instances resolve to a pod. The tab is gated by a new `podLogs` component flag added to those bundled layer templates; an existing OAP whose stored template predates the flag still gets the tab, because the flag is back-filled from the bundled default (no re-push needed).
- The page **owns its own refresh** — the global auto-refresh ticker and the topbar time picker are paused while on it, the same as Traces / Logs.
- When the selected instance carries no pod metadata (or the pod has rotated away), OAP's reason is shown verbatim with a hint to pick a currently-running pod or enable the feature on OAP.

### BanyanDB cold-stage query

The cold lifecycle stage is now reachable from the UI on BanyanDB deployments — operators can query data that has aged past the hot + warm window without leaving the page.

- **Topbar `Cold` pill** appears only when the connected OAP is BanyanDB. Toggling it switches every page to read from the cold stage instead of hot + warm — it replaces the read, it does NOT union the two stages, so the pill label flips to `Cold only` while on. The choice is sticky per browser and re-runs every visible query so what you see matches the new mode immediately.
- **Cold-trap banner.** When the pill is on AND the current time range is within the hot + warm window, a yellow strip appears under the topbar: *"Cold-only read is active — your time range is within the last N d (hot + warm), where the cold stage returns nothing."* A one-click *Turn Cold off* sits on the right.
- **Trace lookup from a log row** now passes the row's timestamp through the popout so the trace lookup spans a window around that timestamp instead of OAP's default last-1-day search — paired with the Cold pill, a trace that lives in cold resolves from a cold-era log row instead of silently failing to load.

### Data retention page

- **Per-data-class data lifecycle bar.** One row per data class (Normal / Trace / Zipkin trace / Log / Browser error log / Metadata / Minute metric / Hour metric / Day metric) with proportional Hot+Warm and (when configured) Cold segments. Widths are proportional to total retention across all rows, so a class retained longer visibly stretches further than its peers.
- When every class in a category shares the same TTL pair, the rows collapse to `All records (5)` / `All metrics (4)` — the page never renders nine identical bars.
- The page **branches sharply by backend.** BanyanDB shows the full lifecycle bar + stage vocabulary; on any other backend, the page renders a single `Retention` pane with per-class values and skips the stage vocabulary entirely.
- A footer note names the wire-level truth: OAP's TTL response collapses hot + warm into one number per class, BanyanDB migrates between stages in segments so records near a boundary may briefly exist in both, and property data is omitted (forever-retained, no TTL reported).

### Time picker

- **Custom range seeds from the last applied range** when you re-open the picker, instead of resetting to "half the max ending now". Reopening also auto-expands the Custom form on the matching precision tab when the current range is custom.
- Locale-bleed fix on the alarms page custom-range stamp and the log row date column (was rendering `5月08日` on zh-CN browsers; now uniform `MM-DD`).

### Overview widgets follow the global time picker

- The **Services Dashboard** (and any overview using metric / KPI / table widgets) now honors the topbar time picker. Previously the per-layer landing and topology routes were hardcoded to the last 60 minutes, so picking 12 days back kept showing recent numbers; now picker + Cold pill flow end-to-end. The layer dashboard's header KPIs follow the picker too (was showing live numbers while the body honored the picker).
- The **Active alarms** widget title now shows the actual window (e.g. `· last 10m`) and the empty-state copy uses the same value instead of a hardcoded "last 60m".

### Polish

- Sentence-case fixes on a couple of leftover Title-Case labels (`DSL management`, `Metrics inspect`) so the menu and roles tables read consistently; acronyms (DSL / OAP / MAL / LAL / OAL) stay uppercase.
- Public-demo (`demo.skywalking.apache.org`) references removed from setup docs — the demo doesn't accept anonymous traffic.

### Dashboard authoring

The Layer dashboards and Overview templates admin pages now share one editing model where your work-in-progress lives in your browser, and the live, shared version is whatever OAP serves.

- **Edits are local to your browser.** "Save (local)" stores your draft in this browser only — it is never written to the server and nobody else sees it. Everyone (including you, in normal viewing) keeps seeing the published remote dashboard until you publish.
- **Load any source into the editor.** A single **Reset to ▾** control loads the **Bundled** (shipped default) or **Remote** (OAP live) version into the editor; editing from there becomes your local draft.
- **Preview any source on the real page.** A **Preview ▾** control opens the actual layer / overview page in a new tab rendering your **Local** draft, the **Bundled** default, or **Remote** — via `?mode=preview&source=…`, which stays in the URL and propagates as you navigate the menu. A banner names what you're previewing (dismiss with × or Esc).
- **Publish with a diff.** **Check diff & push** shows a side-by-side local→remote diff and publishes to OAP; it's enabled only when your local draft actually differs from remote. Bundled can also be pushed straight to OAP. Resetting to remote clears the local draft. **Reset to bundled** then publishes correctly when the bundled default differs from remote — Save (local) and Check diff & push now compare the editor against remote, not just against what was first loaded, so a bundled-vs-remote divergence is no longer mistaken for "no changes" (layer + overview editors).
- Preview faithfully reflects your draft's **enabled components / menu labels** — disabled tabs disappear and renamed nouns ("Nodes", "Topics") show through — without pushing anything to the server. Preview works even for layers OAP currently reports no services for.
- An editors-only reminder lists any unpublished local drafts with quick links to the relevant edit page (no more "use local vs remote" prompt — remote is always the live source).
- **Create mirrors edit.** "+ New dashboard" writes a local draft (the id is the template name, checked unique) — edit and preview it, then **Check diff & push** publishes it. A pushed dashboard with no bundled default is **remote-only** and now renders everywhere (live page + sidebar), not just in the editor.
- **Delete = soft-disable** (OAP has no hard delete). A local-only draft is removed from the browser; a dashboard on OAP is disabled — dropped from the picker's live state, the sidebar, and the live page. A **disabled** status chip shows it. Confirmations are styled in-app dialogs, not the browser's native box.

### Layer dashboards editor

- The layer picker is a single filterable dropdown showing alias + key + sync status. A live **menu preview** sits beside the Alias / Components / **Menu labels** (per-layer slot aliases) editor; clicking a menu item jumps to that component's config. Scope tabs and section headings read in the layer's own vocabulary.
- The service-list metrics editor gains a **sample-data preview** (plus a faithful **landing KPI tile** preview that reuses the real header components), the column remove-button alignment is fixed, and the landing KPI tile config makes clear it just picks which existing column feeds the headline + sparkline.
- The picker's Diverged / Local filters now sit **inside the dropdown** (next to the search), and the editor header reads on one line — `Layer: <name> <key> <status>` — showing the same sync-status chip the picker does.
- **Disable / Reactivate a layer.** Disabling soft-disables the layer on OAP and drops it from the sidebar (the menu honors disabled templates); a disabled layer offers **Reactivate**, which re-enables it from the bundled default (the OAP update path clears the disabled flag).

### Overview templates editor

- Rebuilt as a **layer-style canvas**: a 12-column grid you drag to reorder and corner-drag to resize, click-to-edit in a right drawer that appears on selection (Esc / deselect hides it), with section-breaks and the dashboard title selectable and unselected widgets hinted by a dashed outline. The canvas mirrors the live grid (fixed row height), so the layout matches the real page — including side-by-side widgets like topology + alarms.
- The **composite-metrics** KPI editor stacks each row as a card (label / source / MQE / unit / aggr / style / max) so nothing truncates in the narrow drawer.

### Navigation & shell

- The **main sidebar folds** to a narrow rail to reclaim width; the logo moves into the topbar while folded (the original wordmark is unchanged).
- The active menu item now reliably expands, highlights, and scrolls into view on entering a page (route matching is case-insensitive). Fixed a regression where the sidebar scrolled to the very bottom on every navigation (the "Debug events" toggle's active state was being treated as the scroll target).
- **Overview dashboards appear in the sidebar only when their layers are reporting services.** Visibility is derived from each dashboard's widgets (their `layer` field) ∪ the explicit `layers[]` list, gated against the live `availableLayers`. A dashboard you create via "+ New" inherits this automatically — no need to maintain the `layers[]` field by hand. Polls on the 60s menu cadence + window focus, so entries appear / disappear as services start and stop reporting.
- **Smarter landing.** Root `/` cascades through a sensible chain so the user never sees a blank page: first available public overview → first layer with services → the **empty landing** (`/landing-empty`). The cascade only lands on destinations that are also in the sidebar — a bundled-but-inactive layer (no services yet) is deliberately not a fallback, since it would put the user on a page they can't navigate back to via the menu. The empty page is also a real bookmarkable route, with two distinct copies — *"No data is flowing yet"* (no agents/receivers reporting) vs *"No dashboard configured yet"* (services exist but no overview is set up) — each with the right operations-team handoff and no action buttons (a viewer's role doesn't include the verbs the old buttons jumped to).
- **Debug events panel now defaults OFF on every host** (was on for localhost). Same baseline for operators and developers so reproductions match what operators see.
- **Zipkin trace mode** drops the per-layer service-KPI header — the Zipkin explorer is a self-contained, cross-service view.

### 3D Infrastructure Map

A standalone, bird's-eye view of the deployment at `/3d/map`: services render as cubes on stacked tier-planes (apps · service mesh · middleware · infra), each tier subdivided into per-layer zones with the layer's brand mark stamped on its colored swatch. Drag to rotate, scroll to zoom, arrow keys / WASD to pan; click a cube for its detail card and a link into that layer's dashboard.

- **Live data windows.** The map auto-refreshes every minute — per-cube traffic rolls up the last 2h of metrics (HOUR step) and alarmed services light up from the last 20m of alarms. A toolbar chip shows the active scopes (`metrics 2h · alarms 20m · ↻ 1m`). An alarmed cube burns red with a radiating ripple, matched to its service by (layer, name) so only the firing service in the right tier is flagged.
- **Live topology.** The deployment structure is read live from OAP rather than a bundled snapshot: each layer's service roster and service map are fetched one at a time (low concurrency) and assembled into the scene, so the map is correct on any deployment. It refreshes on the same one-minute cycle — an unchanged structure updates metrics/alarms in place without disturbing the camera, while a service appearing or disappearing rebuilds the affected tier. The load progresses stage by stage in the status strip.
- **Beacon mode.** A toolbar toggle dims every healthy cube to a wireframe ghost and lets only alarming cubes glow, so the services that are firing jump out instantly during an incident.
- **Logic groups.** Related layers can be clustered into a single labelled block on a tier — the bundled config ships a **Self-Observability** group (OAP, Satellite, BanyanDB, and the Java / Go agents) on the middleware tier. Members keep their own cube colors but read as one block on the map.
- **Configurable tiers + layers.** Tier order, per-layer plane mapping, cube colors, the traffic MQE per layer, and the logic groups are all driven by the 3D map config, edited on a structured admin page at `/admin/3d-map`. Pin each layer to a tier (with a single global layer filter as the top-level gate), edit each layer's color + traffic metric, manage logic groups (members, color, icon, tier), and choose the single failover tier for anything unpinned. The config is published to OAP and shared across the deployment the same way as dashboards: edits save to a local draft in your browser, then **Check diff & push** publishes to OAP — the map renders the remote, with the bundled defaults as fallback.
- **Topology clustering.** Within layers that carry a service map, services group into named clusters drawn as a wireframe frame with the cluster name baked into the frame's lower-left corner — service-mesh services cluster by their showcase group, Kubernetes services by namespace. Clustering follows each layer's naming rule, so layers without one keep rendering flat.
- **Navigate by tier.** The right-side **Tiers** panel is a two-level tree (tier → layer / logic-group). Clicking any entry resets the view, glides the camera to face that region, zooms in, and flashes the region for a few seconds so it is easy to spot. A **Reset** button in the panel header restores the initial framing.
- **Hover = preview.** Hovering a cube shows the same detail card as a click — tier, layer, service, and (when present) group and cluster — anchored at the cube, minus the open-in-dashboard link.
- **Call-direction flow.** Call relationships animate directional particles so the direction of traffic reads at a glance.
- **Focus one layer.** The per-layer service map gains a **View in 3D** link that opens the map focused on just that layer.
- **Refresh countdown.** The load status strip shows a live countdown to the next refresh, anchored to the stage that will run next.

### Reliability

- When the BFF is unreachable the UI now shows a clear "Cannot reach the server" message instead of the cryptic "body stream already read" — the API client reads each error response body once and surfaces the real status/text (or a wrapped network error).
- **Server-global service-by-layer catalog.** One singleton on the BFF (60s TTL + single-flight) now owns the `listLayers` + aliased `listServices(layer)` fan-out. The sidebar menu's per-layer counts and the alarms layer-tagger share this one cache instead of each running their own poll, so OAP sees at most one fan-out per minute regardless of how many routes are polling — and the two views can no longer drift by 60s relative to each other.
- The brand link and the post-login redirect no longer resolve to an empty address — both now land on the operator's actual landing route.
- Trace span detail now labels the span direction as **Kind** (the noun) rather than the mistranslated verb form, and long tag keys wrap inside the panel instead of overflowing their column.

## 0.5.0

First Apache-style release cut from this repo: source + binary tarballs, GPG-signed and SHA-512 checksummed, with a self-contained binary that boots via `node server.js` and no `pnpm install` step. Binary distribution ships a regenerated `LICENSE` + `NOTICE` that enumerate every bundled third-party package — produced by `scripts/collect-dist-licenses.mjs` during packaging and validated against a deny-list before signing.

### Profiling

- **pprof (Go) profiling** is fully wired: pick one event per task (CPU / HEAP / BLOCK / MUTEX / GOROUTINE / ALLOCS / THREADCREATE), with duration shown for CPU/BLOCK/MUTEX and a sampling-rate field for BLOCK/MUTEX. Create and analyze both match OAP's single-event pprof schema.
- **eBPF profiling** gets a reworked process picker — click a row to expand its full attributes, selection lives on the checkbox, anchored pop-out — a refresh button on every task list, Intl-formatted times, and a hover-info frame on the flame graph. Flame-graph thrash on re-analyze is gone.
- The shared flame graph fixes "% of root" (it read a never-aggregated count), highlights the selected frame across all four profilers, and shows a single hover card (the library's duplicate native tooltip is suppressed).
- After creating any profiling task (trace / async / eBPF / network / pprof) the list now polls up to 4× at 10s until the new task shows up, instead of leaving a stale pre-create list.

### Network profiling & process topology

- A booster-style honeycomb process topology: pods as hexagons, peers hugging the boundary, animated protocol-coloured edges (HTTP/TCP/TLS), a node pop-over, and a wide client | server edge-metric dashboard. Network task creation and the task-list query now use OAP's schema field names.

### Platform monitoring (operate)

- Two new read-only operate pages: **Data retention** (TTL — `getRecordsTTL` / `getMetricsTTL`) and **OAP configuration** (the admin-port config dump, with OAP-masked secrets). Gated on new `ttl:read` / `config:read` verbs granted to maintainer and above. Data retention now loads on non-BanyanDB backends too (the `metadata` TTL field is optional).
- The operate sidebar now leads with a single **Platform monitoring** group (cluster status, data retention, OAP configuration) above the per-layer self-observability dashboards.

### Dashboards & templates

- **The global time picker now drives dashboards.** Layer dashboards query OAP at the picker's window and precision (MINUTE / HOUR / DAY) instead of a fixed last-hour minute window, and line charts label the x-axis with real times per step (e.g. `MM-DD` for a 30-day view) rather than `-Nm`.
- **New `table` widget** for label-dimensioned metrics — pod phase per service, node condition, deployment replicas, etc. — rendered as one column per label (e.g. `Condition | Node`) instead of a scalar card or a misleading flat line. The K8S dashboards (and kong / mongodb / elasticsearch) now use it where upstream booster-ui does; widgets that were charting a single `latest(…)` value as a line are now cards. The K8S Cluster view is realigned to the upstream layout (totals cards · resource lines · status tables).
- **Edit locally, publish on your terms.** Saving a dashboard/overview template now writes the local bundled copy (so the edit renders immediately for preview) and marks it diverged — nothing reaches OAP until you press **Sync all to OAP**, which pushes only the templates that differ, behind a confirmation listing exactly what will be written. A post-save tip spells out that the change is local-only until published.
- **Local-vs-remote, made explicit.** When local edits diverge from OAP, a per-session prompt (by menu name, not file name) asks which to render — **keep my local edits** (preview) or **use live** (which overwrites the local copy with the remote version, confirmed). The layer-templates admin page carries the same Local/Remote display toggle next to Sync all, and a **Diverged only** filter; each diverged layer shows a yellow warning icon in the sidebar.

### Traces

- The native trace view auto-selects OAP's trace-query API — `queryTraces` (whole trace inline, BanyanDB) vs `queryBasicTraces` (segment list + a per-trace fetch on click, every other backend) — and a banner states which is in use; in segment-list mode the list reads "Segments" and a click loads the full trace.
- Span kind (Entry / Exit / Local) renders as a colored word, not a filled pill.

### Auth, RBAC & resilience

- Every OAP call — GraphQL, admin REST, and Zipkin — now carries the configured basic-auth credentials, so a secured OAP no longer 401s pages.
- The sidebar is RBAC-gated by read verb, the Roles page shows a per-role menu-visibility matrix, and the Users page labels per-node "Active (24h)" / "Last seen" honestly (these are tracked per BFF replica, not cluster-wide).
- **Routes are verb-gated, not just menus.** A user without the required read verb is bounced from a restricted page (e.g. a viewer can no longer reach Cluster Status via the topbar OAP chip or a direct URL); the chip only links there for `cluster:read`. This sits on top of the existing per-route BFF verb enforcement.
- **LDAP** resolves group membership with the service account, not the logging-in user — directories that hide the group subtree from ordinary users no longer collapse every login to the fallback role.
- When OAP is unreachable the menu and admin loaders fall back to bundled templates, and non-JSON OAP responses surface a clear diagnostic.

### Smaller touches

- Top-N widgets get hover tooltips for long names and a title-bar pop-out to the full ranked list; redundant single-service name prefixes are dropped.
- The admin template-diff modal is a wide side-by-side view with labelled bundled-vs-OAP columns and an explanation of what the template drives; the layer-dashboards admin rail gains an in-page search.
- Per-layer alarm filtering uses the singular `queryAlarms` layer condition.
- Dependency hygiene for the release: `dompurify` ≥ 3.3.2 and `@fastify/static` ≥ 9.1.1 (clears the known advisories); the `general` layer drops `networkProfiling`, which is instance-scoped to k8s / mesh.

## 0.4.0

OAP becomes the runtime source of truth for UI templates, the 5-theme system lands, and the app supports being served behind a gateway prefix.

### Templates synced to OAP

- Five reserved template families now live on OAP's UI-template REST surface (`/ui-management/templates*` on the admin port): overview dashboards, per-layer dashboards, alert page setup, theme selection, time-defaults. Bundled JSON ships as the seed + read-only fallback.
- One-shot seed on BFF boot pushes any missing bundled template to OAP; runtime sync is read-only with a 30-second single-flight cache.
- New admin endpoints: `GET /api/admin/templates/sync-status`, `POST /api/admin/templates/save`, `POST /api/admin/templates/resync`, `POST /api/admin/templates/:name/push-bundled`.
- When the admin port is unreachable, every admin page goes read-only with a red banner; Save / Create / Delete are disabled; render falls back to bundled.
- Diverged rows surface a "Show diff & reset" Monaco modal with a destructive-confirm (type the template key to arm reset).

### Themes

- Five bundled themes — **Horizon** (default), **Meridian**, **Obsidian**, **Daybreak**, **Aurora** — each shipping a complete token set (bg, fg, accent, info/ok/warn/err, font, radius, density).
- New `/admin/global-defaults` admin page replaces the old "Setup" link. Theme picker uses preview cards lifted from the design (hero strip, mini-app mockup with Primary/Tonal/Ghost buttons, KPI tiles, sparkline, density/font/radius badges).
- Per-user theme override via a labelled topbar chip — three-tier resolution `localStorage user → OAP org default → bundled`, written to `<html data-theme>` / `<html data-appearance>` synchronously on boot so the pre-auth login page already respects the local override.
- Sidebar SkyWalking logo swaps to the official brand blue (`#1368B3`) on light-appearance themes.
- Widget series colors (Zipkin trace palette, AlarmSnapshotChart, AlarmsTimeline) track the active theme's `--sw-accent` via a shared `readAccent()` util.
- Sign-in button gradient derives both stops from the theme accent.

### Time defaults

- `/admin/global-defaults` also owns the global picker's default window (60 minutes shipped). OAP `step` precision is derived from window size — ≤ 4 h MINUTE, 6 h–14 d HOUR, ≥ 30 d DAY — and surfaced inline on the page.
- Per-user override in the topbar time picker: "Save as my default" / "Reset to org default".

### Reliability + diagnostics

- Topology cluster boundary now grows to encompass dragged nodes; the chip moved inside the cluster header so it stays visible at any drag position.
- Alarms page gains an **Other** KPI tile that surfaces the residual count between `Active` and the sum of pinned-layer chips — `Active = General + Mesh + Other` reconciles even when alarms land in unmapped layers.
- Overview "Active alarms" widget now reads the admin's configured `defaultWindowMs` from `/admin/alert-page-setup`; all three alarm surfaces (overview widget, alarms page, topbar badge) share one window.
- Every backend call failure (network throw or non-2xx) writes a `pushEvent('api', 'err', …)` into the debug event log with the BFF's `code` / `message` envelope inlined when present.
- Dashboards with more than 40 widgets (e.g. the General/instance page, 56 widgets) now succeed: the UI splits oversize requests into ≤40-widget chunks fired in parallel, then merges results.

### Deployment

- Gateway-prefix support: `BffClient.request()` prepends `import.meta.env.BASE_URL` to every API path. Build with `vite build --base=/horizon/` and a gateway that strips the prefix and the SPA + every API call resolves cleanly under the sub-path.
- Cluster Status route corrected from `/admin/cluster` → `/operate/cluster` (the prior default 404'd because no route by that name existed).

### Cleanup

- Documentation rewritten as an orientation map; the left-side menu is the canonical navigation now. All `SWIP-*` references removed from user-visible text and docs.
- "Coming in Phase 6 / 7" placeholder strip on Cluster Status removed.
- Dead code dropped — `LandingView.vue`, `LayerTabPlaceholder.vue`, the orphaned disk-write template routes (`POST /api/admin/overview-templates/:id` + `POST /api/admin/layer-templates/:key`), and stale `Phase X` markers across BFF + UI + docs.
- The OAP UTC-offset chip is gone from the topbar; the health dot stays.

## 0.3.0

The shell unifies, the operate stack lands, and the first round of public documentation ships.

### Operate stack

- **Alarms page** — incident-merged active-alarms view, severity tabs, alarm list with right-side detail (trigger expression, channel routing), inline Live Debug card (Run / Step / Pause / Copy as MQE, execution-trace ladder with per-step output + latency, matched entities, eval-window chart, raw OAP response).
- **Inspect** — metric catalog + entity enumerator with search, type filter, scope (Service / Instance / Endpoint / Process / All), and source attribution.
- **Live Debugger** — MAL / LAL / OAL session start, poll, stop. Per-node status fan-out, sample payloads, capture history with replay-ready recordings.
- **Profiling** — flame graph + stack table over five profilers: trace-driven thread profiling, eBPF CPU/off-CPU, JVM async-profiler, network profiling (process conversation graph), Go pprof.
- **Zipkin trace explorer** — service / span search, waterfall popout with per-service color bands, sticky time-axis.
- **Overview dashboards** — cross-layer war-room views (Services, Mesh) with per-layer KPI tiles, alarm rails, and the existing chart widgets.

### Auth + access control

- Local + LDAP authentication backends. Break-glass admin honored only when `backend: ldap` AND the LDAP probe is failing.
- Three admin pages — Users, Auth status, Roles & permissions.
- 4 built-in roles (viewer / maintainer / operator / admin) and a 28-verb permission model. Every BFF route gated by a single policy table.
- Login view redesigned (canyon hero, status pill, configured-backend banner).

### Reliability + UX

- Cascade-clear, then load — every dependent area visibly resets and shows "Reading data…" between an upstream control change (service / instance / endpoint pick, time-range change, layer / scope nav) and the new data landing. No silent freezes; no stale value sitting under a spinner.
- Global time picker in the topbar wired into the landing + widget query keys; the picker only applies to dashboards / overviews (triage pages keep their own per-page time).
- Single-shot bundle preload: layer dashboards + overview list arrive in one round-trip, cached in localStorage with ETag revalidation.
- Framework event ticker in the topbar replaces breadcrumb+search; Admin-toggled debug panel surfaces a 200-event buffer with operator click capture.
- Auto-pick first instance / endpoint when a scope needs one and the list is non-empty.
- Topology + dashboard fixes, multi-layer service attribution, sticky service selection across navigations.

### Documentation

- First public docs tree (`docs/`) — Setup, Compatibility, Access Control, Customization, Components, Operate. Lives in-repo and publishes to skywalking.apache.org.

### Container + CI

- Real `packages/*` builds + self-contained `dist/` + copy-in image (no compile in the container).
- Zero-config boot: image defaults `HORIZON_SERVER_HOST=0.0.0.0`.
- Multi-arch publish-image — native amd64 + arm64 builds, OCI manifest list.
- Unit-test job in CI; 107 UTs covering entity-scope construction + routing decisions.

## 0.2.0

Per-layer dashboards become real, the layer-template editor ships, and topology gets its booster-ui port.

### Per-layer dashboards

- Real widget grid per layer driven by JSON templates. 43 layer dashboards migrated from booster-ui.
- Per-scope widget sets: each layer template defines its own `service`, `instance`, `endpoint`, `topology`, `traces`, `logs`, profiling variants.
- Visibility predicates per widget (`visibleWhen`) so MQ / DB widgets only render when the relevant metrics are reporting.

### Layer admin

- Read-only template browser, then full edit UI: components editor (toggle which per-layer views exist), metrics editor (header columns), separate Overview tile card, scope-aware visibleWhen hints.

### Service deep-dive

- APIs widget (formerly Services), MQ widgets gated by visibleWhen, TopList multi-expression switcher with MQE preview in tooltip, smaller widget height, per-metric color alignment, dual-axis MQ.

### Topology

- Polished linear-chain variant, dual-panel detail, per-side line charts. Drag-to-move + barycentric layout for smaller graphs. RPM-only chip variant. Istio renamed.

### Logs

- Legend at top of table (drop service facet duplication), workflow notes.

### Charting

- TimeChart: legend formatting fix for dual-axis widgets, value dots, tooltip escape for clipped charts, no more legend / axis-name crowding at chart top.

### Sidebar + chrome

- Group toggle + group click cascades to first layer's first tab.
- Topbar 60m widget format hints (int / decimal / compact).
- Per-layer image pipeline (icons) shipped.

## 0.1.0

Foundational scaffolding. The shell renders, auth works, OAP is reachable, and CI is green. No operator-facing data surfaces yet.

- pnpm monorepo: `apps/ui` (Vue 3 + Vite), `apps/bff` (Fastify), shared `packages/api-client` (typed REST + GraphQL clients), shared `packages/design-tokens` (CSS custom properties).
- BFF — Fastify skeleton with `horizon.yaml` config + hot reload, local auth (argon2 + cookie sessions), RBAC verb gating + JSONL audit log, OAP proxy with cluster fan-out + preflight.
- UI — AppShell (sidebar, topbar) with design tokens, Pinia auth store with on-401 redirect, login view with route guard + sign-out, stub admin / operate pages.
- CI — monorepo workspace build + dependency license check via `skywalking-eyes`.
