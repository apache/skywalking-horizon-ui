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
 * Map a layer TEMPLATE (the admin/editor JSON shape — `components`,
 * `slots`, etc.) to a menu `LayerDef`. Used to render preview pages and to
 * overlay the sidebar menu from a browser-local draft so the per-layer tab
 * set reflects the draft's enabled components — without pushing anything to
 * OAP. The `components` flags drive the cap-based tab visibility.
 */

import type { LayerCaps, LayerDef, LayerDefaultFilters, LayerExtPages } from '@skywalking-horizon-ui/api-client';
import type { InstanceAttributePredicate } from '@skywalking-horizon-ui/api-client';
import { resolveLayerMenuRows } from '@skywalking-horizon-ui/api-client';

/** Loose view of a layer template's menu-relevant fields. */
export interface LayerTemplateContent {
  key: string;
  alias?: string;
  color?: string;
  group?: string;
  visibility?: 'public' | 'operate';
  documentLink?: string;
  components?: Record<string, boolean | undefined>;
  slots?: LayerDef['slots'];
  metrics?: LayerDef['metrics'];
  naming?: LayerDef['naming'];
  traces?: LayerDef['traces'];
  /** Only the `instanceTopology` presence is read here, to gate the
   *  Instance-map drill-down cap — same rule the menu's `deriveLayer` uses. */
  topology?: { instanceTopology?: unknown };
  /** Presence gates the Deployment cap (with its component
   *  flag), so a draft enabling it opens the Deployment tab in preview. */
  deployment?: unknown;
  /** Extension pages the draft declares. Read so a previewed draft grows
   *  and loses page rows as the operator edits, instead of showing the
   *  published set. */
  dashboardExtPages?: Partial<
    Record<
      'service' | 'instance' | 'endpoint',
      Array<{
        id: string;
        name: string;
        alias?: string;
        serviceFilter?: string;
        instanceFilter?: string;
        instanceAttributes?: InstanceAttributePredicate[];
      }>
    >
  >;
  /** Narrowing on each component's default page. */
  dashboardDefaultFilters?: Partial<
    Record<
      'service' | 'instance' | 'endpoint',
      { serviceFilter?: string; instanceFilter?: string; instanceAttributes?: InstanceAttributePredicate[] }
    >
  >;
  /** Operator-defined row order, so a draft reorders in preview. */
  menuOrder?: string[];
}

/** `components.*` → `caps.*` (the tab-visibility flags the sidebar reads).
 *  `instanceTopology` is NOT a component flag: like the menu, it's gated on
 *  the parent Topology component (`serviceMap`) AND the presence of a
 *  `topology.instanceTopology` block — so a draft that enables it opens the
 *  Instance map in preview, and one that drops it hides it.
 *
 *  This has to agree flag-for-flag with the menu route's mapping: it is
 *  what a PREVIEW resolves rows from, and a preview that disagrees with
 *  the runtime is worse than no preview. */
export function componentsToCaps(
  components: Record<string, boolean | undefined> | undefined,
  topology?: { instanceTopology?: unknown },
  deployment?: unknown,
): LayerCaps {
  const c = components ?? {};
  const serviceMap = !!c.topology;
  return {
    // Absent means ON, matching the menu route — only an explicit `false`
    // turns the service page off. Reading an absent flag as OFF hid the
    // Service row from every preview of a template that never named it,
    // while the runtime showed one.
    dashboards: c.service !== false,
    instances: !!c.instances,
    endpoints: !!c.endpoints,
    serviceMap,
    processTopology: serviceMap,
    instanceTopology: serviceMap && !!topology?.instanceTopology,
    deployment: !!c.deployment && !!deployment,
    endpointDependency: !!c.endpointDependency,
    traces: !!c.traces,
    logs: !!c.logs,
    browserErrors: !!c.browserErrors,
    podLogs: !!c.podLogs,
    traceProfiling: !!c.traceProfiling,
    ebpfProfiling: !!c.ebpfProfiling,
    asyncProfiling: !!c.asyncProfiling,
    networkProfiling: !!c.networkProfiling,
    pprofProfiling: !!c.pprofProfiling,
    continuousProfiling: !!c.continuousProfiling,
    aiConversations: !!c.aiConversations,
  };
}

