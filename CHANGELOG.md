# Changelog

Notable changes to Apache SkyWalking Horizon UI, written from the operator's
point of view — what's new on screen and what's now possible, not the
file-by-file implementation. For per-commit detail, see the git log.

The version line is shared by every package in the monorepo (apps + shared
packages) plus the BFF's `HORIZON_VERSION` default.

## 0.6.0

(In development — fill in highlights here before cutting the release.)

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
