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
 * Which sub-pages a layer exposes, and in what order — the single
 * definition every consumer reads.
 *
 * The BFF calls this while building each `LayerDef` and serves the result
 * as `menuRows`, so the sidebar, the layer's own click target, the
 * bare-`/layer/:key` redirect and the unsupported-route fallback all
 * answer from one list instead of four hand-maintained orderings.
 *
 * It lives in the shared client rather than the BFF because the admin
 * previews an UNPUSHED draft: `layerContentToDef()` / `overlayLayerDef()`
 * build a `LayerDef` in the browser from template content the BFF has
 * never seen, and must resolve rows the same way the runtime will.
 *
 * Rows carry no display text. UI chrome is translated client-side with
 * vue-i18n, and `check-ui-i18n.mjs` only recognises literal `t('…')`
 * arguments — a label shipped as data here would turn every sidebar
 * string into an unreferenced-key failure. The renderer maps `path` to
 * its own literal `t()` call and to the layer's slot aliases.
 */

import type { LayerCaps, LayerSlots } from './menu.js';

/** The `Icon` names a layer row can carry. Spelled out rather than typed
 *  as `string` so the sidebar's `IconName` prop still checks — the UI's
 *  icon union is the real constraint, and this must stay a subset of it. */
export type LayerMenuRowIcon = 'svc' | 'prof' | 'ep' | 'topo' | 'trace' | 'log' | 'web' | 'flame' | 'set' | 'ai';

/** One navigable row under a layer. */
export interface LayerMenuRow {
  /** Stable row key, and the route sub-path under `/layer/:layerKey/`.
   *  Built-in components are a single segment (`service`, `pprof`); an
   *  extension page is `<component>/<pageId>`. */
  path: string;
  /** `Icon` component name the sidebar renders for this row. */
  icon: LayerMenuRowIcon;
  /** Set on an extension-page row: the operator's page name, already
   *  localized by the BFF. Built-in rows carry no name — the sidebar
   *  resolves their labels through literal translation calls. */
  name?: string;
}

/**
 * An extension page as the runtime needs to know it: enough to route to
 * it, label it, and narrow the picker it sits above. The widgets
 * themselves ride the config bundle, not the menu.
 */
import type { InstanceAttributePredicate } from './instance-filter.js';

export interface DashboardPageRef {
  id: string;
  name: string;
  /** What this page calls the entity it lists, already localized. */
  alias?: string;
  /** Service pages: narrows the service list to what this page is about. */
  serviceFilter?: string;
  /** Instance pages: the same, for the instance list. */
  instanceFilter?: string;
  instanceAttributes?: InstanceAttributePredicate[];
}

/**
 * How long a page's id and name may be.
 *
 * The id becomes a URL segment, a `menuOrder` entry and a translation
 * key, so an unbounded one produces routes nobody can read or share and
 * keys that are awkward everywhere they appear. The name is display text
 * in a fixed-width selector and a sidebar row. Both bars enforce these,
 * from here, so the editor cannot mint what the publish schema refuses.
 */
export const MAX_EXT_PAGE_ID_LENGTH = 48;
export const MAX_EXT_PAGE_NAME_LENGTH = 64;

/** The extension pages a layer declares, per entity component. */
export type LayerExtPages = Partial<Record<'service' | 'instance' | 'endpoint', DashboardPageRef[]>>;

/** The narrowing a component's DEFAULT page applies — the same fields a
 *  page ref carries, for the page that has no id to be addressed by. */
export type EntityFilterRef = Omit<DashboardPageRef, 'id' | 'name'>;
export type LayerDefaultFilters = Partial<Record<'service' | 'instance' | 'endpoint', EntityFilterRef>>;

/** The parts of a layer that decide its rows. `LayerDef` satisfies this,
 *  and so does a draft assembled from template content. */
export interface LayerMenuInput {
  caps?: LayerCaps;
  slots?: LayerSlots;
  traces?: { source?: 'native' | 'zipkin' | 'both' };
  extPages?: LayerExtPages;
  /** Operator-defined row order. Absent means the default order below.
   *  Entries are row PATHS (`service`, `service/agents`, `pprof`), never
   *  display names — a rename must not reorder the menu. */
  menuOrder?: string[];
}

/** Which built-in row an entity component's extension pages follow. */
const EXT_PAGE_HOST: ReadonlyArray<['service' | 'instance' | 'endpoint', string]> = [
  ['service', 'service'],
  ['instance', 'instance'],
  ['endpoint', 'endpoint'],
];

/**
 * THE DEFAULT MENU ORDER — every built-in row, in the order the sidebar
 * has always rendered them. A layer with no operator-defined order shows
 * its rows in exactly this sequence, each entity component followed by its
 * own extension pages.
 *
 * Kept as a plain list, separate from the predicates below, so the order
 * is one reviewable thing rather than a side effect of where a definition
 * happens to sit. Reordering this line-by-line is the only way to change
 * the default order, and `layer-menu.test.ts` pins it against a frozen
 * transcript of the pre-refactor sidebar.
 *
 * Two orderings existed before — the sidebar's template and
 * `firstLayerTab`'s `if` chain — and they disagreed in the profiling tail,
 * so a layer could be sent to a tab that was not its first visible row.
 * The sidebar's order is the one operators actually see, so it is this.
 */
