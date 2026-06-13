# CLAUDE.md - AI Assistant Guide for Apache SkyWalking Horizon UI

This file states the **principles** for working in this codebase. It is not a how-to. Code details (directory layout, tech-stack versions, function names, step-by-step recipes) belong in the code itself — read the code when you need them.

## What this project is

**Horizon UI** is the next-generation web UI for [Apache SkyWalking](https://github.com/apache/skywalking). The goal is **feature parity** with [skywalking-booster-ui](https://github.com/apache/skywalking-booster-ui) on the **same OAP GraphQL query-protocol and MQE**, with a modernized, dense, dark-first design. This is a **greenfield rewrite**, not a fork. Backend APIs do not change.

## How to work (the only workflow that matters)

> **Correctness comes first. Speed comes from getting it right the first time, not from skipping steps.**

Every non-trivial change follows the same loop:

1. **Read the code.** Read it end-to-end along the path you intend to change: call site → handler → response shape → consumer. Comments, this file, and prior conversation are *reference* — the source of truth is the current code on disk.
2. **Implement.** Match what the surrounding code already does. If you have to invent a pattern, you probably haven't finished step 1.
3. **Validate against a live OAP.** Run the change against a real OAP server and confirm the wire request/response and the rendered UI. Type-checks and unit tests verify code, not feature behavior.

If no OAP is available to validate against, **stop and ask the developer to provide one** (URL, credentials, demo endpoint, port-forward — whatever). Do not guess at wire shapes, do not mock the data and call it done, do not declare the work complete from a green type-check alone. "I couldn't validate" is an honest, acceptable outcome — silently shipping unvalidated changes is not.

When you can't reproduce the user's symptom locally, say so. Don't invent a fix.

## Backend compatibility

The UI talks to OAP through the **GraphQL query-protocol** (same as booster-ui) and through OAP's admin REST surface. Both contracts are **fixed** — owned by the skywalking repo, not this one.

- **Do not invent fields.** If a screen needs data the protocol doesn't expose, flag it. The right fix is a query-protocol change upstream, not a UI hack or a BFF-side fabrication.
- **The schemas and Java implementations are the authoritative spec** — read them (`oap-server/server-query-plugin/.../query-protocol/*.graphqls` and `oap-server/server-core/.../query/`) before guessing at a wire shape. Stand up a local OAP (the SkyWalking repo ships a docker-compose) for smoke-testing wire changes.
- **Booster-ui is the working reference.** When in doubt about how a query is shaped or paged, look at how booster-ui does it.

### Metric entity-scope is load-bearing

Every OAP metric lives under exactly one entity scope (Service / ServiceInstance / Endpoint / relations / Process / All). OAP does not auto-rollup between scopes — querying at the wrong scope returns empty results regardless of MQE wrapping. Before adding or moving a metric, verify its scope against the OAP catalog and confirm it matches the page that will render it. Never invent a BFF-side rollup to bridge a scope mismatch — move the metric or leave the slot empty.

### Time, step, and timezone

- **Step precision is page-family-specific.** Dashboards / overviews / landing scale step with the rolling window (MINUTE / HOUR / DAY). Alarms / traces / logs / live debugger use SECOND because they query event-style data anchored at second precision — MINUTE rounding chops off the most recent (most interesting) events. MQE traffic backdrops use MINUTE because metrics are aggregated at minute granularity.
- **String format is determined by step.** Mixing them throws `verifyDateTimeString` on OAP. Read `DurationUtils.java` in the skywalking repo for the canonical mapping.
- **OAP has a per-request bucket cap.** Long windows must be chunked. Storage backends impose stricter caps that vary by backend — probe, don't assume.
- **All time strings are OAP-server local.** Not UTC, not browser-local. The server's offset is exposed via `getTimeInfo`. The BFF owns this conversion; the UI displays in browser-local (echarts handles ms → local natively).
- **Per-page vs. global time.** The topbar time picker applies only to layer dashboards + overviews. Triage / investigation pages (alarms, traces, logs, profilings, live debugger) own their own time range — do not subscribe them to the global ticker.
- **Picker wiring is a two-sided contract.** The time range only reaches OAP when the UI composable forwards it AND the BFF route accepts it. Verify the actual request, not the intent.

### Other OAP sharp edges

- **Storage backends have undocumented limits.** Page sizes, nested selections, and per-record sub-queries fail at backend-specific thresholds. Degrade list queries to the cheapest selection that satisfies the screen; probe before defaulting.
- **OAP IDs are not always per-record unique.** Some wire `id` fields key on the alarmed/related entity, not the firing instance. Disambiguate composite keys with timestamp before using `id` as a row key.
- **Widget type follows MQE shape.** A widget whose MQE collapses to a single scalar must be `type: "card"`, not `type: "line"`. The tell-tale is the outermost call: `latest(...)`, `max(...)`, `min(...)`, `avg(<plain-metric>)`, `sum(<plain-metric>)` all reduce the window to one number — line-charting a single point is wasteful and misleads operators into thinking the metric is time-varying. Series-shaped wrappers (`relabels(...)`, `top_n(...)`, `histogram*(...)`, `aggregate_labels(...)` without an outer scalar collapse, `rate(...)`, `increase(...)`) stay `line`. When adding or porting a widget, look at the outermost function first.

## Design source of truth

Design tokens live in the runtime token CSS (`apps/ui/src/assets/styles/tokens.css`) — that copy is canonical. The early-build HTML/JSX prototype bundle has been retired now that every screen has a Vue implementation with visual sign-off. When a new screen is needed, the existing dark-dense vocabulary in the rendered UI is the spec; match it.

`docs/` is now the **public website docs** tree (committed, flat layout, see `docs/menu.yml`). Do not put planning notes, research dumps, or design prototypes there — those stay out of git.

**Docs are written for the end user (operator / dashboard author), not the contributor.** Document what a feature *does*, how to *configure* it (YAML, fields, recipes), and how to *operate / troubleshoot* it. Do **not** document the internal code workflow: no step-by-step algorithms ("1. service-bind 2. user search 3. …"), no source-file paths (`apps/bff/src/...`), no internal function / composable / route names, no "the BFF then fans out / chunks / probes …" implementation narration. If a sentence only makes sense to someone reading the source, it doesn't belong in `docs/`. Describe observable behavior and configuration, not how the code achieves it.

## Internationalization

English is the source of truth. Every UI string and every translatable template field is authored in English first; the English bundle ships in the main JS chunk so the app renders without any network locale fetch. Other locales (zh-CN, es, pt, ja, ko at the time of writing) are catalog overlays. A missing key in any non-English catalog falls back to English at the leaf, never at the file — half-translated catalogs are valid and expected. Edit English first; re-translate downstream.

**Translation principles:**

- **IT terms and proper nouns stay in their original form.** Product, project, and protocol names (SkyWalking, Kubernetes, Envoy, Istio, OAP, MQE, eBPF, Zipkin, OpenTelemetry, gRPC, GraphQL, Java, Go, …), OAP scope enums (Service, ServiceInstance, Endpoint, Process), layer keys (GENERAL, MESH, K8S_SERVICE, …), metric ids, MQE function names, and HTTP / SQL / log keywords are **not** translated in any locale. Operators read these terms across docs, source, and other SkyWalking surfaces — they must remain recognizable.
- **Translate meaning, not words.** Use idiomatic, native phrasing. A literal word-for-word translation that reads like machine output is worse than leaving the string in English — restructure the sentence if the target language needs it. Faithfulness is to the *intent*, not the English syntax.
- **OAP-supplied data is never translated.** Service names, instance names, endpoint names, alarm rule names, tag values, log messages, trace span operation names, anything coming over the OAP wire — that's mutable user data from outside our control, render verbatim regardless of locale. The only OAP-adjacent strings we translate are the layer `alias` and `aliases.*` fields *inside our own templates* (which name the enum for display); the enum value itself is not translated.
- **Initial translations are AI-assisted, and that's fine.** When seeding a new locale, modern models handle the technical vocabulary competently — we use them as the starting point and ship. Native speakers refine over time as they spot phrasings that aren't quite right; the in-app locale picker and docs invite corrections via PR. Don't treat AI translations as second-class.
- **Resolution split is fixed.** UI chrome (Vue templates, validation, error toasts, login page, topbar, sidebar, modals, placeholders) resolves client-side with vue-i18n. BFF-shipped templates (bundled layer dashboards, bundled overview dashboards) and user-maintained dashboards stored on OAP resolve BFF-side from sibling `*.i18n.<lang>.json` catalogs before the response leaves the BFF. The UI never sees template translation keys; the BFF never serves UI chrome strings.
- **Catalog drift is a build-time error.** Catalog keys that don't exist in the source template are pruned at load with a warning; non-string values at translatable paths are dropped. Source structure is the contract.

## Things that are non-negotiable

- **TypeScript strict.** No `any` outside `.d.ts` shims.
- **Charts are wrapped.** Never instantiate ECharts directly in a view — always go through the chart components. Same rule for D3: composable owns the lifecycle, tears down on unmount. (This lets us swap libraries and centralize theming/disposal.)
- **One icon component.** No icon font, no inlined SVG one-offs.
- **No CSS-in-JS, no Tailwind.** The design is built on CSS custom properties; Tailwind fights the token system.
- **License headers** on every `.ts` / `.vue` / `.js` / `.yaml` / `.yml` / `.css` / `.scss`. JSON, Markdown, lock files, and generated `.d.ts` are excluded — see `.licenserc.yaml`. CI enforces; run `license-eye -c .licenserc.yaml header check` before pushing.
- **Multi-layer is the spine.** Almost every screen has "this could appear in multiple layers" semantics. Build for that from day one.
- **Synced crosshairs.** Multiple time-series on a dashboard share one cursor. Don't build charts that ignore this.
- **Density beats whitespace.** This is an observability-class UI; information density is a feature.
- **Cascade-clear, then load.** When an upstream control changes (service / instance / endpoint pick, time-range change, layer / scope nav) and the downstream queries have to refire, the dependent area must visibly RESET first and show an explicit "Reading data…" (or equivalent) hint while the new query is in flight. Never leave the prior value sitting under a spinner — operators read it as the new state and trust broken data. Never let the page sit silently between the click and the result either; that looks like a freeze. Each control owns its own reset + indicator (widget grid, picker list, header KPIs, …) and resolves async as its query lands. This is the same trailing-control principle that gates `enabled` in the data layer (后置的控件，必须要监听前置控件的变化，之后再触发); the display layer has the same obligation.
- **MQE is a core capability**, not a config-screen afterthought. User-editable, syntax-highlighted, debuggable.
- **Admin views use the same look.** LDAP/RBAC/admin are dark, dense, design-tokens — not a separate "settings" UI. Alarms are read-only on the UI side; recovery is backend-automatic (no acknowledge/close/silence actions).
- **Comments earn their keep.** A comment should carry only what is **not obvious from reading the core code** — a highlight, a special case, or an edge case worth flagging for a future reviewer. Two valid uses: (1) introduces an API — what a module / component / exported function is for and how callers should think about it; (2) highlights a non-obvious gotcha — a hidden invariant, a workaround for a specific upstream quirk, a subtle scope/timing constraint, an edge case the reader would otherwise miss. Do **not** write comments that paraphrase the code (`// loop over layers`, `// click handler — toggles open state`, `// returns true when active`). Do **not** leave history-as-comments (`// previously …`, `// moved from …`, `// see commit …`) — that belongs in `git log`. If removing the comment wouldn't confuse a future reader who knows the project, the comment shouldn't be there.
- **Layering — BFF.** `apps/bff/src/` is grouped by role, and the flow is one-directional: `http → logic → client → OAP`.
  - `http/{query,config,admin}/` — Fastify route handlers only. Thin: parse, dispatch to logic, shape the reply. No OAP I/O directly.
  - `logic/<domain>/` — domain orchestration + background timers (alarms store, layer/overview/setup loaders, preflight status check, inspect parsers, dashboard defaults). No HTTP framework, no OAP fetch detail.
  - `client/` — the only place that talks to OAP (GraphQL + admin REST + Zipkin + cluster fan-out). Wrap upstream errors into typed envelopes here.
  - `util/` — pure helpers used anywhere (time formatting, MQE target/catalog cache, trace-protocol cache).
  - `user/` + `rbac/` — session/auth + verb policy, enforced at the http edge.
  Don't import `client/` from `http/` directly; route through `logic/` so the orchestration layer stays the seam.
- **Layering — UI.** `apps/ui/src/` follows the same role-based grouping. The guiding rule is **feature code stays cohesive with its feature; shared code is feature-AGNOSTIC only** (fonts, styles, formatters, generic primitives, charts wrappers). A component or composable that knows about a feature's data lives WITH the feature, not in a shared pile. Features don't import from each other.
  - **`api/`** — façade `bff.<scope>.<method>()` over the BFF. Only path to HTTP; no `fetch()` calls anywhere else.
  - **`shell/`** — chrome every page lives in (AppShell / AppSidebar / AppTopbar / GlobalConnectivityBanner / AdminFeatureWarning / PlaceholderView / LandingView), plus `router/index.ts` and the framework-level composables the sidebar/topbar need (`useLayers`, `useLandingOrder`, `useOapInfo`, `useAdminFeatures`). Knows about layers + routes, never about specific feature data.
  - **`controls/`** — cross-cutting controls owned by the topbar / shell. The time-range store, the auto-refresh ticker + its subscriber, the per-session client id. Pages subscribe, never own.
  - **`state/`** — global app state (`auth`, `setup`). Pinia stores that survive route changes.
  - **`features/<feature>/`** — static feature pages. Each folder is fully self-contained: its views, its composables, its feature-specific components. Operate sub-features (`cluster/`, `inspect/`, `dsl/`, `live-debug/`) share their cross-cutting bits via `features/operate/_shared/` (Modal / MonacoYaml / MonacoDiff / RuleCard / DestructiveConfirm / grouping).
  - **`layer/<tab>/`** — the per-layer drill-down stack. Top-level files are the shell (`LayerShell`, `LayerServiceSelector`, `LayerTabPlaceholder`) plus shared layer composables (`useLayerLanding`, `useLayerEndpoints`, `useLayerInstances`, `useSelectedService/Instance/Endpoint`). Each tab subfolder owns its view + composables + tab-specific components (e.g. `layer/traces/` contains `LayerTracesView.vue` + `NativeTraceWaterfall.vue` + `TracePopout.vue` + `useLayerTraces.ts`).
  - **`render/`** — template-driven render. `render/overview/` and `render/layer-dashboard/` are generic renderers driven by JSON templates from the BFF; `render/widgets/` holds the reusable widget primitives (AlarmsWidget, MetricWidget, ServiceCountWidget, …). New dashboards mean new templates, not new Vue files.
  - **`components/{primitives,charts,icons}/`** — feature-agnostic shared building blocks. Stateless, no business logic. If a component starts needing feature data, move it INTO the feature; don't enrich the shared pile.
  - **`monaco/`, `utils/`, `assets/`** — same shared-is-feature-agnostic rule: editor setup, formatters, stylesheets, icon SVGs. New helpers land here only if more than one feature needs them and they don't carry feature semantics.

## Commits & PRs

**Never** add `Co-Authored-By: Claude` (or any AI / Anthropic / claude.com / `noreply@anthropic.com` line) to commit messages or PR bodies. Do not append the "🤖 Generated with Claude Code" footer. Per-project directive.

## Changelog (`CHANGELOG.md`)

Keep `CHANGELOG.md` current as part of the change, not as an afterthought. Written from the operator's point of view — what's new on screen and what's now possible — never file-by-file implementation (that's the git log).

