# Changelog

Notable changes to Apache SkyWalking Horizon UI, written from the operator's
point of view — what's new on screen and what's now possible, not the
file-by-file implementation. For per-commit detail, see the git log.

The version line is shared by every package in the monorepo (apps + shared
packages) plus the BFF's `HORIZON_VERSION` default.

## 0.7.0

### Dashboard widget visibility

- Layer-dashboard widgets gain a structured **Visible when** gate (Layer
  dashboards admin → widget drawer) so a widget only renders when it's
  relevant to the selected entity. Two kinds:
  - **MQE metric** — show the widget only when an expression *has value*, or
    when any value is **>** / **<** a threshold. Naming the widget's *own*
    metric self-gates it (the JVM widgets appear only on JVM instances, the
    MQ widgets only on MQ producers, …); naming a *different* metric gates a
    whole group on one shared signal — that metric is checked once and the
    entire group's queries are **skipped** when it's empty, so e.g. a non-JVM
    instance no longer runs the JVM widget queries at all.
  - **Entity attribute** — on the Instance scope, gate on the selected
    instance's attributes, e.g. *language equals JAVA* (case-insensitive) or
    an attribute simply being present. Service / Endpoint entities carry no
    attributes, so entity gates are ignored on those scopes.
- Gates are evaluated server-side; gated-out widgets just don't appear in the
  grid. **Note:** a layer dashboard saved before this release that used the
  old free-text predicate loses its gate (the widget renders ungated) until
  you re-set the gate in the new editor and save the dashboard.

### Instance topology

- The per-layer **Topology** map gains an **instance map** drill-down on
  layers that enable instance topology. Click a call between two services
  and then **Instance map →** to open it: the instances of each service
  as two columns (left = client, right = server) with the instance-level
  calls between them — pan/zoom, animated client→server flow, the same
  node health-ring + per-call client/server metric sidebar the service
  map uses, and a node popover with **Open instance dashboard**. A back
  button returns to the service map; a toolbar pair-picker swaps the two
  services. The two service pickers are **relationship-aware**, drawn from
  the service-topology call graph (including conjectured / cross-layer
  callees like `rcmd:80`, named the same as on the service map): the server
  list is the chosen client's callees and the client list is the chosen
  server's callers, each re-deriving when the other changes without
  resetting your current pick. A side the graph leaves no real choice for
  (e.g. a single caller) shows as plain text instead of a one-option
  dropdown. Each service's instances sit inside a labelled grouping box —
  named with the service, using the same `<group>::` prefix handling as
  the service map so a name reads identically on both — and a ring-colour
  legend explains what the node health bands (green → red) mean for the
  configured ring metric. Labels follow the layer's own terms (e.g.
  *Pods* on Kubernetes, *Sidecars* on the data plane).
- **Configurable like the service map.** The Layer-dashboards admin →
  **Topology** scope now has an **Enable instance topology** toggle and
  its own node / server-edge / client-edge metric editors, kept visually
  separate from the service-topology metrics so the two are never
  confused. Enabled out of the box on **General**, **Service Mesh**,
  **Kubernetes Service**, and **Cilium Service**; the config rides each
  layer's topology template (so it travels with template export/import).
- When OAP's template store is unreachable, the instance map now shows the
  same empty + connectivity-banner state as the service map, rather than a
  misleading "not supported" — block and unsupported are no longer conflated.
- **Localized across all eight UI languages.** The instance-map UI, the
  template-store-unreachable banner, and the remaining alarm / live-debugger
  strings are now translated in zh-CN, ja, ko, es, pt, de and fr (English
  stays the source) — no feature renders English-only for non-English
  operators.

### API dependency

- The per-layer **API dependency** tab renders an endpoint's caller → callee
  chain as a graph. Pick an endpoint and it lays out in columns by direction —
  callers on the left, the focus endpoint in the centre, callees on the right —
  with the same node health-ring border, SLA-coloured RPM, and latency you read
  on the service map; edges animate the call direction and label the heaviest by
  RPM.
- **Expand to walk the chain.** A selected endpoint shows a single **+** handle
  that pulls in *its* own callers and callees in one click (new callers land
  left, callees right). The handle spins while the dependency query is in
  flight; when an endpoint is a leaf with nothing further to load it fades and a
  brief banner says so — a silent "nothing happened" never reads as a bug.
- **Rearrange freely.** Drag any node box to pull a dense graph apart — edges
  follow live. Pan, wheel-zoom, and a fit button act on the whole canvas, and a
  node holds a steady on-screen size whether or not the detail sidebar is open.
- **Drill straight out, in a new tab.** The node detail's **Open endpoint** and
  **Service →**, and the service-map node/edge jumps (**Open service**,
  **API map →**, **Instance map →**), now open in a new browser tab — so you
  keep the graph you're exploring while the drill-down opens alongside it.
- Nodes share the service-map's visual vocabulary (SLA-band border, an agent
  badge on instrumented endpoints, the focus star), and the tab is localized
  across all eight UI languages.

### Dashboard template portability

- Every template admin page — Overview templates, Layer dashboards, and the
  3D-map config — now has **Export** and **Import** actions. Export downloads
  the *in-use* version (what end users render: the version live on OAP, or the
  bundled default when OAP has none) as a JSON file, for backup, sharing, or
  moving a dashboard to another OAP. Import reads a JSON file, validates it,
  and loads it as a local draft in this browser — preview it, then publish
  with “Check diff & push” as usual. Importing never writes OAP directly.
  Overview import can recreate a deleted dashboard or seed a brand-new one;
  layer import targets a layer already present on this deployment.
- The **Translations** page has matching **Export** / **Import**, scoped to
  the current language: export the in-use translation for a template + locale
  as a JSON file, or import one as a local draft to review and push. (Source
  templates and their translations are edited on separate pages, so their
  import/export are separate too — each on its own page.)

### Template store reliability

- **Runtime config is strictly what's on OAP.** Layer dashboards, overviews,
  and topology now render only the version published to OAP's UI-template
  store (or the in-code minimal default for a layer that has none). The
  disk-bundled templates reach a running UI **only** by being synced to OAP
  (first boot / admin reset) or through the admin **Preview** button — they
  are never a silent live fallback. So an operator always sees the live
  published config, not a stale bundled copy masquerading as current.
- **Unreachable template store is a visible block, not a quiet fallback.**
  When OAP's UI-template host can't be reached, a banner (same red treatment
  as the OAP-query-unreachable strip) reports it, and the dashboard / overview
  / topology surfaces stay empty rather than back-filling bundled defaults
  that could be read as real. The sidebar still navigates so the rest of the
  app is reachable.
- The admin **Preview** button now drives **every** template-rendered page —
  the **overview detail** view and the per-layer **topology** (incl. the
  **instance map**), **API dependency**, **traces**, and **network-profiling**
  pages — not just the layer dashboards. Previewing renders the draft's
  metrics/config against live OAP, so an edit to topology or dependency metrics
  is visible before you publish. Preview and the absent-remote path stay
  strictly separate: a draft renders only in `?mode=preview`; normal reads
  never carry one.
