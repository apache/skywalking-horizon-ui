# Apache SkyWalking Horizon UI

<img src="https://skywalking.apache.org/assets/logo.svg" alt="SkyWalking logo" height="90px" align="right"/>

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

Horizon UI is the next-generation web UI for [Apache SkyWalking](https://github.com/apache/skywalking) — a config-driven, dark-dense, multi-layer observability front end built for feature parity with the legacy [skywalking-booster-ui](https://github.com/apache/skywalking-booster-ui) on the same OAP GraphQL query-protocol and MQE. It renders services, instances, endpoints, topology, traces, logs, alarms, and profiling across 44 instrumentation layers, and ships an in-browser admin suite for runtime rules, RBAC, template management, and cluster status. Dashboards are JSON templates published to OAP — new screens are configuration, not code.

## Features

### Layers & dashboards

- 44 bundled instrumentation layers across four tiers — Apps (GENERAL, BROWSER, mobile, VIRTUAL_DATABASE/CACHE/MQ/GENAI), Service Mesh (MESH, MESH_DP, MESH_CP, CILIUM_SERVICE), Middleware (databases, queues, gateways, Flink, Airflow), and Infrastructure (K8S, OS_LINUX/WINDOWS, AWS) — plus a self-observability group (SO11Y_OAP, SO11Y_SATELLITE, BANYANDB).
- Config-driven layer dashboards — multi-scope (Service / Instance / Endpoint) JSON templates edited in the UI admin and published to OAP with no code changes; per-layer sync badges show synced / diverged / local state.
- Rich widget vocabulary — scalar KPI cards, time-series line charts with dual-axis, top-N rankings, sampled record lists, label-dimensioned tables, KPI composites, embedded topology, and alarm tiles.
- Server-side widget visibility gates (`visibleWhen`) — render a widget only when an MQE metric has a value or an entity attribute matches (e.g. `language = JAVA`, `container_name = lifecycle`).
- Cross-layer Overview dashboards — war-room views (Services Dashboard, Mesh Dashboard) built from KPI tiles, alarms, topology, and metrics on a 12-column drag-and-resize canvas; inactive layers auto-hide.
- Layer customization — per-layer aliases (e.g. Pods/Endpoints on K8S_SERVICE), instance badges (agent language, BanyanDB container name), naming rules that group services (namespace.service for K8S/Istio), and split-by-Service.group to fan one layer into per-group sidebar entries.
- Value formatting — enum maps (translatable value→label), duration as human time-ago, and compact SI suffixes (45.1k, 1.34M).
- Template store reliability — the runtime renders only the OAP-published version; an unreachable store shows a visible banner, never a silent fallback to bundled defaults.

### Maps & topology

- Service topology map — interactive directed call graph with health-ring nodes, component-technology icons, SLA-colored RPM edges, pan/zoom/drag, and conjectured-peer filtering.
- Instance-level drill-down — client vs. server instances in grouped columns with relationship-aware pair picking and per-instance call metrics.
- Deployment topology — a single service's instances clustered into pods with configurable node/edge roles and role-to-role edge metrics (e.g. liaison→data write/query, lifecycle→data migration), plus a Flows sub-tab.
- API dependency graph — endpoint caller→callee chains with one-click expand, drag-to-rearrange, and drill-out links.
- Cross-layer service navigation — jump a logical service between layers (Agent ↔ Mesh ↔ MeshDP ↔ K8S) via a service-map chip overlay.

### Traces, logs & alarms

- Distributed traces — native SkyWalking traces (`queryTraces` on BanyanDB with inline spans, or `queryBasicTraces` on any backend), plus Zipkin traces in a separate tab when a layer enables both, with state/order/duration/tag filters, a duration distribution chart, and second-precision time windows.
- Trace waterfall — indented span timeline with service colors, span-kind glyphs, component icons, cross-segment references, and per-span duration/error state.
- Application & service logs — keyword + tag filtering, a level-stacked density histogram, faceted sidebar, dense expandable stream, content-type-aware rendering (text / JSON / custom MIME), and a trace link per row.
- Browser error logs — JavaScript errors on the BROWSER layer with raw minified stacks de-obfuscated against uploaded or mounted `.map` files, resolved to original file/line/column/symbol with a source snippet.
- Pod logs (Kubernetes) — on-demand live-tail of container logs fetched through OAP from the K8s API, with lookback/poll controls, keyword and exclude filters, and a read-only Monaco pane.
- Alarms (read-only) — active and historical alarms across layers with timeline lanes and incident grouping; recovery is backend-automatic — no acknowledge/close/silence.

### Profiling

- Trace-based profiling — CPU/memory call stacks from sampled spans via async-profiler (Java) and pprof (Go), as a stack tree or flame graph.
- eBPF / kernel profiling — system-level on-CPU and off-CPU sampling with label aggregation.
- Async / continuous profiling (Java) — live thread profiling with event-type selection (CPU/ALLOC/LOCK/WALL/CTIMER/ITIMER) and multi-instance scoping.
- pprof profiling (Go) — event selection (CPU/HEAP/BLOCK/GOROUTINE/MUTEX/ALLOCS/THREADCREATE), sampling-rate controls, plus on-demand one-shot dumps.
- Network profiling — process-level topology and inter-process call metrics from eBPF network / continuous-profiling tasks in a honeycomb layout.

### Operate & admin

- Runtime rule management (OAL / MAL / LAL) — Monaco YAML editor, catalog, and bytecode/AST dump, with a live phase stepper for structural applies (Compiled → Confirming across the cluster → Committing → Done), cluster-propagation warnings, and a force-recover button for degraded applies.
- Alerting rules — per-entity running-context for alarm rules (FIRING / SILENCED_FIRING / RECOVERY_OBSERVATION) with a snapshot sparkline and per-OAP-node evaluation state.
- Live Debugger — start/poll/stop debugging sessions for the three runtime-rule languages, with per-node fan-out, sample payloads, diff-default label grouping, and replayable capture history.
- Metrics Inspect (MQE board) — browse the OAP metric catalog by source (OAL / MAL·OTEL / MAL·Telegraf / LAL→MAL), pick a scope and entity, and fire MQE expressions live against the running system.
- Cluster status — GraphQL-port health (version, server clock, timezone, health score) and admin-host module readiness, surfaced as a topbar health chip.
- Data retention (TTL) — backend-aware per-data-class retention (BanyanDB hot+warm/cold stages or single-stage for other backends), read-only.
- OAP configuration dump, RBAC matrix (four built-in roles over a verb-namespaced permission set), Users admin (local + LDAP), and Auth status with an on-demand LDAP resolve probe.
- Template management — a bundled → local-draft → remote-OAP model with source pill, sync badge, Save (local only), and Check diff & push (Monaco side-by-side) across layer dashboards, overviews, 3D map, alerts, themes, and time defaults.
- Export / import — download any dashboard, overview, 3D-map, or per-locale translation config as JSON for backup or sharing; import loads a local draft and never writes OAP directly.

### 3D infrastructure map & multi-entity compare

- 3D infrastructure map — a WebGL (Three.js + TresJS) bird's-eye view with services as cubes on stacked tier-planes (Apps / Service Mesh / Middleware / Infra), SLA-colored health rings, animated intra-zone call arcs, orbit/keyboard controls, beacon mode (dim healthy cubes so only alarming ones glow), and a fully configurable tier/layer/color/traffic-MQE/logic-group editor published to OAP.
- Multi-entity compare — pin up to 6 services/instances/endpoints (cross-service) and compare inline without changing the primary selection: line charts overlay hued series, cards show a row per entity, top-N/record widgets gain per-entity tabs, and tables gain an Entity column.

### Internationalization & design

- Eight first-class locales — English (source), zh-CN, ja, ko, es, pt, de, fr; UI chrome resolves client-side via vue-i18n, and bundled dashboard templates carry per-locale overlay catalogs merged BFF-side before they reach the browser.
- Tech terms and OAP-supplied data stay verbatim — SkyWalking, Kubernetes, OAP, MQE, eBPF, scope enums, layer keys, and metric ids are never translated; service names, trace spans, log messages, and alarm rule names render as-is in every locale.
- Five bundled themes — Horizon, Meridian, Obsidian, and Aurora (dark) plus a light Daybreak — built entirely on CSS custom properties (no Tailwind, no CSS-in-JS); dark-dense by default, with synced crosshairs across all time-series on a dashboard.
- MQE as a first-class editable language — syntax-highlighted, schema-aware, and debuggable in dashboards and the Live Debugger.

## Architecture

Horizon UI is a pnpm-workspaces monorepo:

- `apps/ui` — the Vue 3 + TypeScript (strict) single-page app, built with Vite. State via Pinia, data via `@tanstack/vue-query`, charts via Apache ECharts (wrapped — never instantiated directly in a view), topology and flame graphs via D3, 3D via Three.js + TresJS, code editing via Monaco.
- `apps/bff` — a Fastify (Node) backend-for-frontend. It is the only tier that talks to OAP, shaping every reply for the SPA, owning timezone conversion, template sync, auth/RBAC, and the audit log.
- `packages/api-client`, `packages/design-tokens`, `packages/templates` — the shared GraphQL client, the canonical design tokens, and the bundled dashboard JSON.

The BFF speaks three OAP contracts, all owned upstream and treated as fixed:

- GraphQL query-protocol (`POST /graphql`) — metrics, topology, traces, logs, alarms, browser errors.
- Admin REST (OAP admin host, default port `17128`) — runtime rules/DSL, cluster status, metrics inspect, live debugging.
- Zipkin v2 REST — Zipkin-format trace/span fetch.

The flow inside the BFF is one-directional — `http → logic → client → OAP` — and bundled templates are synced to OAP on first boot (bundled → local draft → push), after which the running UI renders only what OAP serves.

## Getting started / Development

Prerequisites: Node (see `package.json` `engines` — `>=22`) and pnpm via Corepack (the repo pins the version through `packageManager`).

```bash
corepack enable
pnpm install
```

Run the dev servers — Vite serves the UI on `:9091` and proxies `/api` to the BFF on `:8081`:

```bash
pnpm dev          # run UI + BFF together
pnpm dev:ui       # UI only  (Vite on :9091)
pnpm dev:bff      # BFF only  (:8081, NODE_ENV=development, tsx watch)
```

Quality gates and build:

```bash
pnpm type-check   # TypeScript strict, all packages
pnpm lint
pnpm test:unit    # vitest + jsdom
pnpm build        # build all packages
pnpm package      # produce the distributable dist/ (BFF dist/server.js + static UI)
pnpm start        # run the packaged server (HORIZON_CONFIG=./horizon.yaml)
```

License headers and dependency licenses are enforced in CI via [skywalking-eyes](https://github.com/apache/skywalking-eyes) — run `pnpm license:check` (or `pnpm license:fix`) before pushing.

### Docker

A multi-stage, multi-arch image (`linux/amd64`, `linux/arm64`) ships the BFF plus the static UI on `node` Alpine, runs as a non-root `horizon` user, exposes port `8081`, and mounts `/data` for state files. The Dockerfile builds `dist/` from source inside the image (no host pre-step); images are published to GHCR and Docker Hub per release.

```bash
docker build -t horizon-ui:local .
docker run --rm -p 8081:8081 -v "$PWD/horizon.yaml:/app/horizon.yaml:ro" horizon-ui:local
```

See [`docs/setup/container-image.md`](docs/setup/container-image.md) for image tags, env vars, mounting `horizon.yaml`, and a Kubernetes example.

## Configuration

Horizon UI is configured by a single `horizon.yaml` (hot-reloaded, with `${VAR}` environment-variable interpolation) — see `horizon.yaml`. Key sections:

- `server` — host / port.
- `oap` — `queryUrl`, `adminUrl`, `zipkinUrl`, `timeoutMs`, and optional outbound basic-auth.
- `auth` — backend `local` or `ldap` (with LDAP bind / user-filter / group-mapping and an optional audited break-glass local admin).
- `rbac` — four built-in roles (viewer / maintainer / operator / admin) over fine-grained, verb-namespaced permissions (e.g. `dashboard:write`, `rule:write:structural`, `source-map:write`).
- `session`, `debugLog`, `sourceMaps` (browser-error source-map cache), `layers.excluded`, `query.landingServiceCap`, and the state-file paths (audit log, setup state, alarms state, wire debug log) — defaulting under `/data/*` in the container.

Local user passwords are argon2-hashed; generate a hash with the BFF CLI. Set `session.cookieSecure: true` when running behind HTTPS.

## Documentation

Operator-focused documentation (setup, OAP compatibility, access control, customization, components, and operate) lives in this repo under [`docs/`](docs/README.md) and is rendered on the [SkyWalking website](https://skywalking.apache.org/docs/). Start with the Quick Start, then OAP Connection and Auth/RBAC.

## Contributing

Contributions are welcome. Horizon UI is a greenfield rewrite that tracks the OAP GraphQL query-protocol and MQE — backend contracts are fixed and owned by [apache/skywalking](https://github.com/apache/skywalking). Read `CLAUDE.md` for the project's working principles (correctness first, validate against a live OAP, TypeScript strict, charts wrapped, density beats whitespace), keep `CHANGELOG.md` current, and run the type-check / lint / unit-test / license-header gates before opening a PR.

## License

Licensed under the [Apache License 2.0](LICENSE) — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Apache SkyWalking, SkyWalking, and the Apache feather logo are trademarks of The Apache Software Foundation.