- **New features go in the changelog.** Any operator-visible capability — a new page / tab / widget, a new component flag, **bundled template changes** (a layer gaining a capability, new dashboards / widgets / metrics), a new admin surface — must be recorded under the current **unreleased** version section. If a change alters what an operator sees or can do, it belongs here.
- **Released version sections are frozen.** A version that's been tagged/released only ever receives **bug-fix** entries afterward (and only for fixes shipped to that line). Never add a new feature to an already-released version's section — features always land under the current/next unreleased version. The current version is `*-dev` in `package.json`; the newest released line is the latest `v*` git tag.
- **One line per paragraph and per list item — do not hard-wrap prose.** A GitHub **Release** body (rendered by the same engine as issue / PR / discussion comments) turns every single newline into a literal `<br>` (GFM hard line breaks), so a paragraph hard-wrapped at ~80 cols renders as a ragged column of short lines with a sea of right-hand whitespace. The repo file view collapses those same newlines to spaces, so the damage is invisible there — you only see it on the release page. Keep each paragraph / bullet on one physical line and it renders correctly in both. Separate items with a blank line; nested bullets each take their own line. This is the house style for `CHANGELOG.md` **and** Markdown under `docs/`. The release pipeline still unwraps at publish time as a backstop (`scripts/changelog-release-notes.mjs`); run it with `--whole-file` to normalize an existing file to this style.

