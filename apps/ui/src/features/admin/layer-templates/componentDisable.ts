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
 * What switching an entity component OFF removes from a draft.
 *
 * Everything here is reachable only through that component, so leaving
 * any of it behind produces configuration with no menu row to open it and
 * no selector to delete it from — invisible until a publish rejects the
 * template for carrying it.
 *
 * Extracted from the confirm handler so the tests exercise THIS, not a
 * copy of it. The copy they held drifted immediately: it omitted the
 * default-page filter and the instance-list configuration, both of which
 * the handler removes and one of which publish refuses.
 */

import type { AdminLayerTemplate } from '@/api/client';

export type EntityScope = 'service' | 'instance' | 'endpoint';

/** Non-entity components own a configuration block each. */
export const COMPONENT_OWNED_BLOCK: Record<string, 'topology' | 'deployment' | 'endpointDependency'> = {
  topology: 'topology',
  deployment: 'deployment',
  endpointDependency: 'endpointDependency',
};

/** Everything the component owns, counted for the confirmation so it can
 *  name what goes — and so a component whose ONLY configuration is one of
 *  these does not take the silent "nothing to delete" path. */
export function componentOwnedCount(
  tpl: AdminLayerTemplate,
  scope: EntityScope,
): { grid: number; pages: number; pageWidgets: number; settings: number } {
  const grid =
    (tpl.dashboards?.[scope]?.length ?? 0) +
    // The legacy flat list IS the service grid for a template that never
    // split, so counting only `dashboards` let it be deleted unmentioned.
    (scope === 'service' ? (tpl.widgets?.length ?? 0) : 0);
  const pages = tpl.dashboardExtPages?.[scope] ?? [];
  return {
    grid,
    pages: pages.length,
    pageWidgets: pages.reduce((n, p) => n + p.widgets.length, 0),
    settings:
      (scope === 'instance' && (tpl as { instances?: unknown }).instances ? 1 : 0) +
      (tpl.dashboardDefaultFilters?.[scope] ? 1 : 0),
  };
}

/** Remove every trace of an entity component from the draft. */
export function disableEntityComponent(tpl: AdminLayerTemplate, componentKey: string, scope: EntityScope): void {
  (tpl.components as Record<string, boolean | undefined>)[componentKey] = false;

  if (tpl.dashboardExtPages) {
    delete tpl.dashboardExtPages[scope];
    if (Object.keys(tpl.dashboardExtPages).length === 0) delete tpl.dashboardExtPages;
  }
  if (tpl.dashboards) {
    delete tpl.dashboards[scope];
    if (Object.keys(tpl.dashboards).length === 0) delete tpl.dashboards;
  }
  if (scope === 'service') delete (tpl as { widgets?: unknown }).widgets;

  // Both the component's row and every one of its pages.
  if (tpl.menuOrder) {
    tpl.menuOrder = tpl.menuOrder.filter((p) => p !== scope && !p.startsWith(`${scope}/`));
    if (tpl.menuOrder.length === 0) delete tpl.menuOrder;
  }

  // `instances` drives the instance list's badge and nothing else, so it
  // is dead weight the moment the component is off — and would come back
  // unannounced if the component were re-enabled later.
  if (scope === 'instance') delete (tpl as { instances?: unknown }).instances;

  // Publish refuses a filter under a component that is off, so leaving it
  // builds a draft that cannot be pushed.
  if (tpl.dashboardDefaultFilters) {
    delete tpl.dashboardDefaultFilters[scope];
    if (Object.keys(tpl.dashboardDefaultFilters).length === 0) delete tpl.dashboardDefaultFilters;
  }
}

/** Remove the configuration block a non-entity component owns. */
export function disableOwnedBlock(tpl: AdminLayerTemplate, componentKey: string): void {
  (tpl.components as Record<string, boolean | undefined>)[componentKey] = false;
  const block = COMPONENT_OWNED_BLOCK[componentKey];
  if (block) delete (tpl as unknown as Record<string, unknown>)[block];
}
