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
 * What a save of the layer editor writes: only what the template's current
 * settings use. Every save runs it — a push publishes the saved draft — so the
 * stored template never carries a shape the editor cannot show, a field of a
 * mode no longer selected, or a leftover the push refuses the whole layer for.
 * Mutates in place, so the editor shows what was saved.
 */

import type { AdminLayerTemplate } from '@/api/client';
import type { DashboardWidget } from '@skywalking-horizon-ui/api-client';
import { walkWidgets } from '@skywalking-horizon-ui/api-client';

const ENTITY_PAGE_SCOPES = new Set(['instance', 'endpoint']);
/** The push schema's bounds for a widget's grid footprint. */
const MAX_SPAN = 12;
const MAX_ROW_SPAN = 64;

/** `before` is the template as this edit began — what was loaded or last
 *  saved, an imported file included. */
export function cleanLayerTemplate(tpl: AdminLayerTemplate, before: AdminLayerTemplate | null): void {
  migrateProfilingComponent(tpl);
  dropLabelsOfOffComponents(tpl);
  stripEmptyDeployment(tpl);
  dropBlankConditions(tpl);
  dropEmptyGrids(tpl, before);
  for (const w of allWidgets(tpl)) cleanWidget(w);
  for (const block of [tpl.topology, tpl.deployment, tpl.endpointDependency, tpl.processTopology]) {
    cleanThresholds(block);
  }
}

/** The single `profiling` flag became `traceProfiling`; the push schema no
 *  longer knows the old key, and the editor has no control for it. */
function migrateProfilingComponent(tpl: AdminLayerTemplate): void {
  const c = tpl.components as (AdminLayerTemplate['components'] & { profiling?: boolean }) | undefined;
  if (!c || c.profiling === undefined) return;
  if (c.traceProfiling === undefined) c.traceProfiling = c.profiling;
  delete c.profiling;
}

/** The labels that name one component's own row, and that component. The
 *  entity nouns — services, instances, endpoints — are not among them: the
 *  layer header, the service picker and the maps use them whatever pages are
 *  on. */
const LABEL_OF: Record<string, string> = {
  topology: 'topology',
  deployment: 'deployment',
  endpointDependency: 'endpointDependency',
};

/** The label of a component switched off names a row that does not exist, and
 *  would come back unannounced with the component. Only an explicit off. */
function dropLabelsOfOffComponents(tpl: AdminLayerTemplate): void {
  const components = (tpl.components ?? {}) as Record<string, boolean | undefined>;
  for (const field of ['slots', 'aliases'] as const) {
    const labels = (tpl as unknown as Record<string, Record<string, string> | undefined>)[field];
    if (!labels) continue;
    // Keys only: an empty `slots` still overrides `aliases`, as the sidebar
    // reads `slots ?? aliases`.
    for (const [label, component] of Object.entries(LABEL_OF)) {
      if (components[component] === false) delete labels[label];
    }
  }
}

/** An all-empty `deployment` block carries no renderable config, but its
 *  presence alone turns the Deployment row on — so an editor opened and
 *  abandoned would enable the tab. Its menu entry goes with it. */
function stripEmptyDeployment(tpl: AdminLayerTemplate): void {
  const d = tpl.deployment;
  if (!d) return;
  const hasMetrics =
    (d.nodeMetrics?.length ?? 0) > 0 ||
    (d.linkServerMetrics?.length ?? 0) > 0 ||
    (d.linkClientMetrics?.length ?? 0) > 0 ||
    (d.roleToRole?.some((p) => (p.metrics?.length ?? 0) > 0) ?? false) ||
    (d.roles?.some((r) => (r.nodeMetrics?.length ?? 0) > 0) ?? false);
  if (hasMetrics || d.clusterBy || d.siblingBy || d.roleBy || d.roles?.length) return;
  delete tpl.deployment;
  if (tpl.menuOrder?.includes('deployment')) tpl.menuOrder = tpl.menuOrder.filter((p) => p !== 'deployment');
}

/** A condition with no attribute filters nothing, and the push refuses it. */
function dropBlankConditions(tpl: AdminLayerTemplate): void {
  const filters = [
    ...Object.values(tpl.dashboardExtPages ?? {}).flatMap((pages) => pages ?? []),
    ...Object.values(tpl.dashboardDefaultFilters ?? {}),
  ];
  for (const f of filters) {
    if (!f?.instanceAttributes) continue;
    f.instanceAttributes = f.instanceAttributes.filter((a) => a.attribute.trim() !== '');
    if (f.instanceAttributes.length === 0) delete f.instanceAttributes;
  }
}

/**
 * An empty grid is not the same as none: an Instance or Endpoint page with no
 * grid of its own shows the Service grid, while an empty one shows nothing.
 * So an empty entity grid the template did not have when the edit began — one
 * widget added and removed again — is no grid at all; one it had, imported or
 * stored, is kept. Grids of other scopes are never rendered, so an empty one
 * says nothing.
 */
function dropEmptyGrids(tpl: AdminLayerTemplate, before: AdminLayerTemplate | null): void {
  const d = tpl.dashboards;
  if (!d) return;
  for (const [scope, widgets] of Object.entries(d)) {
    if (scope === 'service' || widgets.length > 0) continue;
    if (ENTITY_PAGE_SCOPES.has(scope) && before?.dashboards?.[scope] !== undefined) continue;
    delete d[scope];
  }
}

function* allWidgets(tpl: AdminLayerTemplate): Generator<DashboardWidget> {
  for (const widgets of Object.values(tpl.dashboards ?? {})) yield* walkWidgets(widgets);
  for (const pages of Object.values(tpl.dashboardExtPages ?? {})) {
    for (const page of pages ?? []) yield* walkWidgets(page.widgets);
  }
  yield* walkWidgets(tpl.widgets);
}

function cleanWidget(w: DashboardWidget): void {
  const fields = w as unknown as Record<string, unknown>;
  // The old free-text predicate: the BFF ignores it, and the editor cannot show it.
  if (typeof w.visibleWhen !== 'object' || w.visibleWhen === null) delete w.visibleWhen;
  // Only an enum card reads its value map.
  if (w.format !== 'enum') {
    delete w.valueMap;
    delete w.valueColors;
  }
  // A cleared number input holds "", which no reader takes for a number.
  for (const key of ['span', 'rowSpan', 'labelTopN']) if (fields[key] === '') delete fields[key];
  // Legacy 24-column coordinates, converted the way the dashboard reads them.
  if (w.span === undefined && typeof w.w === 'number') w.span = Math.max(1, Math.min(MAX_SPAN, Math.round(w.w / 2)));
  if (w.rowSpan === undefined && typeof w.h === 'number') w.rowSpan = Math.max(1, Math.min(MAX_ROW_SPAN, Math.round(w.h / 8)));
  delete w.x;
  delete w.y;
  delete w.w;
  delete w.h;
}

/** Every `thresholds` object in a config block: a cleared input holds "", and
 *  an invert base under an explicit "no invert" is read by nothing. */
function cleanThresholds(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) cleanThresholds(item);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const th = obj.thresholds as Record<string, unknown> | undefined;
  if (th && typeof th === 'object') {
    for (const key of ['ok', 'warn', 'danger', 'invertBase']) if (th[key] === '') delete th[key];
    if (th.invertHealth === false) delete th.invertBase;
  }
  for (const [key, value] of Object.entries(obj)) if (key !== 'thresholds') cleanThresholds(value);
}
