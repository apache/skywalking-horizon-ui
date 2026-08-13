# Apache SkyWalking Horizon UI

Horizon UI is the next-generation web UI for Apache SkyWalking. It targets feature parity with the existing booster-ui against the same OAP GraphQL query-protocol and MQE, with a modernized dense dark-first design.

The sidebar on the left of this site is the canonical entry point — every section below has its own page there. This README is the orientation map.

## How it's organized

- **Setup** — quick start, container deployment, and the `horizon.yaml` settings operators usually need.
- **Compatibility** — OAP version, network ports, required modules, and cluster-status checks.
- **Features & Capabilities** — one page per feature: AI Assistant, Service Map, 3D Infrastructure Map, Traces, Logs, Browser Logs, Alarms, Events, Profiling, the Metrics / Trace / Log Inspect tools, Runtime Rules, Live Debugger, Cluster Status, Data Retention, and OAP Configuration.
- **Bundled Dashboards** — the ready-made dashboards Horizon ships, one page each: the Services and Mesh overview dashboards, then every supported technology layer from ActiveMQ to Windows.
- **Access Control** — local users, LDAP login, break-glass access, roles, audit log, and admin pages.
- **Customization** — layer menus, layer and overview dashboard templates, adding a layer, languages and translations, and themes and global defaults.
- **Reference** — design target and widget reference for template authors.
- **Release Notes** — what changed in each release, one page per version. One version line covers everything Horizon ships: the browser UI, the Horizon server, and the server's reported version.

## Quick orientation

Horizon runs as a browser UI plus a Horizon server process. The browser talks only to the Horizon server; the server talks to OAP for query, admin, and Zipkin traffic. That keeps OAP connectivity, credentials, and compatibility checks in one place.

## Where to start, by role

| If you are… | Read first |
|---|---|
| Deploying Horizon for the first time | Setup → Quick Start, then Compatibility → OAP Version. |
| Wiring up LDAP / configuring roles | Access Control → LDAP Login, then Roles and Permissions. |
| Customizing per-layer dashboards | Customization → Layer Dashboard Templates. |
| Building a "war room" overview | Customization → Overview Templates. |
| Diagnosing a "module disabled" warning | Compatibility → Required OAP Modules, then Features & Capabilities → Cluster Status. |

## References

- [Apache SkyWalking](https://github.com/apache/skywalking) — the backend Horizon UI consumes.
- [skywalking-booster-ui](https://github.com/apache/skywalking-booster-ui) — the previous-generation UI; Horizon is feature-equivalent against the same OAP protocol.
