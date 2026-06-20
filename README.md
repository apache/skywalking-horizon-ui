Apache SkyWalking Horizon UI
============================

<img src="https://skywalking.apache.org/assets/logo.svg" alt="SkyWalking logo" height="90px" align="right"/>

The next-generation web UI for [Apache SkyWalking](https://github.com/apache/skywalking). Horizon UI talks to the same OAP GraphQL query-protocol and admin host as the existing [skywalking-booster-ui](https://github.com/apache/skywalking-booster-ui).

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

## Documentation

Full docs ship at [skywalking.apache.org → Horizon UI](https://skywalking.apache.org/docs/) and live in this repo under [`docs/`](docs/README.md). The left-side menu there is the canonical entry point — setup, compatibility, access control, customization, components, and operate are all covered.

## At a glance

- **Multi-layer navigation** — Layers in the sidebar with per-layer service counts, drill-down to overview / services / instances / endpoints / topology, per-layer entity-slot renaming.
- **Landing** — global cross-layer overview + per-layer landing with service constellation and traffic-share bars.
- **Service deep-dive** — multi-layer aware; one service can report through General + Service Mesh + K8s at once with side-by-side comparison.
- **Topology** — force-directed / hierarchical DAG / hex honeycomb variants on the same data.
- **Endpoint / API dependency** — multi-hop caller → endpoint → downstream view with latency breakdown.
- **Dashboards** — draggable grid + MQE query drawer + per-scope templates (Glance / Service / Instance / Endpoint / Topology / Metric drill), synced crosshair + compare cursor across panels.
- **Trace explorer** — duration scatter, sortable list, waterfall with per-span service / kind / error highlighting.
- **Log explorer** — chip filters, saved views, facets sidebar, timeline brush, mixed JSON / YAML / raw payload tree, top patterns roll-up.
- **Alarms** — active alarms only, read-only (no acknowledge / close — recovery is backend-driven), with a Live Debug panel for MQE expressions.
- **Admin** — local + LDAP auth, RBAC (4 built-in roles, fine-grained verbs), audit log, layer admin, system / OAP cluster health, 5 bundled themes (Horizon · Meridian · Obsidian · Daybreak · Aurora).
- **Profiling** — flame graphs over trace-based / async-profiler / eBPF / pprof data.

## Tech stack

Vue 3 + TypeScript on Vite, Pinia, vue-router 4, Apache ECharts 6, D3 v7, vue-grid-layout, d3-flame-graph, Monaco, Vitest. The BFF is Fastify on Node.js.

## Development

Requires a recent LTS Node.js and pnpm (pinned via Corepack).

```bash
pnpm install                     # one-time / after lockfile changes
pnpm --filter bff dev            # BFF on :8081 (NODE_ENV=development)
pnpm --filter ui dev             # Vite dev server on :9091, proxies /api → BFF

pnpm -r type-check
pnpm -r lint                     # `lint:fix` mutates
pnpm -r test:unit
pnpm license:check               # CI gate via skywalking-eyes
```

Container build (multi-stage — the Dockerfile builds `dist/` from source inside the image, no host pre-step):

```bash
docker build -t horizon-ui:local .
docker run --rm -p 8081:8081 -v "$PWD/horizon.yaml:/app/horizon.yaml:ro" horizon-ui:local
```

See [`docs/setup/container-image.md`](docs/setup/container-image.md) for image tags, env vars, mounting `horizon.yaml`, and a Kubernetes example.

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). License headers and dependency licenses are enforced in CI via [skywalking-eyes](https://github.com/apache/skywalking-eyes); configuration in [.licenserc.yaml](.licenserc.yaml).
