/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Structural schemas for the templates bundled in this repo
 * (`bundled_templates/layers/*.json`, `bundled_templates/overviews/*.json`).
 *
 * These are BUILD-TIME schemas, not a runtime parse step: the loaders stay
 * tolerant (an operator-stored template must never crash the BFF), so a
 * malformed bundled file used to sail through `JSON.parse` and only fail on
 * screen — a broken landing request, a silently dropped widget. Everything
 * here is `.strict()` so a misspelled key is an error rather than a field
 * that quietly does nothing.
 *
 * {@link layerTemplatePushSchema} is the one runtime user: the admin routes
 * that PUBLISH a layer to OAP run it over the content before the write. It is
 * the same body as the bundled layer schema, built at a lower completeness bar
 * — see {@link buildLayerSchemas}.
 *
 * Two invariants make this worth its weight:
 *   - Widget shape is NOT re-declared: it reuses `widgetSchema`, the exact
 *     schema `POST /api/layer/:key/dashboard` enforces on the widgets the SPA
 *     posts back. A widget that fails here would 400 the whole request batch.
 *     The push bar opens exactly one hole in it — see
 *     {@link BLANK_EXPRESSION_STAND_IN}.
 *   - Header-column shape mirrors `POST /api/layer/:key/landing`'s body schema
 *     (aggregation enum, precision range, ≤10 columns) for the same reason:
 *     the SPA forwards these columns verbatim, so a value the route rejects
 *     blanks the layer's entire service list.
 */

import { z } from 'zod';
import { widgetSchema, scopeSchema } from '../dashboard/schema.js';

/** Cross-side rollup of per-service values into one layer KPI. Mirrors
 *  `AggregationKind` — the landing route rejects anything else. */
const aggregationSchema = z.enum(['sum', 'avg']);

const thresholdsSchema = z
  .object({
    ok: z.number().optional(),
    warn: z.number().optional(),
    danger: z.number().optional(),
    invertHealth: z.boolean().optional(),
    invertBase: z.number().optional(),
  })
  .strict();

/** One service-list column. Field-for-field the landing route's
 *  `columnSchema`, minus `selfAggregate` (an Overview-only flag the SPA
 *  synthesises; layer headers never carry it). `metric` / `label` stay
 *  non-empty in BOTH calibrations — the SPA forwards them verbatim and the
 *  landing route 400s the whole body on either. */
const headerColumnSchema = z
  .object({
    metric: z.string().min(1),
    label: z.string().min(1),
    unit: z.string().optional(),
    mqe: z.string().optional(),
    aggregation: aggregationSchema.optional(),
    scale: z.number().finite().optional(),
    precision: z.number().int().min(0).max(6).optional(),
  })
  .strict();

/** The landing route caps a request body at 10 columns; the SPA forwards
 *  every header column, so an 11th would 400 the whole service list. */
const MAX_HEADER_COLUMNS = 10;

/** `LayerComponentFlags` — a misspelled flag silently leaves its tab off,
 *  which is exactly why this is strict. */
const componentsSchema = z
  .object({
    service: z.boolean().optional(),
    instances: z.boolean().optional(),
    endpoints: z.boolean().optional(),
    endpointDependency: z.boolean().optional(),
    topology: z.boolean().optional(),
    traces: z.boolean().optional(),
    logs: z.boolean().optional(),
    browserErrors: z.boolean().optional(),
    traceProfiling: z.boolean().optional(),
    ebpfProfiling: z.boolean().optional(),
    asyncProfiling: z.boolean().optional(),
    networkProfiling: z.boolean().optional(),
    pprofProfiling: z.boolean().optional(),
    continuousProfiling: z.boolean().optional(),
    podLogs: z.boolean().optional(),
    deployment: z.boolean().optional(),
  })
  .strict();

/**
 * The one thing the push bar accepts that the shared `widgetSchema` cannot:
 * a widget whose MQE is still blank. "Add widget" seeds `expressions: ['']`,
 * and the layer renderer filters blank expressions out of the batch before it
 * posts (a half-authored leaf renders as "no data" instead of being queried),
 * so a blank is work in progress the runtime already tolerates — refusing the
 * publish over it is what leaves an operator unable to push after adding a
 * widget. The dashboard ROUTE must keep rejecting blanks (one would 400 the
 * whole batch), so the relaxation lives here: blanks are swapped for this
 * stand-in index-for-index — every other issue path stays exact — and the
 * substitution never leaves this module. The routes store the operator's own
 * JSON; this parse only decides accept / reject.
 */