- **Editors no longer silently fall back to the bundled default.** When a
  layer / overview / translation has no version published to OAP, the editor
  shows a *"No published version on OAP"* panel instead of quietly loading the
  shipped bundled copy as if it were live. Bundled now reaches the editor only
  when you click **Reset to bundled** — matching the runtime, which renders the
  published version or blocks, never the bundle.

### Layer landing & service list

- **The layer landing now shows your services, not just an arbitrary 25.** It
  used to cap the metric fan-out at the first 25 services *by list order* —
  so larger layers hid the rest, and the "top" services weren't even the true
  top (the cap happened before the ranking). Now it probes **all** services up
  to a configurable cap and, when a layer exceeds it, runs a cheap single-
  metric ranking pass to pick the **true top-N** by the landing's order-by
  column. The service picker surfaces **"top N of M"** so the trim is never
  silent. Queries drain through a bounded-concurrency pool, so a big layer
  fans out in controlled waves rather than a thundering herd.
- New `query.landingServiceCap` in `horizon.yaml` (default **100**) tunes how
  many services a landing probes per request — raise it if your OAP + storage
  can take the larger fan-out, lower it to protect a modest deployment.
- **The service picker now lists the *whole* layer, not only the metric-probed
  top-N.** Services that ranked below the metric cap on the order-by column now
  appear as their own rows with **`low`** in that column (and `—` for the
  others, which were never probed) instead of being hidden — every service
  stays browsable, searchable, and selectable regardless of the cap. The
  header chip reads **"metrics: top N"** to make the metric trim explicit.
- **Removed the stale "Landing KPI tile" controls** (Headline / Trend line)
  from the Layer-dashboards admin. They no longer matched the rendered layer
  header — which shows every configured metric column as its own KPI with its
  own trend line — so editing them changed nothing on screen. The header is
  driven entirely by the service-list columns + default sort; the preview now
  reflects that.
- **Selecting a low-traffic (below-cap) service now works on *every* tab**, not
  just the dashboard. Logs, traces, and endpoint-dependency resolved the picked
  service's name from the landing sample only — so a tail service queried as
  blank (and Logs even snapped the pick back to the top service). All per-layer
  tabs now resolve the name from the full roster, so a `low` service drills in
  everywhere.
- **Profiling scopes no longer show an editor grid that goes nowhere.** Trace /
  eBPF / async profiling are built-in runtime views with nothing to author, so
  the admin now shows a "configured at runtime" note for them instead of a
  widget grid whose widgets never rendered.

### Documentation & release tooling

- The website docs were brought current with the 0.6.0 build and the
  configuration pages restructured around the admin UI — the JSON shape is
  now a reference appendix, not an authoring surface (these admin pages are
  structured editors, not raw-JSON editors). Accuracy fixes span the RBAC
  verbs (incl. `infra-3d:read`), the audit-log action set, the Metrics
  Inspect API paths, the layer-template component flags, and the redesigned
  3D-map config + loading stages. A new `docs/CLAUDE.md` records the
  doc-writing principles, and the i18n docs gain a language × scope coverage
  matrix plus a translation step in the add-a-layer recipe.
- The container image is published to Docker Hub by CI on every `v*` tag;
  the post-vote finalize script now only verifies the published tags (the
  manual local-push fallback and Docker Hub login preflight were removed).

### Layer drill-down fixes

- The per-layer **Instance** and **Endpoint** pages now honor the layer's
  configured aliases in their section headers and in the service-picker's
  name column — e.g. ActiveMQ reads **Brokers** / **Destinations** and
  Virtual MQ reads **Topics** / **MQ clusters**, matching the sidebar —
  instead of the generic "Instance" / "Endpoint" / "Service" labels. Layers
  that define no alias still read the generic words.
- A layer's Instance or Endpoint page no longer hangs on a perpetual
  "Reading data…" when the selected service reports no instances or
  endpoints (or a search matches nothing). It now shows the empty picker and
  renders the metric widgets in their normal "no data" state, so the layout
  stays visible and ready for services that do report them.

## 0.6.0

This release is the production-readiness pass for Horizon UI: every page
now renders correctly across the eight supported languages on non-UTC
OAP deployments, with deliberate caps and validation on the load
surfaces that operators reach. The pillars below describe the operator-
visible result.

### Eight-locale internationalization

Horizon now ships with eight first-class UI languages — English (source)
plus zh-CN, ja, ko, es, pt, de, fr — selectable from the top-bar locale
chip on every page (including the pre-auth login). The choice persists
per device.

- **UI chrome.** Every routed page and every shared sub-component
  renders through `vue-i18n`; non-English locales now cover every
  admin page (Roles, Users, Auth status, Alert page setup, Global
  defaults, 3D-map config), every operate page (Alerting rules, DSL catalog / editor /
  dump, OAL catalog, Live debugger + MAL / LAL / OAL, Capture history,
  Metrics inspect, OAP config, TTL), the alarms surface, and the
  shared modals. Long lede paragraphs that previously rendered as
  `English | one translated word | English` mid-sentence are now
  single translation units — inline `<code>` and links interpolate
  without splitting the prose. Missing leaves still fall back to
  English so partial catalogs degrade invisibly.
- **BFF-shipped templates.** All 42 layer dashboards and both overview
  dashboards carry per-locale overlay catalogs alongside the source
  template. Coverage is ~2,300 translatable leaves per non-English
  locale across the layer set. The BFF picks the locale from the
  request's `X-Horizon-Locale` header (auto-set by the SPA), merges
  the overlay onto the source, and serves the localised template to
  the renderer — translation resolves once on the BFF, never on
  every chart mount.
- **Operator-runnable Translations page.** A new admin surface
  (Dashboard setup → Translations) edits the per-locale overlays
  through the live preview: pick a target language, click any widget
  in the rendered dashboard, type the translation. Per-locale status
  chips on the template picker show at a glance which dashboards have
  drafts, which are synced, which diverge from disk, and which are
  empty for a given locale. Push writes the sibling overlay row on
  OAP; pushing zh-CN never touches ja.
- **Tech-term policy.** Product, project, and protocol names
  (SkyWalking, Kubernetes, OAP, MQE, eBPF, Zipkin, OpenTelemetry,
  Istio, GraphQL, etc.), OAP scope enums (Service, ServiceInstance,
  Endpoint, Process), layer keys, MQE function names, env vars, HTTP
  status codes, and per-language runtimes (JVM, Go, Python, …) stay
  verbatim in every locale per CLAUDE.md. Phrases containing tech
  terms are translated around the term (`HTTP Connections` →
  `HTTP 连接` / `HTTP 接続`), not transliterated.
- **OAP-supplied data is never translated.** Service names, alarm
  rule names, trace span operation names, log messages — anything
  arriving over the OAP wire — render verbatim regardless of locale.
- **Validator gate.** `i18n:validate` is stricter: every source
  template must have a sibling overlay file per advertised locale,
  and empty `{}` overlays are now a finding (used to pass silently —
  surfaced as "structurally complete" while every translatable string
  still rendered in English).

### Typography + self-hosted fonts

- **Inter + JetBrains Mono are now self-hosted.** The Google Fonts
  CDN dependency is gone — air-gapped or firewalled deployments
  render the intended typography instead of silently falling back
  to system fonts.