export const DEFAULT_LAYER_ROW_ORDER = [
  'service',
  'instance',
  'endpoint',
  'topology',
  'deployment',
  'dependency',
  'trace',
  'zipkin-trace',
  'logs',
  'browser-errors',
  'pod-logs',
  'conversations',
  'trace-profiling',
  'ebpf-profiling',
  'network-profiling',
  'continuous-profiling',
  'pprof',
  'async-profiling',
] as const;

export type BuiltInLayerRow = (typeof DEFAULT_LAYER_ROW_ORDER)[number];

/** What each built-in row needs to render and when it appears. Order is
 *  NOT expressed here — see {@link DEFAULT_LAYER_ROW_ORDER}. */
const ROW_DEFS: Record<BuiltInLayerRow, { icon: LayerMenuRowIcon; when: (L: LayerMenuInput) => boolean }> = {
  service: { icon: 'svc', when: (L) => Boolean(L.caps?.dashboards) },
  instance: { icon: 'prof', when: (L) => L.caps?.instances ?? Boolean(L.slots?.instances) },
  endpoint: { icon: 'ep', when: (L) => L.caps?.endpoints ?? Boolean(L.slots?.endpoints) },
  topology: {
    icon: 'topo',
    when: (L) => Boolean(L.caps?.serviceMap || L.caps?.instanceTopology || L.caps?.processTopology),
  },
  deployment: { icon: 'topo', when: (L) => Boolean(L.caps?.deployment) },
  dependency: { icon: 'ep', when: (L) => Boolean(L.caps?.endpointDependency) },
  trace: { icon: 'trace', when: (L) => Boolean(L.caps?.traces) },
  // Second trace row: the layer carries BOTH native and Zipkin spans, so
  // each format gets its own tab. Depends on the trace component itself.
  'zipkin-trace': {
    icon: 'trace',
    when: (L) => Boolean(L.caps?.traces) && L.traces?.source === 'both',
  },
  logs: { icon: 'log', when: (L) => Boolean(L.caps?.logs) },
  'browser-errors': { icon: 'web', when: (L) => Boolean(L.caps?.browserErrors) },
  'pod-logs': { icon: 'log', when: (L) => Boolean(L.caps?.podLogs) },
  conversations: { icon: 'ai', when: (L) => Boolean(L.caps?.aiConversations) },
  'trace-profiling': { icon: 'flame', when: (L) => Boolean(L.caps?.traceProfiling) },
  'ebpf-profiling': { icon: 'flame', when: (L) => Boolean(L.caps?.ebpfProfiling) },
  'network-profiling': { icon: 'prof', when: (L) => Boolean(L.caps?.networkProfiling) },
  'continuous-profiling': { icon: 'set', when: (L) => Boolean(L.caps?.continuousProfiling) },
  pprof: { icon: 'prof', when: (L) => Boolean(L.caps?.pprofProfiling) },
  'async-profiling': { icon: 'flame', when: (L) => Boolean(L.caps?.asyncProfiling) },
};

/** Where a layer goes when it has no rows at all — an unconfigured or
 *  not-yet-loaded layer still has to resolve to a real route. */
export const FALLBACK_LAYER_ROW = 'service';

const BUILT_IN_PATHS: ReadonlySet<string> = new Set(DEFAULT_LAYER_ROW_ORDER);

/** Whether `path` names a built-in layer sub-page at all, independent of
 *  whether a given layer exposes it. Distinguishes "this layer doesn't
 *  have that tab" from "that isn't a tab" — only the former is worth
 *  redirecting away from. */
export function isBuiltInLayerRow(path: string): boolean {
  return BUILT_IN_PATHS.has(path);
}

/**
 * The rows `layer` exposes, in sidebar order.
 *
 * Extension pages follow the component they belong to, in the order the
 * template lists them. They are ordinary sibling rows — nothing nests, and
 * nothing requires them to stay adjacent to their component once an
 * operator-defined order exists.
 *
 * A page under a component that resolves no row is dropped: it would have
 * no reachable entity to render against. Publishing rejects that state, so
 * this only guards content written straight to OAP.
 */
export function resolveLayerMenuRows(layer: LayerMenuInput | undefined | null): LayerMenuRow[] {
  if (!layer) return [];
  const rows: LayerMenuRow[] = [];
  for (const path of DEFAULT_LAYER_ROW_ORDER) {
    const def = ROW_DEFS[path];
    if (!def.when(layer)) continue;
    rows.push({ path, icon: def.icon });
    const host = EXT_PAGE_HOST.find(([, hostPath]) => hostPath === path);
    if (!host) continue;
    for (const page of layer.extPages?.[host[0]] ?? []) {
      rows.push({ path: `${path}/${page.id}`, icon: def.icon, name: page.name });
    }
  }
  return applyMenuOrder(rows, layer.menuOrder);
}

