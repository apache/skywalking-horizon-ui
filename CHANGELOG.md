# Changelog

Notable changes to Apache SkyWalking Horizon UI, written from the operator's
point of view — what's new on screen and what's now possible, not the
file-by-file implementation. For per-commit detail, see the git log.

The version line is shared by every package in the monorepo (apps + shared
packages) plus the BFF's `HORIZON_VERSION` default.

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
