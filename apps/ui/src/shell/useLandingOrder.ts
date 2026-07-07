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
import type { LayerDef } from '@skywalking-horizon-ui/api-client';
import { useSetupStore } from '@/state/setup';

/**
 * Sort layers by `landing.priority` (lower first). Ties break by the OAP
 * catalog order already present in `layers` (since the BFF returned them
 * that way). Falls back to the `defaultPriority` table baked into the
 * setup store for layers the operator hasn't touched.
 *
 * Used by BOTH the Overview page (card order) and the sidebar's Layers
 * section (row order) so the two stay in lockstep.
 *
 * IMPORTANT: read priority via `store.priorityFor()` (side-effect-free),
 * never `store.ensure()` — `ensure` writes `configs.<layer>.landing`,
 * and inside a computed that READS the store those writes
 * invalidate the same computed → "Maximum recursive updates exceeded in
 * component <AppSidebar>", freezing the page on any layer route. Setup
 * reconciliation runs on the admin pages that explicitly call `ensure`.
 */
export function useLandingOrder(layers: ComputedRef<readonly LayerDef[]>) {
  const store = useSetupStore();
  return computed<LayerDef[]>(() => {
    return [...layers.value].sort((a, b) => {
      // A split layer's group-entries carry a composite `<layer>~<group>`
      // key; resolve priority from the BASE layer so they all land in the
      // layer's one slot, then keep them contiguous + group-sorted.
      const ba = a.key.split('~', 1)[0];
      const bb = b.key.split('~', 1)[0];
      const pa = store.priorityFor(ba);
      const pb = store.priorityFor(bb);
      if (pa !== pb) return pa - pb;
      if (ba === bb) return (a.serviceGroup ?? '').localeCompare(b.serviceGroup ?? '');
      return 0; // preserve incoming catalog order
    });
  });
}