- **One typescale across every page.** Older admin pages that drifted
  to a mixed pixel palette (9.5 / 10 / 10.5 / 11 / 11.5 / 12 / 14 /
  18 / 20 / 22) now share the same six-step scale + uppercase-label
  vocabulary as the newer dashboards. Sidebar, kpi labels, table
  headers, kickers all line up.

### Wire-correctness on non-UTC OAP

Every BFF query route now spells `Duration.start` / `end` in the OAP
server's timezone (probed once per minute, cached). Previously only
the alarms route did this; dashboards / landing / topology / endpoint /
endpoint-dependency / instance / eBPF / traces / logs / trace-tag all
emitted UTC, which silently shifted every query on non-UTC OAP
installs by the server's offset.

Traces and logs additionally query at SECOND precision now (records,
not metric buckets) — a trace that just finished falls inside the
window instead of getting rounded off the MINUTE boundary.

### Performance hardening

- **Landing batches no longer 5xx on wide layers.** The per-layer
  landing route used to build one GraphQL with up to 250 aliased
  fragments (25 services × 10 metric columns) and trip OAP's
  per-request complexity ceiling, blanking every cell. Chunks at 6
  services per round-trip and fires them in parallel — same pattern
  the dashboard route already uses.
- **Trace waterfall opens fast on huge traces.** Rows render lazily
  via the browser's `content-visibility` window — a 5000-span trace
  no longer freezes the main thread on open.
- **Backgrounded tabs stop polling.** The shared auto-refresh ticker
  pauses when the tab is hidden and resumes (with one immediate
  tick) on return. An unattended browser no longer streams queries
  at the topbar interval × every subscribed widget.

### RBAC + input-validation hardening

- **`/api/health` no longer leaks the active session count** to
  unauthenticated callers — the public liveness probe returns only
  status + version. The authenticated `/api/auth/health` surface
  still carries detail.
- **`pageSize` capped server-side** on every trace / log route
  (trace 200, log 100). OAP forwards `paging.pageSize` straight to
  the storage `LIMIT`, so a client posting `pageSize: 50000`
  previously cascaded the load to OAP. The UI picker's matching cap
  is now defended at the BFF boundary too.
- **Profiling task bodies validated.** Async-profiler, pprof, eBPF
  fixed-task, and network-profiling create routes now sanitize and
  bound their bodies — duration caps, target-instance and event-list
  caps, payload-size clamps. Closes a DoS vector where a user with
  `profile:enable` could submit a multi-hour profile that pegs the
  target instance's CPU.

### Diff modal console error fixed

The four admin "Check diff & push" modals (Layer dashboards, Overview
templates, Translations, the shared TemplateDiffModal) used to log
`Uncaught (in promise) Error: Missing requestHandler or method:
resetSchema` (two per modal — one per diff pane) the moment the
operator opened them. Monaco's JSON language service was sending the
message to a worker that didn't know how to handle it. Now wired
correctly — the diff itself rendered all along, but the console is
quiet again.

### DSL / OAL catalog renames + admin editor seeding

- **Catalog pages spell out the language name** in the header:
  `Metrics Analysis Language - OpenTelemetry Rules` (and `…
  - Telegraf Rules` / `… - Log MAL Rules`); LAL renders as `Log
  Analysis Language`; the OAL browse as `Observability Analysis
  Language`. The sidebar keeps the abbreviated MAL · OTEL form for
  space.
- **Layer Dashboards + Overview Templates editor opens REMOTE on
  diverged rows.** The runtime menu already renders remote content
  when the row is diverged, but the editor used to seed from
  bundled — so operators were editing a copy that silently
  disagreed with what end users saw. Priority is now local →
  remote (diverged / remote-only) → bundled; the source pill on
  both editors reads `from local / from remote / from bundled`
  consistently.
- **Rule card arrow stays next to the rule name.** Short names like
  `default` / `mesh-dp` / `vm` used to float in the middle of the
  card with a big gap from the ▶ run arrow — the arrow + name
  are now grouped on the left, with the status pill alone pushed
  right.

### Sync-status counters don't include translation rows

Per-locale overlay rows on OAP share their parent template's kind,
so they were inflating the `remote-only` and `diverged` counts on
the Overview Templates and Layer Dashboards admin pages (the
banners would read `14 remote-only` / `294 remote-only` when most
of those entries were translation rows that belong on the
Translations page only). Filtered at bundle assembly so the
sync-status banners count source rows only.

### Cluster Status + admin polish

- **Cluster Status — Pane B + Pane C fully translatable.** Module
  column headers, gate descriptions (the SWIP-13 affects strings),
  per-row enabled/missing badges, the admin-host status badge
  (`loading…` / `unreachable` / `all selectors on` / `{n} selectors
  off`), the admin-host-unreachable hint, the Zipkin / OTLP pane
  lede, the Endpoint card heading, the Zipkin badge and the
  Zipkin-unreachable hint all now render in the active locale.
- **Hide redundant BUNDLED chrome when synced.** On the Overview
  templates and Layer dashboards admin pages, when the row's sync
  badge is `synced` the BUNDLED and REMOTE versions are byte-equal,
  so the `from {source}` pill and the `Reset to / Preview Bundled`
  dropdown items add no information and are hidden. LOCAL drafts
  always show; BUNDLED resurfaces the moment the row diverges.
- **Translations picker prefers the English bundle.** REMOTE-only
  rows with non-English titles (legacy duplicates from prior import
  cycles) no longer appear as separate dashboards in the picker — the
  picker lists the canonical English bundled dashboards once each,
  and the preview renders the English source as the baseline.

### Alerting rules — running entities show their OAP node

The **Operate › Alerting rules** detail pane's **Currently watching**
list now spans the whole cluster and tags each entity with the OAP
node evaluating it. Each OAP instance evaluates a rule independently
over the slice of entities it holds, so the watched set is the union
across nodes — the page previously showed only the first responding
node's entities, which misread as "these are all the entities the rule
watches." The list now aggregates every instance's entities and labels
each row with its node (e.g. `SERVICE  agent::app  NODE 10.116.3.26_11800`),
with the per-entity alarm message on hover. The per-node load-state
table is unchanged. Single-instance deployments simply show one node
label per row.

