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
 * Stable, id-keyed hue assignment for a locked-entity set. Each entity
 * holds its palette slot across set mutations: removing one entity never
 * re-hues another, and a new entity takes the LOWEST freed slot — so the
 * same entity keeps one color across the chip bar, the compare grid, and
 * the overlay drill-out (decode the color map once).
 *
 * Slot assignment lives in the plain `syncToIds(ids)` function (call it
 * from a `watch` on the active set), NOT a side-effecting computed —
 * a getter that mutated its own backing Map would double-fire under
 * dev StrictMode-style double-eval.
 */

import { computed, ref } from 'vue';
import { ENTITY_PALETTE } from './metricColor';

export interface EntityHue {
  name: string;
  hue: string;
  slot: number;
}

export function useEntityPalette() {
  // name -> palette slot, stable across mutations.
  const slotByName = ref<Map<string, number>>(new Map());
  // last-synced id order — drives `list` (lock order, not slot order).
  const orderedIds = ref<string[]>([]);

  /** Reconcile slots to `ids`: survivors keep their slot, departed
   *  entities free theirs, and each new entity takes the lowest free
   *  slot. Idempotent for an unchanged set. Call from a watcher. */
  function syncToIds(ids: readonly string[]): void {
    const current = slotByName.value;
    const next = new Map<string, number>();
    const used = new Set<number>();
    // 1. survivors keep their existing slot.
    for (const id of ids) {
      const s = current.get(id);
      if (s !== undefined && !used.has(s)) {
        next.set(id, s);
        used.add(s);
      }
    }
    // 2. new entities take the lowest free slot.
    for (const id of ids) {
      if (next.has(id)) continue;
      let s = 0;
      while (used.has(s)) s += 1;
      used.add(s);
      next.set(id, s);
    }
    slotByName.value = next;
    orderedIds.value = [...ids];
  }

  const byName = computed<Map<string, EntityHue>>(() => {
    const out = new Map<string, EntityHue>();
    for (const [name, slot] of slotByName.value) {
      out.set(name, { name, hue: ENTITY_PALETTE[slot % ENTITY_PALETTE.length], slot });
    }
    return out;
  });

  /** Hues in lock order (the order entities appear in the active set). */
  const list = computed<EntityHue[]>(() =>
    orderedIds.value
      .map((n) => byName.value.get(n))
      .filter((h): h is EntityHue => Boolean(h)),
  );

  function hueFor(name: string): string {
    return byName.value.get(name)?.hue ?? ENTITY_PALETTE[0];
  }

  return { byName, list, hueFor, syncToIds };
}