const BLANK_EXPRESSION_STAND_IN = '<blank>';

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function fillBlankExpressions(widget: unknown): unknown {
  if (!isRecord(widget)) return widget;
  const out: Record<string, unknown> = { ...widget };
  if (Array.isArray(out.expressions)) {
    out.expressions = out.expressions.map((e) =>
      typeof e === 'string' && e.trim() === '' ? BLANK_EXPRESSION_STAND_IN : e,
    );
  }
  // A `tab` widget's panels hold leaf widgets, seeded blank the same way.
  if (Array.isArray(out.tabs)) {
    out.tabs = out.tabs.map((tab) =>
      isRecord(tab) && Array.isArray(tab.widgets)
        ? { ...tab, widgets: tab.widgets.map(fillBlankExpressions) }
        : tab,
    );
  }
  return out;
}

const pushWidgetSchema = z.preprocess(fillBlankExpressions, widgetSchema);

/** `dashboards.<scope>` — the key set is `DashboardScope`, reused from the
 *  dashboard route so a scope typo (which would render an empty grid) fails
 *  here instead. */
function dashboardsSchemaFor<T extends z.ZodTypeAny>(widget: T) {
  const shape: Record<string, z.ZodOptional<z.ZodArray<T>>> = {};
  for (const scope of scopeSchema.options) shape[scope] = z.array(widget).optional();
  return z.object(shape).strict();
}

/**
 * The layer schema, built twice from one body at two completeness bars.
 *
 * `complete: true` — a bundled FILE. A metric with no MQE, an empty metric
 * list, a blank alias: shipped config that can never render anything is a
 * defect, so CI fails on it.
 *
 * `complete: false` — content on its way to OAP through an admin PUSH route.
 * The layer editor produces exactly those holes as ordinary work in progress:
 * opening the Topology / API-dependency / network-profiling tab seeds its block
 * with EMPTY metric lists, every "Add metric" seeds `mqe: ""`, "Add widget"
 * seeds `expressions: [""]`, "Add role pair" seeds `metrics: []` and
 * `primary: ""`, switching a grouping rule to name-regex seeds `pattern: ""`
 * (and clearing it drops the key entirely), and every free-text field clears to
 * `""`. None of that breaks the layer — an unparseable expression comes back as
 * a per-alias error from OAP, so only that one metric reads "—", and a blank one
 * is dropped from the batch before it is queried. The push boundary therefore
 * rejects MALFORMED content, not INCOMPLETE content.
 *
 * Both bars keep every shape whose failure takes a whole page down: widgets
 * (the dashboard route 400s the entire batch), header columns (same for the
 * service list), `components` (the sidebar menu is built from it), and unknown
 * keys / wrong types / bad enums anywhere.
 */
