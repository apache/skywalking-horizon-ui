# Changelog

Notable changes to Apache SkyWalking Horizon UI, written from the operator's
point of view — what's new on screen and what's now possible, not the
file-by-file implementation. For per-commit detail, see the git log.

The version line is shared by every package in the monorepo (apps + shared
packages) plus the BFF's `HORIZON_VERSION` default.

## 0.6.0

### Eight-locale internationalization

Horizon now ships with eight first-class UI languages — English (source)
plus zh-CN, ja, ko, es, pt, de, fr — selectable from the top-bar locale
chip on every page (including the pre-auth login). The choice persists
per device.

- **UI chrome.** Every routed page (31) and every shared sub-component
  (24) renders through `vue-i18n`. The English catalog is the source
  of truth at 531 keys; every other locale carries 531 native
  translations. Missing keys fall back to English at the leaf, so
  partial catalogs are valid and degradation is invisible.
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
  OAP. Resetting to remote clears the local draft.
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
