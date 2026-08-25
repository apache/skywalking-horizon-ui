# Menu and Layers

Horizon's sidebar follows the data OAP reports. You do not hand-build a menu tree in Horizon; you make OAP expose layers, then use layer templates to control how those layers appear.

## What Controls the Sidebar

| Source | What it controls |
|---|---|
| OAP layers | Whether a layer exists and whether it has services. |
| Layer templates | Display name, color, group, visible tabs, service-list columns, trace/log behavior, and dashboard widgets. |
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

A dashboard with no layer reference on either side (e.g. a cross-layer "All" view) is always shown. See [Overview templates](overview-templates.md).

## Landing Page

When a user opens the app at `/`, Horizon picks a real destination so they never see a blank page:

1. The first available public overview dashboard, or
2. The first layer with services, or
3. The empty landing (`/landing-empty`).

The cascade only lands on destinations that also appear in the sidebar. A bundled layer template that has no services is intentionally **not** a fallback — it would put the user on a page that doesn't appear in their menu.

`/landing-empty` is a real route (also reachable directly). It explains the situation in plain language — "No data is flowing yet" or "No dashboard configured yet" — and points the viewer at their operations team. As soon as a service starts reporting or an operator publishes a dashboard, the next visit (or the next 60s menu refresh) replaces the empty landing with the real one.

## Rows Under a Layer

Expanding a layer shows one row per enabled component, plus any extension pages those components declare. The built-in order is:

```text
service -> instance -> endpoint -> topology -> deployment -> dependency
-> trace -> zipkin-trace -> logs -> browser-errors -> pod-logs
-> trace-profiling -> ebpf-profiling -> network-profiling
-> continuous-profiling -> pprof -> async-profiling
```

Each entity component's extension pages follow that component. A layer with a Service page called *Resource usage* reads `Service → Resource usage → Instance → …`.

Clicking the layer itself opens its **first** row. That is usually Service, but not always: a layer with the service component turned off (a sidecar-only or per-agent layer) opens on its instance list instead.

Some layers are rendered as a direct link rather than an expandable section — a layer that resolves to a single row, and whose only enabled component is one that never carried sub-rows, gets no accordion, because it would only ever reveal the page the layer row already points at. A layer built on the entity components keeps its expandable section even when only one row resolves today, so a row appearing later does not change how the layer is reached.

## Rearranging the Menu

The built-in order suits most layers. When a layer carries several extension pages, the grouping can stop matching how a team reads the layer — for example, putting a filtered Service page directly beneath Topology.

Turn on **Rearrange menu** in **Dashboard setup → Layer dashboards → Setup**, then drag the entries in the live menu preview. The preview shows the layer's real entries, so what you arrange is what operators see.

- The switch only makes the entries draggable. Neither turning it on nor turning it off stores anything.
- **Moving an entry** is what records the order.
- An order equal to the built-in one is not recorded: drag everything back to where it started and the record is removed, the same as pressing Reset.
- **Reset to built-in order** is the explicit way back. It appears once an arrangement exists, and removes only the order — never pages or widgets.
- Deleting a page, or switching a component off, removes those entries from the stored order.
- Enabling a component later adds its entry rather than hiding it, even though the saved order predates it.

Like every other edit on this page, an arrangement lives in your local draft until you **Save (local)** and then **Check diff & push**.

The order applies to everyone using that layer — it is layer configuration, not a personal preference.

Disable unsupported tabs in the layer template. For example, a layer without traces should turn the trace tab off so users do not land on an empty page.

## Common Changes

| Goal | Where to change it |
|---|---|
| Rename a layer | Layer template `alias`. |
| Change a layer color | Layer template `color`. |
| Group related layers | Same layer template `group` value on each layer. |
| Move a layer to Operate | Layer template `visibility: operate`. |
| Hide a tab | Layer template `components`. |
| Reorder the rows under one layer | **Rearrange menu** in the layer's Setup tab. |
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