/**
 * Reorder resolved rows to the operator's stored order.
 *
 * Deliberately lenient about what the stored list contains, because it is
 * read from a store Horizon does not own and describes a layer whose
 * components can change after the order was saved:
 *
 *   - a named row that no longer resolves is skipped, not rendered;
 *   - a resolved row the order does not name keeps its DEFAULT position
 *     relative to the rows around it, appended after the ordered ones —
 *     so enabling a component adds its row instead of hiding it;
 *   - a duplicate name is honoured once.
 *
 * Publishing rejects all three, so this only ever sees a stale order or
 * one written straight to OAP. Dropping a row because of a stale entry
 * would make a feature unreachable with nothing on screen to explain it.
 */
function applyMenuOrder(rows: LayerMenuRow[], order: readonly string[] | undefined): LayerMenuRow[] {
  if (!order || order.length === 0) return rows;
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const out: LayerMenuRow[] = [];
  const placed = new Set<string>();
  for (const path of order) {
    const row = byPath.get(path);
    if (!row || placed.has(path)) continue;
    placed.add(path);
    out.push(row);
  }
  for (const row of rows) {
    if (!placed.has(row.path)) out.push(row);
  }
  return out;
}

/** Stored-order entries that publishing must refuse: a path no row
 *  resolves to, or a repeat. Returned in the order they were found so the
 *  admin can name them. */
export function menuOrderIssues(
  order: readonly string[] | undefined,
  rows: readonly LayerMenuRow[],
): Array<{ path: string; issue: 'unknown' | 'duplicate' }> {
  if (!order) return [];
  const known = new Set(rows.map((r) => r.path));
  const seen = new Set<string>();
  const out: Array<{ path: string; issue: 'unknown' | 'duplicate' }> = [];
  for (const path of order) {
    if (seen.has(path)) out.push({ path, issue: 'duplicate' });
    else if (!known.has(path)) out.push({ path, issue: 'unknown' });
    seen.add(path);
  }
  return out;
}

/**
 * The sub-route a layer should land on — its first row.
 *
 * Prefers rows the BFF already resolved; falls back to resolving from
 * caps/slots so a `LayerDef` assembled in the browser (admin preview of an
 * unpushed draft) answers identically.
 */
export function firstLayerMenuRow(
  layer: (LayerMenuInput & { menuRows?: LayerMenuRow[] }) | undefined | null,
): string {
  if (!layer) return FALLBACK_LAYER_ROW;
  const rows = layer.menuRows ?? resolveLayerMenuRows(layer);
  return rows[0]?.path ?? FALLBACK_LAYER_ROW;
}

/**
 * A layer with nothing to expand into — the sidebar renders it as a
 * direct link rather than an accordion.
 *
 * Two conditions, and BOTH are required. The row count alone would be the
 * cleaner rule, but it reclassifies layers that shipped before extension
 * pages existed: the three SO11Y agent layers expose only their instance
 * list, and turning them into direct links is a behaviour change to a
 * bundled layer that declares neither new field. The compatibility rule
 * has no exceptions, so the historical predicate stays as the first gate
 * and the row count only ever makes a layer MORE expandable.
 *
 * The `events` cap is part of that history: it produces no menu row, yet
 * it made a layer expandable. Keeping it here is bug-for-bug on purpose.
 * What the row count fixes is the opposite error: a layer whose second
 * row is podLogs, network / pprof / continuous profiling, or an extension
 * page used to be classified single-feature, so that row was unreachable.
 *
 * Lives here rather than in the UI so the bundled-layer regression test —
 * which runs in the BFF, where a UI import does not resolve — can call
 * the function instead of restating its formula and drifting from it.
 */
export function isSingleFeatureLayer(
  layer: LayerMenuInput & { menuRows?: LayerMenuRow[] },
): boolean {
  const rows = layer.menuRows ?? resolveLayerMenuRows(layer);
  return historicallySingleFeature(layer) && rows.length <= 1;
}

/** The predicate as it stood before row resolution was centralised.
 *  Frozen: it exists to preserve classification for layers that predate
 *  extension pages, not to be tidied. */
function historicallySingleFeature(L: LayerMenuInput): boolean {
  const c = L.caps ?? {};
  const hasInstances = c.instances ?? Boolean(L.slots?.instances);
  const hasEndpoints = c.endpoints ?? Boolean(L.slots?.endpoints);
  if (hasInstances || hasEndpoints) return false;
  if (c.serviceMap || c.instanceTopology || c.processTopology) return false;
  if (c.traces || c.logs || c.browserErrors || c.traceProfiling || c.ebpfProfiling || c.asyncProfiling || c.events) return false;
  if (c.endpointDependency || c.serviceMap || c.instanceTopology || c.processTopology || c.deployment) return false;
  return true;
}
