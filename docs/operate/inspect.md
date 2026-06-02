# Inspect

Path: `/operate/inspect`. Verb: `inspect:read` (granted by maintainer, operator, admin).

The Inspect page lets the operator browse OAP's live metric catalog and enumerate the entities (services, instances, endpoints, processes, …) that have data for a given metric. It is built on OAP's **Inspect API**, which is **v11-only** — the page does not render on v10.

## What the page is for

Common scenarios:

- **"What metrics does this OAP build expose?"** — search the catalog by regex, filter by metric type / catalog / MQE-queryable.
- **"Does this metric have data?"** — for a chosen metric, list the entities currently reporting.
- **"What's the right scope for this metric?"** — the catalog row shows the metric's scope (Service / ServiceInstance / Endpoint / Process / All); this is load-bearing when authoring widgets.
- **"Which receiver populated this metric?"** — source attribution, when available, surfaces the originating module.

## Prerequisites

- OAP 11.x.
- `SW_INSPECT=default` on the OAP side.
- `SW_ADMIN_SERVER=default` (gates the admin port itself).
- The admin port (default 17128) reachable from the Horizon BFF.

If any of these is missing, the page surfaces a hint banner directing the operator at [Compatibility → Required OAP Modules](../compatibility/required-modules.md).

## Catalog browser

**Endpoint:** `GET /api/inspect/metrics?regex=<pattern>&type=<type>&catalog=<catalog>&mqeQueryable=<bool>`

Filters:

| Filter | Notes |
|---|---|
| `regex` | Regex against the metric name. Empty = all metrics. |
| `type` | Metric type filter (per OAP's metric type enum). |
| `catalog` | Catalog filter (per OAP's metric catalog: METRICS, ENDPOINT, SERVICE, …). |
| `mqeQueryable` | When true, restrict to metrics that can be queried via MQE. |

Each catalog row shows:

- Metric name.
- Type (counter, gauge, histogram, …).
- Scope (Service, ServiceInstance, Endpoint, ServiceRelation, ServiceInstanceRelation, EndpointRelation, Process, All).
- Catalog.
- Source module (when surfaced).
- A button to drop the metric into the entity enumerator.

The list is virtualized — a typical OAP exposes hundreds of metrics; scrolling is smooth.

## Entity enumerator

**Endpoint:** `GET /api/inspect/entities?metric=<name>&start=<...>&end=<...>&step=<DAY|HOUR|MINUTE>&limit=<n>`

For a chosen metric, OAP returns the set of entities that have data in the window. Useful for:

- Confirming a metric is actually being populated.
- Finding the exact entity id to use in an MQE expression.
- Spotting metric-scope mismatches (a Service-scope metric will only return service entities, never instances).

Time-format rules per `step` (UTC-interpreted on the OAP side):

| step | date format |
|---|---|
| `DAY` | `yyyy-MM-dd` |
| `HOUR` | `yyyy-MM-dd HH` |
| `MINUTE` | `yyyy-MM-dd HHmm` |

Horizon converts the page's chosen time range into the correct format automatically — operators just pick a window.

## Common workflows

### "I'm authoring a widget and I don't know which MQE expression to use."

1. Open Inspect.
2. Filter by `catalog: SERVICE` and `mqeQueryable: true`.
3. Find the metric you want.
4. Read the scope — that determines which page you can use it on.
5. Note the metric name and write the MQE: e.g., `latest(service_cpm)`.

### "A widget shows no data — is the metric live?"

1. Open Inspect.
2. Search for the widget's metric.
3. Click "Enumerate entities" for the time window the widget covers.
4. If the entity list is empty → metric has no data; either the receiver isn't populating it, or the time window is wrong.
5. If the entity list is non-empty → the metric has data but your MQE entity selector is wrong; fix the widget's entity scope.

### "What metrics does this layer have?"

OAP does not expose a direct "metrics in layer X" filter. Workaround: most layers have a metric-name prefix (`service_*` for GENERAL, `mesh_service_*` for MESH, `k8s_*` for K8S). Filter the regex by that prefix.

## Limits and caveats

- **404 from OAP** means the `inspect` module is off. Set `SW_INSPECT=default` on OAP and restart it. The Cluster Status page will then show the module green.
- **Empty catalog** with no error means the regex filtered everything out — clear filters.
- **Empty entity list** means the metric truly has no data for the window. Widen the window (`step: DAY` covers more time) or check whether the receiver for that metric is ingesting.
- **Storage backend page-size limits** apply to entity enumeration. The `limit` parameter caps results; OAP will not return more than its storage backend allows in a single page.

## Related

- [Compatibility → OAP Version](../compatibility/oap-version.md) — why v11.
- [Compatibility → Required OAP Modules](../compatibility/required-modules.md) — `SW_INSPECT` enablement.
- [Customization → Layer Dashboard Templates](../customization/layer-templates.md) — where the metrics you find here end up being used.
