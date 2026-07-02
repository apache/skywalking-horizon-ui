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
 * Request-body + widget validation schemas for the dashboard query route.
 * `scopeSchema` is also consumed by the GET-config handler (config/dashboard.ts).
 */

import { z } from 'zod';

/** A leaf widget — the five queryable kinds, used both at the top level and
 *  inside a tab panel. `widgetSchema` below extends it to add the `tab`
 *  container (one level deep: a tab's children are leaves). */
const leafWidgetSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  tip: z.string().optional(),
  type: z.enum(['card', 'line', 'top', 'record', 'table']),
  // Cap is 16: JVM Memory Detail carries 11 pool metrics (code cache +
  // young/old/survivor/permgen/metaspace + z-heap + compressed class space
  // + 3 segmented codeheaps), and a few language families approach the same
  // range; 16 leaves headroom for future relabeled bundles.
  expressions: z.array(z.string().min(1)).min(1).max(16),
  expressionLabels: z.array(z.string()).max(16).optional(),
  expressionUnits: z.array(z.string()).max(16).optional(),
  expressionAxes: z.array(z.number().int().min(0).max(1)).max(16).optional(),
  unit: z.string().optional(),
  tableHeaders: z.tuple([z.string(), z.string()]).optional(),
  showTableValues: z.boolean().optional(),
  span: z.number().int().min(1).max(12).optional(),
  rowSpan: z.number().int().min(1).max(64).optional(),
  // Card value formatting + enum maps. The resolver gates colored status
  // chips on format:'enum' + valueColors, so both must survive validation.
  format: z.enum(['int', 'decimal', 'compact', 'duration', 'enum']).optional(),
  valueMap: z.record(z.string()).optional(),
  valueColors: z.record(z.string()).optional(),
  labelTopN: z.number().int().min(1).max(50).optional(),
  // Structured visibility gate. `.catch(undefined)` makes the parse
  // TOLERANT: a legacy free-text predicate (`"<metric> has value"` /
  // `#entity.x`) left over in an OAP-stored dashboard resolves to
  // `undefined` (ungated) instead of failing the whole widget/template
  // parse. New gates are authored as the structured object.
  visibleWhen: z
    .union([
      z.object({ kind: z.literal('mqe'), expression: z.string().min(1), op: z.literal('exists') }),
      z.object({
        kind: z.literal('mqe'),
        expression: z.string().min(1),
        op: z.enum(['gt', 'lt']),
        value: z.number(),
      }),
      z.object({ kind: z.literal('entity'), attribute: z.string().min(1), op: z.literal('exists') }),
      z.object({
        kind: z.literal('entity'),
        attribute: z.string().min(1),
        op: z.literal('eq'),
        value: z.string(),
      }),
    ])
    .optional()
    .catch(undefined),
  // Tolerant like `visibleWhen`: a bad value maps to undefined, not a parse fail.
  traceDrill: z
    .object({ mode: z.enum(['off', 'latency', 'error']) })
    .optional()
    .catch(undefined),
  // Legacy x/y/w/h kept optional for back-compat.
  x: z.number().int().min(0).optional(),
  y: z.number().int().min(0).optional(),
  w: z.number().int().positive().optional(),
  h: z.number().int().positive().optional(),
});

/** Full widget schema: a leaf, plus the `tab` container. A `tab` carries no MQE
 *  of its own (so `expressions` may be empty) and holds named panels of leaf
 *  widgets in `tabs`. The SPA flattens to the active tab before posting; the
 *  BFF also flattens (see `flattenTabWidgets`) so the pipeline only sees leaves. */
export const widgetSchema = leafWidgetSchema
  .extend({
    type: z.enum(['card', 'line', 'top', 'record', 'table', 'tab']),
    // Relaxed to allow the empty array a `tab` container carries; the refine
    // below keeps every NON-tab leaf at ≥1 expression (an empty-MQE leaf would
    // otherwise pass here and render blank).
    expressions: z.array(z.string().min(1)).max(16),
    tabs: z
      .array(z.object({ name: z.string(), widgets: z.array(leafWidgetSchema).max(40) }))
      .max(20)
      .optional(),
  })
  .superRefine((w, ctx) => {
    if (w.type !== 'tab' && w.expressions.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expressions'],
        message: 'a non-tab widget requires at least one expression',
      });
    }
  });

/** Shared with config/dashboard.ts (GET-config handler). */
export const scopeSchema = z.enum([
  'service',
  'instance',
  'endpoint',
  'dependency',
  'topology',
  'trace',
  'logs',
  'traceProfiling',
  'ebpfProfiling',
  'asyncProfiling',
]);

/** Per-request queryable-widget cap (mirrors the SPA's chunk size). Enforced on
 *  the body pre-expansion (zod) AND on the leaf count after tab flattening. */
export const MAX_REQUEST_WIDGETS = 40;

export const bodySchema = z.object({
  service: z.string().optional(),
  /** Selected instance name. Honored only when `scope === 'instance'`
   *  (or any instance-derived scope) — the BFF flips the MQE entity to
   *  `{ scope: ServiceInstance, serviceName, serviceInstanceName }` so
   *  every widget on the Instance page evaluates against the chosen
   *  pair instead of the parent service. */
  serviceInstance: z.string().optional(),
  /** Selected endpoint name, analogous to `serviceInstance` but for
   *  the Endpoint page. Switches the entity to
   *  `{ scope: Endpoint, serviceName, endpointName }`. */
  endpoint: z.string().optional(),
  // Hard cap per request — protects OAP's storage page-size cliffs
  // (CLAUDE.md warns about backend-specific thresholds). The UI is
  // responsible for chunking widget sets larger than this across
  // multiple requests; the BFF refuses oversized bodies up-front so
  // an accidentally-huge template never reaches OAP. The cap is
  // re-checked AFTER tab expansion (a container counts as 1 here but
  // flattens to many leaves) — see the handler.
  widgets: z.array(widgetSchema).max(MAX_REQUEST_WIDGETS).optional(),
  scope: scopeSchema.optional(),
  /** Global time-range, forwarded by the SPA's time picker. When all
   *  three are present the BFF queries OAP at the requested precision
   *  and window; otherwise it falls back to the last-hour MINUTE
   *  default. `step` must match OAP's downsampling tiers and drives the
   *  date-string format (verifyDateTimeString rejects a mismatch). */
  step: z.enum(['MINUTE', 'HOUR', 'DAY']).optional(),
  startMs: z.number().int().positive().optional(),
  endMs: z.number().int().positive().optional(),
});
