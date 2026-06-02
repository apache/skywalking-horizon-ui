# Adding a New Layer

End-to-end recipe for getting a new OAP layer to appear correctly in Horizon. Most of the work is on the OAP side; the Horizon side is a JSON template.

## Prerequisites

- The layer must exist in OAP first: the schema defines it, a receiver writes data for it, and `listLayers` returns it. Adding a JSON template for a layer OAP doesn't know about does nothing — the layer is not "active".

## Steps

### 1. Confirm OAP exposes the layer

```sh
curl -s -X POST <queryUrl>/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ listLayers }"}' | jq
```

The new layer key (UPPER_SNAKE) should appear. If not, fix the OAP side first — Horizon cannot synthesize a layer that OAP does not report.

### 2. Confirm services exist in the layer

```sh
curl -s -X POST <queryUrl>/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ listServices(layer:\"<KEY>\") { id name normal } }"}' | jq
```

A layer with zero services is hidden from the sidebar (it appears in the menu response but is filtered out of the visible list). Ingest some data first, then proceed.

### 3. Identify the layer's metric prefix

Browse OAP's [metric catalog](https://skywalking.apache.org/docs/main/next/en/setup/backend/metric-name-and-its-attributes/) (or use Horizon's Inspect page once you have it running) to find the metric naming convention for the layer. For example:

- `GENERAL` → `service_cpm`, `service_apdex`, `service_percentile`, `endpoint_cpm`, `endpoint_resp_time`
- `MESH` → `mesh_service_cpm`, `mesh_service_resp_time`
- `K8S_SERVICE` → `k8s_service_*`

Knowing the prefix unlocks template authoring — most fields are MQE expressions that substitute the layer's prefix.

### 4. Copy an existing template as a starting point

Pick the closest bundled layer template:

```sh
cp apps/bff/src/bundled_templates/layers/general.json \
   apps/bff/src/bundled_templates/layers/<your-key>.json
```

(Filename: lowercased layer key.)

### 5. Edit the template

Minimum edits:

- `key`: change to your layer's enum (UPPER_SNAKE).
- `alias`: friendly display name.
- `color`: a hex or CSS variable. Distinct from existing layers' colors.
- All MQE expressions: substitute your layer's metric prefix.
- `slots`: override entity terms if the layer uses different vocabulary (`pod` instead of `instance`, etc.).
- `components`: disable tabs the layer cannot support (e.g. no traces → `trace: false`).

Optional:

- `group`: sidebar grouping label.
- `visibility`: set `operate` if this is a self-observability layer.
- `documentLink`: external docs URL.
- `traces.source`: `zipkin` or `both` if you ingest traces via Zipkin.
- `log.scope`: scope for the Logs tab.
- `naming`: regex for extracting clusters from service names.

See [Layer Dashboard Templates](layer-templates.md) for the full field reference.

### 6. Restart the BFF

Bundled template changes need a BFF restart (templates are loaded once at startup). Restart and check `/api/menu` — the layer should appear with `active: true` and the right metadata.

### 7. Verify in the UI

- The layer appears in the sidebar **Layers** section (assuming `visibility: public` and at least one service).
- Click it — should land on the `service` tab (or whichever tab is first-enabled per `components`).
- Service list picker shows the columns from `header.columns` with the right values.
- Per-service drill-down shows the widgets from `dashboards.service`.

### 8. Iterate

- Wrong MQE? Edit the template, restart, refresh.
- Want a widget on the instance page that's not on the service page? Add to `dashboards.instance`.
- Want a custom topology metric? Set `topology.metric`.

Each iteration is template + BFF restart. The schema is validated at startup; a bad template logs the error and falls back to defaults — check the BFF logs.

### 9. Add translations (i18n)

The template's English strings — the layer `alias`, any `aliases.*`, `slots`, and the widget titles / KPI labels / group titles / tooltips inside `dashboards` — are the i18n source. Generate the sibling overlay catalogs so the layer renders in every shipped language:

```sh
pnpm --filter @skywalking-horizon-ui/bff i18n:seed
```

This walks every bundled template and writes one `<your-key>.i18n.<locale>.json` per non-English locale (`de`, `es`, `fr`, `ja`, `ko`, `pt`, `zh-CN`), pre-filling shared widget vocabulary from the lexicon. Existing translations are preserved — only gaps are added. Fill the layer-specific prose you care about in each overlay (anything left blank falls back to English at render), then check for drift:

```sh
pnpm --filter @skywalking-horizon-ui/bff i18n:validate
```

See [Languages and Translations](i18n.md) for the language × scope coverage, the shared lexicon, and how to add a brand-new locale.

### 10. Promote to admin-editable (optional)

Once the template stabilizes:

- Open `/admin/layer-dashboards`, find the layer, click edit, then save locally.
- Subsequent edits go through the admin UI; you no longer need to rebuild and restart the BFF for cosmetic changes.

The local bundled file remains the fallback. After you publish, the OAP-stored template becomes the runtime copy every Horizon instance reads.

### 11. Add an overview entry (optional)

If the new layer belongs in a war-room view:

- Open `/admin/overview-templates`, pick the relevant overview.
- Add a `kpi-tile` (or `metric-composite`) widget with `layer: <YOUR_KEY>`.
- Fill in KPIs using the same MQE expressions you wrote into the layer template.

See [Overview Templates](overview-templates.md).

## Troubleshooting

### Layer appears in `listLayers` but not in the sidebar

- Check `serviceCount` in `/api/menu` — `0` means no services in the layer, hidden by default.
- Check `visibility` — `operate` puts it under the Operate group, not Layers.

### Layer appears but widgets show "no data"

- Verify the MQE expressions against the OAP MQE endpoint directly:

  ```sh
  curl -X POST <queryUrl>/graphql -H 'Content-Type: application/json' \
    -d '{"query":"mutation { execExpression(expression:\"<YOUR-MQE>\", entity:{ ... }, duration:{ start:\"...\" end:\"...\" step:MINUTE }) { ... } }"}'
  ```

- Verify the **entity scope** — querying a Service-scope metric with an Instance-scope entity returns empty. Each metric belongs to exactly one scope in OAP; the widget must run at the matching scope.
- Verify the **time window** — Horizon's per-page picker for layer dashboards uses MINUTE step; the metric must be aggregated at minute granularity in OAP.

### Layer color collides with another

Pick a distinct color in `color`. If unsure, use `var(--sw-accent-N)` where N picks from the design token palette.

### Renaming a layer

OAP-side rename means a new enum key. Horizon will see the old key go inactive (`active: false`) and the new key appear. The old template file is dead — delete it. Author the new template under the new filename.

## Related

- [Layer Dashboard Templates](layer-templates.md) — field reference.
- [Menu Structure](menu-structure.md) — how the sidebar composes layers.
- [Overview Templates](overview-templates.md) — cross-layer dashboards.
- [Languages and Translations](i18n.md) — translating the template's strings.
- [Components → Dashboard Widgets](../components/dashboard-widgets.md) — widget primitive reference.
