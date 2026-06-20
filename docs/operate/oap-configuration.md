# OAP Configuration

Path: `/operate/config`. Verb: `config:read` (granted by maintainer, operator, admin).

The OAP Configuration page shows the connected OAP's resolved runtime configuration. It is read-only and intended for support and incident triage.

## What You See

Horizon reads OAP's admin-port config dump and groups keys by module. Use the filter box to find a module, selector, or value.

Secret values are masked by OAP before Horizon displays them. Masked values appear as `******`.

## Requirements

- A recent OAP that ships the admin-server module.
- `SW_ADMIN_SERVER=default` on OAP.
- The OAP admin port, usually `17128`, reachable from Horizon.
- The logged-in user has `config:read`.

If the page reports the admin host is unreachable, check the OAP admin-server module and the Service, firewall, or load balancer exposing the admin port.

## During Operations

Use this page to confirm what OAP actually started with, especially after a config change, deployment rollback, or module enablement change. For module health, start with [Cluster Status](cluster-metadata.md); for the complete key/value view, use this page.