Clicking a watched entity now opens a **running-context popup** — the
live evaluation window the rule is computing for that entity, per OAP
node. It shows the current state (`FIRING` / `SILENCED_FIRING` /
`RECOVERY_OBSERVATION`), the window size and silence / recovery
countdowns, the window end, the last-alarm time and message, and the
per-metric snapshot the expression was evaluated against — rendered as
a sparkline plus per-bucket values so an operator can see exactly why a
rule is (or isn't) firing. Nodes not evaluating the entity are marked
as such, and a raw-JSON disclosure carries the full payload.

### Live debugger fixes

A clutch of small but visible bugs were caught while exercising the
i18n surfaces:

- **History → debug deep-link rendered blank.** MAL and LAL views
  crashed silently on `?historyId=…` because `loadHistorical` reset
  refs (`selectedRow`, `expandedEntities`, `foldedRecords`;
  `selectedCell` for LAL) that the file declared further down. The
  `watch(historyId, …, { immediate: true })` fires during setup, so
  the TDZ ReferenceError aborted setup before the page rendered, with
  no console trace. Resettable refs are now hoisted above their
  consumer.
- **Captured records wiped on stop.** After `stop()`, the per-DSL
  view did one final `session()` refresh against an already-cleaned-
  up OAP, which returned nodes-only-with-empty-records and
  overwrote the rich live snapshot in localStorage. `save()` now
  refuses to shrink an existing entry's `recordCount` for the same
  `sessionId` — only metadata (`retentionDeadline`, `retentionMillis`)
  updates.
- **Stable node ordering.** MAL / LAL / OAL node cards now sort by
  `nodeId ?? peer` so they don't reshuffle between polls.
- **Tab buttons jumped nowhere.** `LiveDebuggerView.selectTab` pushed
  `/debug/<tab>` (a path that doesn't exist); fixed to
  `/operate/live-debug/<tab>`. Same correction in
  `DebugHistoryView.loadEntry` deep-links and surrounding
  doc-comments in `RuleCard.vue` / `DslEditorView.vue`.
- **Empty-capture placeholder.** When a saved session has zero
  populated nodes, `DebugView` now shows an explicit "This capture
  has no records" rather than rendering blank, so an honest empty
  capture is visibly different from a bug.
- **Per-locale lookup widened.** Per-DSL views look up the historyId
  via `history.all` (not the widget-filtered `history.entries`); the
  route already pinned us to the right widget, and double-filtering
  by `widget` was a silent way for a stale field to drop the entry.

### Other small fixes

- **MAL / LAL editor gutter glyph.** The green ▶ live-debug entrance
  on every `- name:` row was referencing an unstyled CSS class —
  Monaco reserved the gutter and wired clicks, but the icon was
  invisible. Restored.
- **Rule catalog cards.** Duplicate BUNDLED pill removed; the header
  status pill already conveyed it.
- **K8s instance Node Status.** Switched from a single-scalar card
  (rendering just `1`) to a table of currently-true Kubernetes
  conditions, matching the cluster-scope sibling and aligning widget
  heights.

### Upstream `ui-management` compatibility

Aligned with upstream [skywalking#13884](https://github.com/apache/skywalking/pull/13884)
("remove auto generate id for UI templates"): Horizon now sends
`id = <envelope name>` on `POST /ui-management/templates`. Current
OAP requires it (POSTs without `id` are rejected); legacy OAP
releases ignored the field and auto-generated UUIDs, so the same
payload works against both. Horizon already treated `r.id` as
opaque; mixed-id deployments self-heal via `reconcileDuplicates` on
the next boot.

### Smartscape service hierarchy

OAP 10's cross-layer service hierarchy is now reachable from any layer's
service map — a logical service projected across observation layers
(GENERAL agent ↔ MESH sidecar ↔ MESH_DP data-plane ↔ K8S_SERVICE pod) is
one click away on every selected hex.

- **Lazy-probed chip on the selected hex.** Picking a node fires one
  `getServiceHierarchy` call; if the service has cross-layer peers, a
  small chevron-stack chip clips to the hex's right edge. No probe, no
  chip on services with no peers.
- **Focus + context + suggestions overlay.** Click the chip and the
  topology dims under a transparent canvas; the focused hex re-renders
  bright at the exact same screen position and scale as the underlying
  hex (the topology's d3 zoom transform is mirrored onto the overlay).
  Peers fan vertically from the focus column using OAP's
  `listLayerLevels` order — higher-level (request-near) layers above,
  lower-level (infra-near) layers below, matching booster-ui's
  hierarchy rendering rule.
- **Auto-refresh pauses while the overlay is open** so the background
  topology and KPI panels don't shift under the operator. Closing the
  overlay (`×` button, ESC, or click-on-dim) resumes the ticker and
  fires one immediate tick so the page snaps back to live data.
- **Two-step peer open.** First click on a peer hex arms it (selection
  halo + side `↗ Open in <Layer>` action chip); second click on the
  chip opens the destination layer in a new browser tab, pre-selecting
  the peer service. Peers in layers Horizon has no template for render
  dimmed with a `cursor: not-allowed`; clicking them logs *"No layer
  template configured for &lt;Layer&gt;"* to the event log instead.
- **URL-pinned service validator on the destination tab.** Every
  per-layer page now validates the URL-hydrated `?service=<id>`
  against the layer's real service roster (the new
  `GET /api/layer/:key/services`, served from the BFF's 60s catalog
  cache so it adds no extra OAP traffic). A genuinely missing id pops
  a `Service not found in this layer` modal with a one-click fallback
  to the first available service; a valid id is trusted even when
  landing's top-N rollup doesn't sample it (the cause of the previous
  silent service-swap on low-traffic deep links).
- **Service-name resolution** on the layer dashboard now consults the
  roster after landing's top-N, so deep links to low-traffic services
  no longer sit on *"Resolving service…"* forever waiting for a row
  that won't arrive.

### On-demand pod logs (live tail)

A new per-layer **Pod Logs** tab live-tails a Kubernetes pod's container
logs, pulled on demand from the K8s API through OAP and never persisted.

- **Instance-pinned tail.** Pick a pod, pick one of its containers, press
  Start; the trailing window (30s / 1m / 5m / 15m / 30m) streams into a
  read-only log pane and refreshes on a chosen interval (2s / 5s / 10s /
  30s) until paused. A header strip shows the container, line count, a
  live dot, and "updated Ns ago".
- **Include / Exclude filtering** forwards to OAP's content keyword
  filters — full-line regex, so a substring match reads `.*error.*`.
- **Enabled on the Kubernetes-deployed layers** — Kubernetes Services
  (`K8S_SERVICE`), Istio Managed Services (`MESH`), and Istio Data Plane
  (`MESH_DP`) — whose service instances resolve to a pod. The tab is gated
  by a new `podLogs` component flag added to those bundled layer
  templates; an existing OAP whose stored template predates the flag still
  gets the tab, because the flag is back-filled from the bundled default
  (no re-push needed).
- The page **owns its own refresh** — the global auto-refresh ticker and
  the topbar time picker are paused while on it, the same as Traces / Logs.
- When the selected instance carries no pod metadata (or the pod has
  rotated away), OAP's reason is shown verbatim with a hint to pick a
  currently-running pod or enable the feature on OAP.

### BanyanDB cold-stage query

The cold lifecycle stage is now reachable from the UI on BanyanDB
deployments — operators can query data that has aged past the
hot + warm window without leaving the page.

- **Topbar `Cold` pill** appears only when the connected OAP is BanyanDB.
  Toggling it switches every page to read from the cold stage instead
  of hot + warm — it replaces the read, it does NOT union the two stages,
  so the pill label flips to `Cold only` while on. The choice is sticky
  per browser and re-runs every visible query so what you see matches the
  new mode immediately.
- **Cold-trap banner.** When the pill is on AND the current time range is
  within the hot + warm window, a yellow strip appears under the topbar:
  *"Cold-only read is active — your time range is within the last N d
  (hot + warm), where the cold stage returns nothing."* A one-click
  *Turn Cold off* sits on the right.
- **Trace lookup from a log row** now passes the row's timestamp through
  the popout so the trace lookup spans a window around that timestamp
  instead of OAP's default last-1-day search — paired with the Cold pill,
  a trace that lives in cold resolves from a cold-era log row instead of
  silently failing to load.

### Data retention page

- **Per-data-class data lifecycle bar.** One row per data class
  (Normal / Trace / Zipkin trace / Log / Browser error log / Metadata /
  Minute metric / Hour metric / Day metric) with proportional Hot+Warm
  and (when configured) Cold segments. Widths are proportional to total
  retention across all rows, so a class retained longer visibly stretches
  further than its peers.
- When every class in a category shares the same TTL pair, the rows
  collapse to `All records (5)` / `All metrics (4)` — the page never
  renders nine identical bars.
- The page **branches sharply by backend.** BanyanDB shows the full
  lifecycle bar + stage vocabulary; on any other backend, the page
  renders a single `Retention` pane with per-class values and skips the
  stage vocabulary entirely.
- A footer note names the wire-level truth: OAP's TTL response collapses
  hot + warm into one number per class, BanyanDB migrates between stages
  in segments so records near a boundary may briefly exist in both, and
  property data is omitted (forever-retained, no TTL reported).

### Time picker

- **Custom range seeds from the last applied range** when you re-open the
  picker, instead of resetting to "half the max ending now". Reopening
  also auto-expands the Custom form on the matching precision tab when
  the current range is custom.
- Locale-bleed fix on the alarms page custom-range stamp and the log row
  date column (was rendering `5月08日` on zh-CN browsers; now uniform
  `MM-DD`).

### Overview widgets follow the global time picker

- The **Services Dashboard** (and any overview using metric / KPI / table
  widgets) now honors the topbar time picker. Previously the per-layer
  landing and topology routes were hardcoded to the last 60 minutes, so
  picking 12 days back kept showing recent numbers; now picker + Cold pill
  flow end-to-end. The layer dashboard's header KPIs follow the picker too
  (was showing live numbers while the body honored the picker).
- The **Active alarms** widget title now shows the actual window
  (e.g. `· last 10m`) and the empty-state copy uses the same value
  instead of a hardcoded "last 60m".

### Polish

- Sentence-case fixes on a couple of leftover Title-Case labels
  (`DSL management`, `Metrics inspect`) so the menu and roles tables read
  consistently; acronyms (DSL / OAP / MAL / LAL / OAL) stay uppercase.
- Public-demo (`demo.skywalking.apache.org`) references removed from
  setup docs — the demo doesn't accept anonymous traffic.

### Dashboard authoring

The Layer dashboards and Overview templates admin pages now share one
editing model where your work-in-progress lives in your browser, and the
live, shared version is whatever OAP serves.

- **Edits are local to your browser.** "Save (local)" stores your draft in
  this browser only — it is never written to the server and nobody else
  sees it. Everyone (including you, in normal viewing) keeps seeing the
  published remote dashboard until you publish.
- **Load any source into the editor.** A single **Reset to ▾** control loads
  the **Bundled** (shipped default) or **Remote** (OAP live) version into the
  editor; editing from there becomes your local draft.
- **Preview any source on the real page.** A **Preview ▾** control opens the
  actual layer / overview page in a new tab rendering your **Local** draft,
  the **Bundled** default, or **Remote** — via `?mode=preview&source=…`,
  which stays in the URL and propagates as you navigate the menu. A banner
  names what you're previewing (dismiss with × or Esc).
- **Publish with a diff.** **Check diff & push** shows a side-by-side
  local→remote diff and publishes to OAP; it's enabled only when your local
  draft actually differs from remote. Bundled can also be pushed straight to
  OAP. Resetting to remote clears the local draft. **Reset to bundled** then
  publishes correctly when the bundled default differs from remote — Save
  (local) and Check diff & push now compare the editor against remote, not
  just against what was first loaded, so a bundled-vs-remote divergence is
  no longer mistaken for "no changes" (layer + overview editors).
- Preview faithfully reflects your draft's **enabled components / menu
  labels** — disabled tabs disappear and renamed nouns ("Nodes", "Topics")
  show through — without pushing anything to the server. Preview works even
  for layers OAP currently reports no services for.
- An editors-only reminder lists any unpublished local drafts with quick
  links to the relevant edit page (no more "use local vs remote" prompt —
  remote is always the live source).
- **Create mirrors edit.** "+ New dashboard" writes a local draft (the id
  is the template name, checked unique) — edit and preview it, then
  **Check diff & push** publishes it. A pushed dashboard with no bundled
  default is **remote-only** and now renders everywhere (live page +
  sidebar), not just in the editor.
- **Delete = soft-disable** (OAP has no hard delete). A local-only draft is
  removed from the browser; a dashboard on OAP is disabled — dropped from
  the picker's live state, the sidebar, and the live page. A **disabled**
  status chip shows it. Confirmations are styled in-app dialogs, not the
  browser's native box.

### Layer dashboards editor

- The layer picker is a single filterable dropdown showing alias + key +
  sync status. A live **menu preview** sits beside the Alias / Components /
  **Menu labels** (per-layer slot aliases) editor; clicking a menu item
  jumps to that component's config. Scope tabs and section headings read in
  the layer's own vocabulary.
- The service-list metrics editor gains a **sample-data preview** (plus a
  faithful **landing KPI tile** preview that reuses the real header
  components), the column remove-button alignment is fixed, and the landing
  KPI tile config makes clear it just picks which existing column feeds the
  headline + sparkline.
- The picker's Diverged / Local filters now sit **inside the dropdown**
  (next to the search), and the editor header reads on one line —
  `Layer: <name> <key> <status>` — showing the same sync-status chip the
  picker does.
- **Disable / Reactivate a layer.** Disabling soft-disables the layer on
  OAP and drops it from the sidebar (the menu honors disabled templates);
  a disabled layer offers **Reactivate**, which re-enables it from the
  bundled default (the OAP update path clears the disabled flag).

### Overview templates editor

- Rebuilt as a **layer-style canvas**: a 12-column grid you drag to
  reorder and corner-drag to resize, click-to-edit in a right drawer that
  appears on selection (Esc / deselect hides it), with section-breaks and
  the dashboard title selectable and unselected widgets hinted by a dashed
  outline. The canvas mirrors the live grid (fixed row height), so the
  layout matches the real page — including side-by-side widgets like
  topology + alarms.
- The **composite-metrics** KPI editor stacks each row as a card
  (label / source / MQE / unit / aggr / style / max) so nothing truncates
  in the narrow drawer.

### Navigation & shell

- The **main sidebar folds** to a narrow rail to reclaim width; the logo
  moves into the topbar while folded (the original wordmark is unchanged).
- The active menu item now reliably expands, highlights, and scrolls into
  view on entering a page (route matching is case-insensitive). Fixed a
  regression where the sidebar scrolled to the very bottom on every
  navigation (the "Debug events" toggle's active state was being treated
  as the scroll target).
- **Overview dashboards appear in the sidebar only when their layers are
  reporting services.** Visibility is derived from each dashboard's
  widgets (their `layer` field) ∪ the explicit `layers[]` list, gated
  against the live `availableLayers`. A dashboard you create via "+ New"
  inherits this automatically — no need to maintain the `layers[]` field
  by hand. Polls on the 60s menu cadence + window focus, so entries
  appear / disappear as services start and stop reporting.
- **Smarter landing.** Root `/` cascades through a sensible chain so the
  user never sees a blank page: first available public overview → first
  layer with services → the **empty landing** (`/landing-empty`). The
  cascade only lands on destinations that are also in the sidebar — a
  bundled-but-inactive layer (no services yet) is deliberately not a
  fallback, since it would put the user on a page they can't navigate
  back to via the menu. The empty page is also a
  real bookmarkable route, with two distinct copies — *"No data is
  flowing yet"* (no agents/receivers reporting) vs *"No dashboard
  configured yet"* (services exist but no overview is set up) — each
  with the right operations-team handoff and no action buttons (a
  viewer's role doesn't include the verbs the old buttons jumped to).
- **Debug events panel now defaults OFF on every host** (was on for
  localhost). Same baseline for operators and developers so
  reproductions match what operators see.
- **Zipkin trace mode** drops the per-layer service-KPI header — the Zipkin
  explorer is a self-contained, cross-service view.

### 3D Infrastructure Map

A standalone, bird's-eye view of the deployment at `/3d/map`: services
render as cubes on stacked tier-planes (apps · service mesh · middleware
· infra), each tier subdivided into per-layer zones with the layer's
brand mark stamped on its colored swatch. Drag to rotate, scroll to
zoom, arrow keys / WASD to pan; click a cube for its detail card and a
link into that layer's dashboard.

- **Live data windows.** The map auto-refreshes every minute — per-cube
  traffic rolls up the last 2h of metrics (HOUR step) and alarmed
  services light up from the last 20m of alarms. A toolbar chip shows
  the active scopes (`metrics 2h · alarms 20m · ↻ 1m`). An alarmed cube
  burns red with a radiating ripple, matched to its service by (layer,
  name) so only the firing service in the right tier is flagged.
- **Live topology.** The deployment structure is read live from OAP rather
  than a bundled snapshot: each layer's service roster and service map are
  fetched one at a time (low concurrency) and assembled into the scene, so
  the map is correct on any deployment. It refreshes on the same one-minute
  cycle — an unchanged structure updates metrics/alarms in place without
  disturbing the camera, while a service appearing or disappearing rebuilds
  the affected tier. The load progresses stage by stage in the status strip.
- **Beacon mode.** A toolbar toggle dims every healthy cube to a
  wireframe ghost and lets only alarming cubes glow, so the services
  that are firing jump out instantly during an incident.
- **Logic groups.** Related layers can be clustered into a single
  labelled block on a tier — the bundled config ships a
  **Self-Observability** group (OAP, Satellite, BanyanDB, and the Java /
  Go agents) on the middleware tier. Members keep their own cube colors
  but read as one block on the map.
- **Configurable tiers + layers.** Tier order, per-layer plane mapping,
  cube colors, the traffic MQE per layer, and the logic groups are all
  driven by the 3D map config, edited on a structured admin page at
  `/admin/3d-map`. Pin each layer to a tier (with a single global layer
  filter as the top-level gate), edit each layer's color + traffic metric,
  manage logic groups (members, color, icon, tier), and choose the single
  failover tier for anything unpinned. The
  config is published to OAP and shared across the deployment the same
  way as dashboards: edits save to a local draft in your browser, then
  **Check diff & push** publishes to OAP — the map renders the remote,
  with the bundled defaults as fallback.
- **Topology clustering.** Within layers that carry a service map,
  services group into named clusters drawn as a wireframe frame with the
  cluster name baked into the frame's lower-left corner — service-mesh
  services cluster by their showcase group, Kubernetes services by
  namespace. Clustering follows each layer's naming rule, so layers
  without one keep rendering flat.
- **Navigate by tier.** The right-side **Tiers** panel is a two-level
  tree (tier → layer / logic-group). Clicking any entry resets the
  view, glides the camera to face that region, zooms in, and flashes
  the region for a few seconds so it is easy to spot. A **Reset** button
  in the panel header restores the initial framing.
- **Hover = preview.** Hovering a cube shows the same detail card as a
  click — tier, layer, service, and (when present) group and cluster —
  anchored at the cube, minus the open-in-dashboard link.
- **Call-direction flow.** Call relationships animate directional
  particles so the direction of traffic reads at a glance.
- **Focus one layer.** The per-layer service map gains a **View in 3D**
  link that opens the map focused on just that layer.
- **Refresh countdown.** The load status strip shows a live countdown to
  the next refresh, anchored to the stage that will run next.

### Reliability

- When the BFF is unreachable the UI now shows a clear "Cannot reach the
  server" message instead of the cryptic "body stream already read" — the
  API client reads each error response body once and surfaces the real
  status/text (or a wrapped network error).
- **Server-global service-by-layer catalog.** One singleton on the BFF
  (60s TTL + single-flight) now owns the `listLayers` + aliased
  `listServices(layer)` fan-out. The sidebar menu's per-layer counts and
  the alarms layer-tagger share this one cache instead of each running
  their own poll, so OAP sees at most one fan-out per minute regardless
  of how many routes are polling — and the two views can no longer drift
  by 60s relative to each other.
- The brand link and the post-login redirect no longer resolve to an
  empty address — both now land on the operator's actual landing route.
- Trace span detail now labels the span direction as **Kind** (the noun)
  rather than the mistranslated verb form, and long tag keys wrap inside
  the panel instead of overflowing their column.

## 0.5.0

First Apache-style release cut from this repo: source + binary tarballs,
GPG-signed and SHA-512 checksummed, with a self-contained binary that
boots via `node server.js` and no `pnpm install` step. Binary distribution
ships a regenerated `LICENSE` + `NOTICE` that enumerate every bundled
third-party package — produced by `scripts/collect-dist-licenses.mjs`
during packaging and validated against a deny-list before signing.

### Profiling

- **pprof (Go) profiling** is fully wired: pick one event per task (CPU /
  HEAP / BLOCK / MUTEX / GOROUTINE / ALLOCS / THREADCREATE), with duration
  shown for CPU/BLOCK/MUTEX and a sampling-rate field for BLOCK/MUTEX. Create
  and analyze both match OAP's single-event pprof schema.
- **eBPF profiling** gets a reworked process picker — click a row to expand
  its full attributes, selection lives on the checkbox, anchored pop-out — a
  refresh button on every task list, Intl-formatted times, and a hover-info
  frame on the flame graph. Flame-graph thrash on re-analyze is gone.
- The shared flame graph fixes "% of root" (it read a never-aggregated count),
  highlights the selected frame across all four profilers, and shows a single
  hover card (the library's duplicate native tooltip is suppressed).
- After creating any profiling task (trace / async / eBPF / network / pprof)
  the list now polls up to 4× at 10s until the new task shows up, instead of
  leaving a stale pre-create list.

### Network profiling & process topology

- A booster-style honeycomb process topology: pods as hexagons, peers hugging
  the boundary, animated protocol-coloured edges (HTTP/TCP/TLS), a node
  pop-over, and a wide client | server edge-metric dashboard. Network task
  creation and the task-list query now use OAP's schema field names.

### Platform monitoring (operate)

- Two new read-only operate pages: **Data retention** (TTL — `getRecordsTTL` /
  `getMetricsTTL`) and **OAP configuration** (the admin-port config dump, with
  OAP-masked secrets). Gated on new `ttl:read` / `config:read` verbs granted to
  maintainer and above. Data retention now loads on non-BanyanDB backends too
  (the `metadata` TTL field is optional).
- The operate sidebar now leads with a single **Platform monitoring** group
  (cluster status, data retention, OAP configuration) above the per-layer
  self-observability dashboards.

### Dashboards & templates

- **The global time picker now drives dashboards.** Layer dashboards query
  OAP at the picker's window and precision (MINUTE / HOUR / DAY) instead of a
  fixed last-hour minute window, and line charts label the x-axis with real
  times per step (e.g. `MM-DD` for a 30-day view) rather than `-Nm`.
- **New `table` widget** for label-dimensioned metrics — pod phase per service,
  node condition, deployment replicas, etc. — rendered as one column per label
  (e.g. `Condition | Node`) instead of a scalar card or a misleading flat line.
  The K8S dashboards (and kong / mongodb / elasticsearch) now use it where
  upstream booster-ui does; widgets that were charting a single `latest(…)`
  value as a line are now cards. The K8S Cluster view is realigned to the
  upstream layout (totals cards · resource lines · status tables).
- **Edit locally, publish on your terms.** Saving a dashboard/overview template
  now writes the local bundled copy (so the edit renders immediately for
  preview) and marks it diverged — nothing reaches OAP until you press
  **Sync all to OAP**, which pushes only the templates that differ, behind a
  confirmation listing exactly what will be written. A post-save tip spells out
  that the change is local-only until published.
- **Local-vs-remote, made explicit.** When local edits diverge from OAP, a
  per-session prompt (by menu name, not file name) asks which to render —
  **keep my local edits** (preview) or **use live** (which overwrites the local
  copy with the remote version, confirmed). The layer-templates admin page
  carries the same Local/Remote display toggle next to Sync all, and a
  **Diverged only** filter; each diverged layer shows a yellow warning icon in
  the sidebar.

### Traces

- The native trace view auto-selects OAP's trace-query API — `queryTraces`
  (whole trace inline, BanyanDB) vs `queryBasicTraces` (segment list + a
  per-trace fetch on click, every other backend) — and a banner states which
  is in use; in segment-list mode the list reads "Segments" and a click loads
  the full trace.
- Span kind (Entry / Exit / Local) renders as a colored word, not a filled pill.

### Auth, RBAC & resilience

- Every OAP call — GraphQL, admin REST, and Zipkin — now carries the
  configured basic-auth credentials, so a secured OAP no longer 401s pages.
- The sidebar is RBAC-gated by read verb, the Roles page shows a per-role
  menu-visibility matrix, and the Users page labels per-node "Active (24h)" /
  "Last seen" honestly (these are tracked per BFF replica, not cluster-wide).
- **Routes are verb-gated, not just menus.** A user without the required read
  verb is bounced from a restricted page (e.g. a viewer can no longer reach
  Cluster Status via the topbar OAP chip or a direct URL); the chip only links
  there for `cluster:read`. This sits on top of the existing per-route BFF verb
  enforcement.
- **LDAP** resolves group membership with the service account, not the
  logging-in user — directories that hide the group subtree from ordinary users
  no longer collapse every login to the fallback role.
- When OAP is unreachable the menu and admin loaders fall back to bundled
  templates, and non-JSON OAP responses surface a clear diagnostic.

### Smaller touches

- Top-N widgets get hover tooltips for long names and a title-bar pop-out to
  the full ranked list; redundant single-service name prefixes are dropped.
- The admin template-diff modal is a wide side-by-side view with labelled
  bundled-vs-OAP columns and an explanation of what the template drives; the
  layer-dashboards admin rail gains an in-page search.
- Per-layer alarm filtering uses the singular `queryAlarms` layer condition.
- Dependency hygiene for the release: `dompurify` ≥ 3.3.2 and
  `@fastify/static` ≥ 9.1.1 (clears the known advisories); the `general`
  layer drops `networkProfiling`, which is instance-scoped to k8s / mesh.

## 0.4.0

OAP becomes the runtime source of truth for UI templates, the 5-theme system
lands, and the app supports being served behind a gateway prefix.

### Templates synced to OAP

- Five reserved template families now live on OAP's UI-template REST surface
  (`/ui-management/templates*` on the admin port): overview dashboards, per-layer
  dashboards, alert page setup, theme selection, time-defaults. Bundled JSON
  ships as the seed + read-only fallback.
- One-shot seed on BFF boot pushes any missing bundled template to OAP; runtime
  sync is read-only with a 30-second single-flight cache.
- New admin endpoints: `GET /api/admin/templates/sync-status`,
  `POST /api/admin/templates/save`, `POST /api/admin/templates/resync`,
  `POST /api/admin/templates/:name/push-bundled`.
- When the admin port is unreachable, every admin page goes read-only with a
  red banner; Save / Create / Delete are disabled; render falls back to bundled.
- Diverged rows surface a "Show diff & reset" Monaco modal with a
  destructive-confirm (type the template key to arm reset).

### Themes

- Five bundled themes — **Horizon** (default), **Meridian**, **Obsidian**,
  **Daybreak**, **Aurora** — each shipping a complete token set (bg, fg,
  accent, info/ok/warn/err, font, radius, density).
- New `/admin/global-defaults` admin page replaces the old "Setup" link.
  Theme picker uses preview cards lifted from the design (hero strip,
  mini-app mockup with Primary/Tonal/Ghost buttons, KPI tiles, sparkline,
  density/font/radius badges).
- Per-user theme override via a labelled topbar chip — three-tier resolution
  `localStorage user → OAP org default → bundled`, written to
  `<html data-theme>` / `<html data-appearance>` synchronously on boot so
  the pre-auth login page already respects the local override.
- Sidebar SkyWalking logo swaps to the official brand blue (`#1368B3`) on
  light-appearance themes.
- Widget series colors (Zipkin trace palette, AlarmSnapshotChart,
  AlarmsTimeline) track the active theme's `--sw-accent` via a shared
  `readAccent()` util.
- Sign-in button gradient derives both stops from the theme accent.

### Time defaults

- `/admin/global-defaults` also owns the global picker's default window
  (60 minutes shipped). OAP `step` precision is derived from window size —
  ≤ 4 h MINUTE, 6 h–14 d HOUR, ≥ 30 d DAY — and surfaced inline on the page.
- Per-user override in the topbar time picker: "Save as my default" /
  "Reset to org default".

### Reliability + diagnostics

- Topology cluster boundary now grows to encompass dragged nodes; the chip
  moved inside the cluster header so it stays visible at any drag position.
- Alarms page gains an **Other** KPI tile that surfaces the residual count
  between `Active` and the sum of pinned-layer chips — `Active = General +
  Mesh + Other` reconciles even when alarms land in unmapped layers.
- Overview "Active alarms" widget now reads the admin's configured
  `defaultWindowMs` from `/admin/alert-page-setup`; all three alarm
  surfaces (overview widget, alarms page, topbar badge) share one window.
- Every backend call failure (network throw or non-2xx) writes a
  `pushEvent('api', 'err', …)` into the debug event log with the BFF's
  `code` / `message` envelope inlined when present.
- Dashboards with more than 40 widgets (e.g. the General/instance page,
  56 widgets) now succeed: the UI splits oversize requests into ≤40-widget
  chunks fired in parallel, then merges results.

### Deployment

- Gateway-prefix support: `BffClient.request()` prepends
  `import.meta.env.BASE_URL` to every API path. Build with
  `vite build --base=/horizon/` and a gateway that strips the prefix and
  the SPA + every API call resolves cleanly under the sub-path.
- Cluster Status route corrected from `/admin/cluster` → `/operate/cluster`
  (the prior default 404'd because no route by that name existed).

### Cleanup

- Documentation rewritten as an orientation map; the left-side menu is the
  canonical navigation now. All `SWIP-*` references removed from
  user-visible text and docs.
- "Coming in Phase 6 / 7" placeholder strip on Cluster Status removed.
- Dead code dropped — `LandingView.vue`, `LayerTabPlaceholder.vue`, the
  orphaned disk-write template routes (`POST /api/admin/overview-templates/:id`
  + `POST /api/admin/layer-templates/:key`), and stale `Phase X` markers
  across BFF + UI + docs.
- The OAP UTC-offset chip is gone from the topbar; the health dot stays.

## 0.3.0

The shell unifies, the operate stack lands, and the first round of public
documentation ships.

### Operate stack

- **Alarms page** — incident-merged active-alarms view, severity tabs,
  alarm list with right-side detail (trigger expression, channel routing),
  inline Live Debug card (Run / Step / Pause / Copy as MQE, execution-trace
  ladder with per-step output + latency, matched entities, eval-window
  chart, raw OAP response).
- **Inspect** — metric catalog + entity enumerator with search, type
  filter, scope (Service / Instance / Endpoint / Process / All), and
  source attribution.
- **Live Debugger** — MAL / LAL / OAL session start, poll, stop. Per-node
  status fan-out, sample payloads, capture history with replay-ready
  recordings.
- **Profiling** — flame graph + stack table over five profilers:
  trace-driven thread profiling, eBPF CPU/off-CPU, JVM async-profiler,
  network profiling (process conversation graph), Go pprof.
- **Zipkin trace explorer** — service / span search, waterfall popout
  with per-service color bands, sticky time-axis.
- **Overview dashboards** — cross-layer war-room views (Services, Mesh)
  with per-layer KPI tiles, alarm rails, and the existing chart widgets.

### Auth + access control

- Local + LDAP authentication backends. Break-glass admin honored only
  when `backend: ldap` AND the LDAP probe is failing.
- Three admin pages — Users, Auth status, Roles & permissions.
- 4 built-in roles (viewer / maintainer / operator / admin) and a
  28-verb permission model. Every BFF route gated by a single policy
  table.
- Login view redesigned (canyon hero, status pill, configured-backend
  banner).

### Reliability + UX

- Cascade-clear, then load — every dependent area visibly resets and
  shows "Reading data…" between an upstream control change (service /
  instance / endpoint pick, time-range change, layer / scope nav) and
  the new data landing. No silent freezes; no stale value sitting under
  a spinner.
- Global time picker in the topbar wired into the landing + widget
  query keys; the picker only applies to dashboards / overviews (triage
  pages keep their own per-page time).
- Single-shot bundle preload: layer dashboards + overview list arrive
  in one round-trip, cached in localStorage with ETag revalidation.
- Framework event ticker in the topbar replaces breadcrumb+search;
  Admin-toggled debug panel surfaces a 200-event buffer with operator
  click capture.
- Auto-pick first instance / endpoint when a scope needs one and the
  list is non-empty.
- Topology + dashboard fixes, multi-layer service attribution, sticky
  service selection across navigations.

### Documentation

- First public docs tree (`docs/`) — Setup, Compatibility, Access
  Control, Customization, Components, Operate. Lives in-repo and
  publishes to skywalking.apache.org.

### Container + CI

- Real `packages/*` builds + self-contained `dist/` + copy-in image
  (no compile in the container).
- Zero-config boot: image defaults `HORIZON_SERVER_HOST=0.0.0.0`.
- Multi-arch publish-image — native amd64 + arm64 builds, OCI manifest
  list.
- Unit-test job in CI; 107 UTs covering entity-scope construction +
  routing decisions.

## 0.2.0

Per-layer dashboards become real, the layer-template editor ships, and
topology gets its booster-ui port.

### Per-layer dashboards

- Real widget grid per layer driven by JSON templates. 43 layer
  dashboards migrated from booster-ui.
- Per-scope widget sets: each layer template defines its own `service`,
  `instance`, `endpoint`, `topology`, `traces`, `logs`, profiling
  variants.
- Visibility predicates per widget (`visibleWhen`) so MQ / DB widgets
  only render when the relevant metrics are reporting.

### Layer admin

- Read-only template browser, then full edit UI: components editor
  (toggle which per-layer views exist), metrics editor (header columns),
  separate Overview tile card, scope-aware visibleWhen hints.

### Service deep-dive

- APIs widget (formerly Services), MQ widgets gated by visibleWhen,
  TopList multi-expression switcher with MQE preview in tooltip,
  smaller widget height, per-metric color alignment, dual-axis MQ.

### Topology

- Polished linear-chain variant, dual-panel detail, per-side line
  charts. Drag-to-move + barycentric layout for smaller graphs.
  RPM-only chip variant. Istio renamed.

### Logs

- Legend at top of table (drop service facet duplication), workflow
  notes.

### Charting

- TimeChart: legend formatting fix for dual-axis widgets, value dots,
  tooltip escape for clipped charts, no more legend / axis-name
  crowding at chart top.

### Sidebar + chrome

- Group toggle + group click cascades to first layer's first tab.
- Topbar 60m widget format hints (int / decimal / compact).
- Per-layer image pipeline (icons) shipped.

## 0.1.0

Foundational scaffolding. The shell renders, auth works, OAP is reachable,
and CI is green. No operator-facing data surfaces yet.

- pnpm monorepo: `apps/ui` (Vue 3 + Vite), `apps/bff` (Fastify), shared
  `packages/api-client` (typed REST + GraphQL clients), shared
  `packages/design-tokens` (CSS custom properties).
- BFF — Fastify skeleton with `horizon.yaml` config + hot reload, local
  auth (argon2 + cookie sessions), RBAC verb gating + JSONL audit log,
  OAP proxy with cluster fan-out + preflight.
- UI — AppShell (sidebar, topbar) with design tokens, Pinia auth store
  with on-401 redirect, login view with route guard + sign-out, stub
  admin / operate pages.
- CI — monorepo workspace build + dependency license check via
  `skywalking-eyes`.