## Common AI failure modes to avoid

1. **Skipping the read.** If you change a route, composable, store, or template without reading it end-to-end first, you will break something subtle. Read first, every time.
2. **Validating with type-checks instead of OAP.** Green `tsc` and green tests do not prove the feature works. If you can't hit a real OAP, ask for one.
3. **Blanket reverts.** `git checkout <file>` discards anyone else's uncommitted changes too. Diff first, revert by hunk.
4. **Faking backend data to "unblock" yourself.** A mocked response that shapes nothing real is worse than no response — it hides the real wire mismatch until much later. Ask for OAP access.
5. **Inventing layouts.** The rendered UI is the visual spec; match the existing dark-dense vocabulary rather than introducing new conventions. If something is genuinely new, ask before designing.
6. **Dead-route / parameter jumps.** Every `router.push({ path: '…' })`, `<router-link to="…">`, and `entry.widget`-style URL-built path must resolve to a route that's actually defined in `apps/ui/src/shell/router/index.ts` — grep it before you commit. Stale paths (`/debug/mal`, `/debug/history`) compile and ship, then dead-end at runtime with a blank page and no error. **Audit twice:**
    - *The path.* If you refactor route paths anywhere in the app, grep the entire source tree for every push / `to=` / `router.push({ path })` that targets the old prefix — including dynamic builds like `` `/operate/live-debug/${widget}` ``.
    - *The parameter-on-mount flow.* When a route takes a query/path param the view loads on first mount (e.g. `?historyId=`, `?catalog=&name=`), the watch that consumes it almost always uses `{ immediate: true }` — which fires *during* setup. Any ref the handler writes to must be declared *above* that watch in the file, or you get a TDZ ReferenceError that silently aborts setup and leaves the page blank with no console trace. Hoist resettable refs above their consumer; never assume Vue's compiler will hoist `const`.
