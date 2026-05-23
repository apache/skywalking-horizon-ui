# Menu and Layers

Horizon's sidebar follows the data OAP reports. You do not hand-build a menu tree in Horizon; you make OAP expose layers, then use templates and user preferences to control how those layers appear.

## What Controls the Sidebar

| Source | What it controls |
|---|---|
| OAP layers | Whether a layer exists and whether it has services. |
| Layer templates | Display name, color, group, visible tabs, service-list columns, trace/log behavior, and dashboard widgets. |
| User preference | Personal ordering of visible layers on the landing page and sidebar. |
| RBAC | Whether operate, dashboard setup, and admin pages are visible for the signed-in user. |

The result is intentionally reactive: when OAP starts reporting data for a layer, Horizon shows it; when a user lacks a permission, Horizon hides the page link.

## Main Sidebar Areas

| Area | What appears there |
|---|---|
| Overviews | Public overview dashboards, when the user has `overview:read`. |
| Alarms | The active alarm board, when the user has `alarms:read`. |
| Layers | Active public OAP layers with at least one service. |
| Platform monitoring | Cluster Status, Data Retention, and OAP Configuration. |
| Operate | Alerting rules, DSL Management, Live Debugger, Capture History, and Metrics Inspect. |
| Dashboard setup | Overview templates, Layer dashboards, Alert page setup, and Global defaults. |
| Admin | Users, Auth status, and Roles & permissions. |

Only rows the current user can open are shown.

## Layer Visibility

A layer appears under **Layers** when all of these are true:

1. OAP reports the layer.
2. OAP reports at least one service in that layer.
3. The layer template uses public visibility.

If a layer is meant for SkyWalking self-observability rather than application observability, set its template visibility to `operate`; Horizon places it under the Operate area instead of the main Layers list.

## Overview Visibility

An overview dashboard appears under **Overviews** when at least one of the layers it touches is reporting services. Horizon derives "the layers it touches" from two sources, unioned:

- the explicit `layers[]` field on the dashboard, and
- every `widget.layer` referenced by its widgets.

A dashboard with no layer reference on either side (e.g. a cross-layer "All" view) is always shown. See [Overview templates](/customization/overview-templates).

## Landing Page

When a user opens the app at `/`, Horizon picks a real destination so they never see a blank page:

1. The first available public overview dashboard, or
2. The first layer with services, or
3. The empty landing (`/landing-empty`).

The cascade only lands on destinations that also appear in the sidebar. A bundled layer template that has no services is intentionally **not** a fallback — it would put the user on a page that doesn't appear in their menu.

`/landing-empty` is a real route (also reachable directly). It explains the situation in plain language — "No data is flowing yet" or "No dashboard configured yet" — and points the viewer at their operations team. As soon as a service starts reporting or an operator publishes a dashboard, the next visit (or the next 60s menu refresh) replaces the empty landing with the real one.

## First Tab for a Layer

When a user clicks a layer, Horizon opens the first enabled tab in this order:

```text
service -> instance -> endpoint -> topology -> trace -> logs -> profiling
```

Disable unsupported tabs in the layer template. For example, a layer without traces should turn the trace tab off so users do not land on an empty page.

## Common Changes

| Goal | Where to change it |
|---|---|
| Rename a layer | Layer template `alias`. |
| Change a layer color | Layer template `color`. |
| Group related layers | Same layer template `group` value on each layer. |
| Move a layer to Operate | Layer template `visibility: operate`. |
| Hide a tab | Layer template `components`. |
| Change layer order | User layer-order preference. |
| Add a new layer | Add it in OAP first, then add a Horizon layer template. |

Use **Dashboard setup → Layer dashboards** for normal template edits. Save locally to preview, then sync to OAP when you want the change published for everyone.

## When OAP Is Unreachable

If OAP is unreachable, Horizon keeps the last known sidebar shape in memory and shows an OAP-unreachable banner. Service counts may show as unknown until OAP is reachable again.

This avoids the worst failure mode during a short OAP outage: an empty sidebar that makes operators think configuration disappeared.

## Troubleshooting

| Symptom | Check |
|---|---|
| Layer missing | Confirm OAP reports the layer and at least one service. |
| Layer appears in Operate, not Layers | Check template visibility. |
| Expected tab missing | Check the layer template components. |
| User cannot see an admin page | Check their role grants in Roles & permissions. |

## Related

- [Layer Dashboard Templates](layer-templates.md)
- [Overview Templates](overview-templates.md)
- [Add a Layer](adding-a-new-layer.md)
