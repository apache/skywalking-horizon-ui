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

import type { LayerCaps, LayerDef } from '@skywalking-horizon-ui/api-client';

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
  overview?: LayerDef['overview'];
  naming?: LayerDef['naming'];
  traces?: LayerDef['traces'];
  /** Only the `instanceTopology` presence is read here, to gate the
   *  Instance-map drill-down cap — same rule the menu's `deriveLayer` uses. */
  topology?: { instanceTopology?: unknown };
}

/** `components.*` → `caps.*` (the tab-visibility flags the sidebar reads).
 *  `instanceTopology` is NOT a component flag: like the menu, it's gated on
 *  the parent Topology component (`serviceMap`) AND the presence of a
 *  `topology.instanceTopology` block — so a draft that enables it opens the
 *  Instance map in preview, and one that drops it hides it. */
export function componentsToCaps(
  components: Record<string, boolean | undefined> | undefined,
  topology?: { instanceTopology?: unknown },
): LayerCaps {
  const c = components ?? {};
  const serviceMap = !!c.topology;
  return {
    dashboards: !!c.service,
    instances: !!c.instances,
    endpoints: !!c.endpoints,
    serviceMap,
    instanceTopology: serviceMap && !!topology?.instanceTopology,
    endpointDependency: !!c.endpointDependency,
    traces: !!c.traces,
    logs: !!c.logs,
    podLogs: !!c.podLogs,
    traceProfiling: !!c.traceProfiling,
    ebpfProfiling: !!c.ebpfProfiling,
    asyncProfiling: !!c.asyncProfiling,
  };
}

/** Build a full LayerDef from template content — for previewing a layer
 *  OAP doesn't currently list (no live data). */
export function layerContentToDef(t: LayerTemplateContent): LayerDef {
  return {
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
    caps: componentsToCaps(t.components, t.topology),
    header: t.metrics,
    metrics: t.metrics,
    overview: t.overview,
    naming: t.naming,
    traces: t.traces,
  };
}

/** Overlay an existing menu LayerDef with a draft's menu-relevant fields
 *  (caps + slots) so the sidebar reflects the draft in preview mode. Keeps
 *  the live `serviceCount` / `color` / `name` from the menu entry. */
export function overlayLayerDef(base: LayerDef, t: LayerTemplateContent): LayerDef {
  return {
    ...base,
    slots: { ...base.slots, ...(t.slots ?? {}) },
    caps: componentsToCaps(t.components, t.topology),
  };
}