function buildLayerSchemas(complete: boolean) {
  const dashboardsSchema = dashboardsSchemaFor(complete ? widgetSchema : pushWidgetSchema);
  /** Free text that means nothing when empty. */
  const text = complete ? z.string().min(1) : z.string();
  /** A list that means nothing when empty. */
  const filled = <T extends z.ZodTypeAny>(item: T) =>
    complete ? z.array(item).min(1) : z.array(item);

  /** `TopologyMetricDef` — service map / instance map / API dependency /
   *  process topology. */
  const topologyMetricSchema = z
    .object({
      id: text,
      label: text,
      mqe: text,
      unit: z.string().optional(),
      format: z.enum(['int', 'decimal', 'compact', 'duration']).optional(),
      role: z.enum(['center', 'ring', 'secondary', 'lineServer', 'lineClient']).optional(),
      aggregation: aggregationSchema.optional(),
      thresholds: thresholdsSchema.optional(),
    })
    .strict();

  /** `DeploymentMetricDef` — same as the topology def plus the short edge-pill
   *  `alias`. */
  const deploymentMetricSchema = topologyMetricSchema.extend({ alias: z.string().optional() }).strict();

  const instanceTopologySchema = z
    .object({
      nodeMetrics: filled(topologyMetricSchema),
      linkServerMetrics: z.array(topologyMetricSchema).optional(),
      linkClientMetrics: z.array(topologyMetricSchema).optional(),
    })
    .strict();

  const topologySchema = z
    .object({
      nodeMetrics: filled(topologyMetricSchema),
      linkServerMetrics: z.array(topologyMetricSchema).optional(),
      linkClientMetrics: z.array(topologyMetricSchema).optional(),
      showGroup: z.boolean().optional(),
      instanceTopology: instanceTopologySchema.optional(),
    })
    .strict();

  const endpointDependencySchema = z
    .object({
      nodeMetrics: filled(topologyMetricSchema),
      linkMetrics: z.array(topologyMetricSchema).optional(),
      showGroup: z.boolean().optional(),
    })
    .strict();

  const processTopologySchema = z
    .object({
      edgeClientMetrics: filled(topologyMetricSchema),
      edgeServerMetrics: filled(topologyMetricSchema),
    })
    .strict();

  /** `ClusterByRule` — the three grouping modes of the Deployment tab. */
  const clusterBySchema = z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('nameRegex'),
        // Save bar: the pattern input writes `undefined` when cleared and the
        // draft's JSON round-trip then drops the key, so the rule can arrive
        // without one at all.
        pattern: complete ? text : text.optional(),
        flags: z.string().optional(),
        displayGroup: z.string().optional(),
        valueGroup: z.string().optional(),
        alias: text,
      })
      .strict(),
    z
      .object({
        kind: z.literal('attribute'),
        attribute: text,
        alias: z.string().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('attributes'),
        attributes: filled(text),
        separator: z.string().optional(),
        alias: z.string().optional(),
      })
      .strict(),
  ]);

  /** One `from` → `to` role pair of the Deployment tab. `primary` names up to
   *  three of the pair's own metric ids to print on the edge itself. */
  const rolePairSchema = z
    .object({
      from: text,
      to: text,
      primary: z.union([text, z.array(text)]).optional(),
      metrics: filled(deploymentMetricSchema),
    })
    .strict();

  const deploymentSchema = z
    .object({
      nodeMetrics: z.array(deploymentMetricSchema).optional(),
      linkServerMetrics: z.array(deploymentMetricSchema).optional(),
      linkClientMetrics: z.array(deploymentMetricSchema).optional(),
      roleToRole: z.array(rolePairSchema).optional(),
      clusterBy: clusterBySchema.optional(),
      siblingBy: clusterBySchema.optional(),
      roleBy: clusterBySchema.optional(),
      roles: z
        .array(
          z
            .object({
              key: text,
              label: z.string().optional(),
              main: z.boolean().optional(),
              nodeMetrics: z.array(deploymentMetricSchema).optional(),
            })
            .strict(),
        )
        .optional(),
    })
    .strict();

  const headerSchema = z
    .object({
      orderBy: text.optional(),
      columns: z
        .array(headerColumnSchema)
        .max(MAX_HEADER_COLUMNS, `more columns than the landing request accepts (max ${MAX_HEADER_COLUMNS})`)
        .optional(),
    })
    .strict();

  /** Per-entity term overrides (`LayerSlotsConfig`). Authored as `aliases`
   *  in JSON; the loader normalises it to `slots`. */
  const aliasesSchema = z
    .object({
      services: text.optional(),
      instances: text.optional(),
      endpoints: text.optional(),
      endpointDependency: text.optional(),
      topology: text.optional(),
      instanceTopology: text.optional(),
      deployment: text.optional(),
    })
    .strict();

  const layer = z
    .object({
      key: z.string().regex(/^[A-Z0-9_]+$/, 'must be UPPER_SNAKE (matches the OAP layer enum)'),
      alias: text.optional(),
      splitByServiceGroup: z.boolean().optional(),
      group: text.optional(),
      visibility: z.enum(['public', 'operate']).optional(),
      color: text.optional(),
      documentLink: text.optional(),
      aliases: aliasesSchema.optional(),
      slots: aliasesSchema.optional(),
      components: componentsSchema,
      'layer-header': headerSchema.optional(),
      // Legacy alias the loader still reads (older / operator-exported files).
      metrics: headerSchema.optional(),
      dashboards: dashboardsSchema.optional(),
      widgets: z.array(complete ? widgetSchema : pushWidgetSchema).optional(),
      topology: topologySchema.optional(),
      endpointDependency: endpointDependencySchema.optional(),
      processTopology: processTopologySchema.optional(),
      deployment: deploymentSchema.optional(),
      traces: z.object({ source: z.enum(['native', 'zipkin', 'both']).optional() }).strict().optional(),
      log: z.object({ scope: z.enum(['service', 'instance', 'endpoint']).optional() }).strict().optional(),
      naming: z
        .object({
          pattern: text,
          flags: z.string().optional(),
          displayGroup: z.string().optional(),
          valueGroup: z.string().optional(),
          alias: text,
        })
        .strict()
        .optional(),
      instances: z.object({ badge: text.optional() }).strict().optional(),
    })
    .strict();

  return { layer, headerSchema };
}

