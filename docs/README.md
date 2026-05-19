# Apache SkyWalking Horizon UI

Horizon UI is the next-generation web UI for [Apache SkyWalking](https://github.com/apache/skywalking). It targets feature parity with [skywalking-booster-ui](https://github.com/apache/skywalking-booster-ui) on the same OAP GraphQL query-protocol and MQE, with a modernized, dense, dark-first design.

This documentation tree explains:

- **[Design Target](design-target.md)** — what Horizon UI is built for and how it differs from booster-ui.
- **Compatibility** — minimum [OAP version](compatibility/oap-version.md), [required OAP modules](compatibility/required-modules.md), [port matrix](compatibility/ports.md), and the per-pane [check sequence on the Cluster Status page](compatibility/cluster-status.md).
- **Setup** — [quick start](setup/overview.md), the [container image](setup/container-image.md) (image tags, env vars, how to mount `horizon.yaml`, Kubernetes example), and the full [`horizon.yaml` reference](setup/horizon-yaml.md), broken down per top-level section: [server](setup/server.md), [oap](setup/oap.md), [auth](setup/auth.md), [rbac](setup/rbac.md), [session](setup/session.md), [audit](setup/audit.md), [setup/alarms files](setup/files.md), [debugLog](setup/debug-log.md).
- **Access Control** — [local](access-control/local-backend.md) + [LDAP](access-control/ldap-backend.md) backends, [break-glass admin](access-control/break-glass.md), the 28-verb [RBAC model](access-control/rbac.md), the [audit log](access-control/audit-log.md), and the three [admin pages](access-control/admin-pages.md).
- **Customization** — how the [sidebar is composed from OAP layers](customization/menu-structure.md), how to author [layer dashboard templates](customization/layer-templates.md), how to author [overview (war-room) templates](customization/overview-templates.md), and the end-to-end recipe for [adding a new layer](customization/adding-a-new-layer.md).
- **Components** — field-by-field reference for every widget primitive ([overview](components/overview-widgets.md) + [per-layer dashboard](components/dashboard-widgets.md)) and the [wrapped chart components](components/charts.md).
- **Operate** — [Cluster Status & Metadata](operate/cluster-metadata.md) page and the [Inspect](operate/inspect.md) page (the latter requires OAP 11.x for the SWIP-14 Inspect API; OAP 10.x is partially supported — see the [feature matrix](compatibility/oap-version.md#feature-matrix-vs-oap-version)).

## Repository layout (orientation only)

The UI is a pnpm monorepo:

| App / package | Purpose |
|---|---|
| `apps/ui/` | Vue 3 + Vite single-page app. |
| `apps/bff/` | Fastify-based Backend For Frontend. Owns OAP connectivity, session/auth, audit log, bundled templates. |
| `packages/api-client/` | TypeScript types shared between BFF and UI (widget/template shapes, menu response, dashboard scope enum, etc.). |

The UI **only** talks to the BFF; the BFF is the single place that talks to OAP (GraphQL query port + admin REST port + Zipkin). This means every OAP-side requirement in [Compatibility](compatibility/oap-version.md) is enforced once, in the BFF, not scattered through the UI.

## Where to start

| If you are… | Read first |
|---|---|
| Deploying Horizon for the first time | [Setup → Quick Start](setup/overview.md), then [Compatibility → OAP Version](compatibility/oap-version.md). |
| Wiring up LDAP / configuring roles | [Access Control → LDAP Backend](access-control/ldap-backend.md), then [RBAC](access-control/rbac.md). |
| Customizing what shows up on a per-layer page | [Customization → Layer Dashboard Templates](customization/layer-templates.md). |
| Building a "war room" overview | [Customization → Overview Templates](customization/overview-templates.md). |
| Diagnosing a "module disabled" warning | [Compatibility → Required OAP Modules](compatibility/required-modules.md) and [Cluster Status Check Sequence](compatibility/cluster-status.md). |

## Live demo

The Apache SkyWalking project runs a public OAP demo at `demo.skywalking.apache.org/graphql` (basic auth `skywalking:skywalking`). Horizon's `horizon.yaml` can point at it for smoke-testing:

```yaml
oap:
  queryUrl: https://demo.skywalking.apache.org
  auth:
    username: skywalking
    password: skywalking
```

The demo exposes the GraphQL query port only; the admin REST port (and therefore the Cluster, Inspect, DSL Management, and Live Debugger pages) is not reachable from outside.