/** Build a full LayerDef from template content — for previewing a layer
 *  OAP doesn't currently list (no live data). */
export function layerContentToDef(t: LayerTemplateContent): LayerDef {
  return withDraftMenuRows({
    key: t.key,
    name: t.alias || t.key,
    color: t.color || 'var(--sw-fg-3)',
    serviceCount: 0,
    active: false,
    level: null,
    group: t.group,
    visibility: t.visibility,
    normal: null,
    documentLink: t.documentLink,
    slots: t.slots ?? {},
    caps: componentsToCaps(t.components, t.topology, t.deployment),
    extPages: extPagesOf(t),
    defaultFilters: defaultFiltersOf(t),
    menuOrder: t.menuOrder,
    metrics: t.metrics,
    naming: t.naming,
    traces: t.traces,
  });
}

/** Mirrors the BFF's `defaultFilterRefs` — a preview that disagrees with
 *  the runtime about what a page shows is worse than no preview. */
function defaultFiltersOf(t: LayerTemplateContent): LayerDefaultFilters | undefined {
  const src = t.dashboardDefaultFilters;
  if (!src) return undefined;
  const out: LayerDefaultFilters = {};
  for (const scope of ['service', 'instance', 'endpoint'] as const) {
    const f = src[scope];
    if (!f) continue;
    const ref = {
      ...(f.serviceFilter === undefined ? {} : { serviceFilter: f.serviceFilter }),
      ...(f.instanceFilter === undefined ? {} : { instanceFilter: f.instanceFilter }),
      ...(f.instanceAttributes === undefined ? {} : { instanceAttributes: f.instanceAttributes }),
    };
    if (Object.keys(ref).length > 0) out[scope] = ref;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The draft's page refs, in the shape the row resolver reads. Widgets are
 *  left out — the menu only needs to route to and label a page. */
function extPagesOf(t: LayerTemplateContent): LayerExtPages | undefined {
  const src = t.dashboardExtPages;
  if (!src) return undefined;
  const out: LayerExtPages = {};
  for (const scope of ['service', 'instance', 'endpoint'] as const) {
    const pages = src[scope];
    if (!pages?.length) continue;
    out[scope] = pages.map((p) => ({
      id: p.id,
      name: p.name,
      ...(p.alias === undefined ? {} : { alias: p.alias }),
      ...(p.serviceFilter === undefined ? {} : { serviceFilter: p.serviceFilter }),
      ...(p.instanceFilter === undefined ? {} : { instanceFilter: p.instanceFilter }),
      ...(p.instanceAttributes === undefined ? {} : { instanceAttributes: p.instanceAttributes }),
    }));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Resolve rows from the DRAFT's caps and pages rather than inheriting
 *  whatever the BFF resolved for the published template — otherwise a
 *  preview shows the published menu while rendering the draft. */
function withDraftMenuRows(def: LayerDef): LayerDef {
  return { ...def, menuRows: resolveLayerMenuRows(def) };
}

/** Overlay an existing menu LayerDef with a draft's menu-relevant fields
 *  (caps + slots) so the sidebar reflects the draft in preview mode. Keeps
 *  the live `serviceCount` / `color` / `name` from the menu entry. */
export function overlayLayerDef(base: LayerDef, t: LayerTemplateContent): LayerDef {
  return withDraftMenuRows({
    ...base,
    slots: { ...base.slots, ...(t.slots ?? {}) },
    caps: componentsToCaps(t.components, t.topology, t.deployment),
    // The DRAFT's pages replace the published ones outright rather than
    // merging: a page the operator deleted has to disappear from preview.
    extPages: extPagesOf(t),
    defaultFilters: defaultFiltersOf(t),
    menuOrder: t.menuOrder,
  });
}