export const layerTemplateSchema = buildLayerSchemas(true).layer;

const pushSchemas = buildLayerSchemas(false);

/**
 * Layer content as the admin PUSH boundary accepts it — the routes that make a
 * template live for everyone (`POST /api/admin/templates/save`, `…/:name/
 * push-bundled`, `…/sync-all`), so a hand-edited or imported template is
 * rejected per-field instead of being stored and breaking that layer for every
 * user. Nothing earlier is checked: a browser-local draft is expected to be
 * half-authored, and only this step publishes.
 *
 * Same body as {@link layerTemplateSchema} at the push completeness bar (see
 * {@link buildLayerSchemas}), plus the one key a stored row carries that a
 * bundled file never should: `header`, which the layer loader adds to every
 * template it serves (normalising `layer-header` / the legacy `metrics`), so it
 * rides along in every row the editor loads and pushes back.
 */
export const layerTemplatePushSchema = pushSchemas.layer.extend({
  header: pushSchemas.headerSchema.optional(),
});

/** Overview KPI. `source: 'service-count'` reads the layer's service count
 *  and carries no MQE; every other KPI needs one (the loader DROPS a KPI
 *  that has neither). */
const overviewKpiSchema = z
  .object({
    label: z.string().min(1),
    mqe: z.string().min(1).optional(),
    unit: z.string().optional(),
    aggregation: aggregationSchema.optional(),
    style: z.enum(['number', 'progress-bar']).optional(),
    max: z.number().positive().optional(),
    source: z.enum(['mqe', 'service-count']).optional(),
  })
  .strict()
  .superRefine((k, ctx) => {
    if ((k.source ?? 'mqe') === 'mqe' && !k.mqe) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mqe'],
        message: 'an mqe-source KPI requires a non-empty `mqe`',
      });
    }
  });

const OVERVIEW_WIDGET_TYPES = [
  'metric',
  'topology',
  'section-break',
  'kpi-tile',
  'alarms',
  'metric-composite',
] as const;

/** Widgets that resolve without a layer binding; every other type needs
 *  `layer` or the loader drops it. */
const OVERVIEW_LAYERLESS_WIDGETS: ReadonlySet<string> = new Set(['section-break', 'alarms']);

const overviewWidgetSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    tip: z.string().optional(),
    layer: z.string().min(1).optional(),
    type: z.enum(OVERVIEW_WIDGET_TYPES),
    mqe: z.string().min(1).optional(),
    unit: z.string().optional(),
    aggregation: aggregationSchema.optional(),
    cols: z.number().int().positive().optional(),
    kpis: z.array(overviewKpiSchema).min(1).optional(),
    showCount: z.boolean().optional(),
    aggregateOnPage: z.boolean().optional(),
    limit: z.number().int().positive().optional(),
    rankBy: z
      .object({ kpi: z.number().int().min(0).optional(), mqe: z.string().min(1).optional() })
      .strict()
      .optional(),
    span: z.number().int().positive().optional(),
    rowSpan: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((w, ctx) => {
    const issue = (path: string, message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };
    if (!OVERVIEW_LAYERLESS_WIDGETS.has(w.type) && !w.layer) {
      issue('layer', `a "${w.type}" widget requires a \`layer\``);
    }
    // Below: what the renderer actually reads per type. A widget missing
    // its payload field fires no query and renders a permanently empty
    // cell; one carrying a field its type ignores is dead config.
    if (w.type === 'metric' && !w.mqe) issue('mqe', 'a "metric" widget requires an `mqe`');
    if ((w.type === 'kpi-tile' || w.type === 'metric-composite') && !w.kpis) {
      issue('kpis', `a "${w.type}" widget requires \`kpis\``);
    }
    if (OVERVIEW_LAYERLESS_WIDGETS.has(w.type) && w.kpis) {
      issue('kpis', `a "${w.type}" widget renders no kpis`);
    }
  });

export const overviewTemplateSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    visibility: z.enum(['public', 'operate']).optional(),
    icon: z.string().min(1).optional(),
    order: z.number().optional(),
    layers: z.array(z.string().min(1)).optional(),
    widgets: z.array(overviewWidgetSchema),
  })
  .strict();
