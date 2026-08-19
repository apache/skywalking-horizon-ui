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
 * Metric catalog — the "layer → metric list" the agent reads to know WHAT to
 * query. Derived LIVE from the in-use layer templates (through the shared 30s
 * template cache), so it always reflects the current templates — no stale
 * precomputed index, no RAG. Each entry carries the curated title, the ready
 * MQE, unit, and the widget type (which follows the MQE shape). `explanation`
 * is the widget `tip` where the template author wrote one; where absent the
 * agent describes the metric from title + MQE + scope. Coverage is whatever
 * the templates expose — a metric an operator adds shows up on the next read.
 */

import type {
  DashboardScope,
  DashboardWidgetType,
  UITemplateClient,
} from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../../../config/loader.js';
import type { EffectiveLayerReason } from '../../../../logic/layers/effective.js';
import { resolveEffectiveLayer } from '../../../../logic/layers/effective.js';
import { allWidgetsForScope } from '../../../../logic/layers/loader.js';
import { flattenEveryTabPanel } from '../../../../logic/dashboard/gates.js';

export interface CatalogEntry {
  layer: string;
  scope: DashboardScope;
  widgetId: string;
  title: string;
  widgetType: DashboardWidgetType;
  expressions: string[];
  unit?: string;
  /** Template `tip` when present; the metric's human explanation. */
  explanation?: string;
  /** Raw OAP metric-ids parsed out of the MQE (informational grounding). */
  metricIds: string[];
}

export interface CatalogDeps {
  config: ConfigSource;
  uiTemplateClient?: () => UITemplateClient;
}

// MQE tokens that are NOT metric-ids but survive the "not followed by (" test:
// top_n sort direction, boolean literals, common label/keyword args.
const MQE_STOPWORDS = new Set([
  'asc',
  'des',
  'true',
  'false',
  'current',
  'general',
  'absolute',
  'relative',
]);

/**
 * Best-effort extraction of raw metric-ids from a set of MQE expressions.
 * Heuristic: strip label selectors / string literals, then take identifiers
 * that are NOT immediately followed by `(` (those are MQE functions) and
 * aren't known non-metric keywords. Informational only — the executed thing
 * is the MQE string itself, so occasional over/under-capture is harmless.
 */
export function parseMetricIds(expressions: string[]): string[] {
  const ids = new Set<string>();
  for (const raw of expressions) {
    if (!raw) continue;
    const cleaned = raw
      .replace(/\{[^}]*\}/g, ' ')
      .replace(/'[^']*'/g, ' ')
      .replace(/"[^"]*"/g, ' ');
    const re = /([a-zA-Z_][a-zA-Z0-9_]*)\s*(\()?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned)) !== null) {
      const name = m[1];
      if (m[2] === '(') continue; // function call, not a metric
      if (MQE_STOPWORDS.has(name)) continue;
      if (/^\d+$/.test(name)) continue;
      ids.add(name);
    }
  }
  return [...ids];
}

export interface LayerCatalog {
  entries: CatalogEntry[];
  /** Why `entries` is empty, when it is. `ok` with no entries means the
   *  template genuinely carries no metrics at this scope; anything else means
   *  Horizon could not read them, which is a different answer for a caller to
   *  give an operator. */
  reason: EffectiveLayerReason;
}

/**
 * The metrics available on one `(layer, scope)` dashboard page, read from the
 * in-use template.
 *
 * Empty is never self-explanatory here: an unreachable admin port, an
 * administrator-disabled layer, an unsynced layer and a scope with no widgets
 * all produce zero entries. Reporting them alike states an OAP outage as
 * "nothing to see", so the resolver's reason rides along.
 */
export async function getLayerCatalog(
  deps: CatalogDeps,
  layer: string,
  scope: DashboardScope,
): Promise<LayerCatalog> {
  const eff = await resolveEffectiveLayer(deps.uiTemplateClient, layer);
  if (eff.blocked || !eff.template) return { entries: [], reason: eff.reason };
  // Every page of the scope, not just the default grid — a widget is
  // addressed as layer + scope + id, which is what makes ids unique
  // across a component's pages.
  const widgets = flattenEveryTabPanel(allWidgetsForScope(eff.template, scope));
  const entries = widgets.map((w) => ({
    layer: layer.toUpperCase(),
    scope,
    widgetId: w.id,
    title: w.title,
    widgetType: w.type,
    expressions: w.expressions ?? [],
    unit: w.unit,
    explanation: w.tip,
    metricIds: parseMetricIds(w.expressions ?? []),
  }));
  return { entries, reason: eff.reason };
}
