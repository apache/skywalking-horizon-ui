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

import { computed, type ComputedRef } from 'vue';
import { useRoute } from 'vue-router';
import type { LayerDef } from '@skywalking-horizon-ui/api-client';
import { useLayers } from '@/shell/useLayers';
import { entryKey, entryOf, resolveEntry, routeRow, type ResolvedEntry } from '@/utils/layerRoute';

/** The layer entry the route is on, resolved against the menu the way the
 *  layer shell resolves it; null off a layer route. */
export function useRouteEntry(): ComputedRef<ResolvedEntry | null> {
  const route = useRoute();
  const { layers } = useLayers();
  return computed(() => {
    const layer = route.params.layerKey;
    if (typeof layer !== 'string' || !layer) return null;
    const group = route.params.group;
    return resolveEntry(layers.value, layer, typeof group === 'string' ? group : undefined);
  });
}

/**
 * The entry key of the layer page the route is on — what its reads take, so a
 * group entry's reads carry its group. `''` off a layer route. A tab mounts
 * only once the layer shell has found its entry in the menu, so the key is
 * settled by the time a tab reads with it.
 */
export function useLayerEntryKey(): ComputedRef<string> {
  const entry = useRouteEntry();
  // The menu entry's own key when there is one, so a view finding its layer
  // in the menu by key finds it.
  return computed(() => entry.value?.def?.key ?? entry.value?.key ?? '');
}

/** Is the route on this menu entry, and on which of its rows? A bare entry
 *  URL is on its first row. */
export function useActiveEntry() {
  const route = useRoute();
  const entry = useRouteEntry();
  function isEntryActive(L: Pick<LayerDef, 'key'>): boolean {
    return entry.value !== null && entry.value.key === entryKey(entryOf(L));
  }
  function isRowActive(L: Pick<LayerDef, 'key'>, row: string, firstRow: string): boolean {
    if (!isEntryActive(L)) return false;
    const at = routeRow(route);
    return at === row || (at === undefined && row === firstRow);
  }
  return { entry, isEntryActive, isRowActive, onEntryBareUrl: computed(() => routeRow(route) === undefined) };
}
