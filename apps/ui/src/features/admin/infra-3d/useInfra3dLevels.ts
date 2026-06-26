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
 * Tier (level) editing + layer→level resolution for the 3D-map admin.
 *
 * Level membership is edited in ONE place — the Levels section's member
 * chips. The Layers section only DISPLAYS where each layer lands, using
 * the same resolution order the BFF applies (see useInfra3dConfig): global
 * filter → group membership → explicit list → unknownLayer fallback. Both
 * surfaces share `resolveLevel` here so they never drift into the old
 * "edit the same array twice" redundancy.
 *
 * Bound to the editor `draft`; every mutation writes through it.
 */

import { computed, type ComputedRef, type Ref } from 'vue';
import type { Infra3dConfig, InfraLevelSpec } from '@/api/client';

export type LevelVia = 'group' | 'explicit' | 'default' | 'filtered';

export interface ResolvedLevel {
  levelId: string | null;
  via: LevelVia;
}

/** Compile that never throws — a half-typed regex in an input just stops
 *  matching rather than blowing up the page. */
export function safeRegex(src: string): RegExp | null {
  try {
    return new RegExp(src);
  } catch {
    return null;
  }
}

export function useInfra3dLevels(draft: Ref<Infra3dConfig | null>): {
  levelsSorted: ComputedRef<InfraLevelSpec[]>;
  addLevel: () => void;
  removeLevel: (id: string) => void;
  moveLevel: (idx: number, delta: number) => void;
  resolveLevel: (key: string) => ResolvedLevel;
  levelLabel: (levelId: string | null) => string;
} {
  function addLevel(): void {
    if (!draft.value) return;
    const maxOrder = Math.max(-1, ...draft.value.levels.map((l) => l.order));
    // Unique id — a length-based id collides after add-then-remove editing
    // (and a duplicate level id aliases tier buckets + fails save validation).
    const taken = new Set(draft.value.levels.map((l) => l.id));
    let n = draft.value.levels.length + 1;
    let id = `level-${n}`;
    while (taken.has(id)) id = `level-${++n}`;
    draft.value.levels.push({ id, order: maxOrder + 1, label: 'New level', layers: [] });
  }

  function removeLevel(id: string): void {
    if (!draft.value) return;
    draft.value.levels = draft.value.levels.filter((l) => l.id !== id);
    if (draft.value.unknownLayer.level === id && draft.value.levels.length > 0) {
      draft.value.unknownLayer.level = draft.value.levels[0]!.id;
    }
  }

  const levelsSorted = computed<InfraLevelSpec[]>(() => {
    if (!draft.value) return [];
    return [...draft.value.levels].sort((a, b) => a.order - b.order);
  });

  /** `idx` is the index in `levelsSorted` (what the template renders) — NOT
   *  the unsorted `draft.levels` array, whose order can differ from the sort
   *  (bundled has mesh order 2 before middleware order 1). Swap the `order`
   *  values of the two SORTED neighbours so ↑/↓ moves the intended tier. */
  function moveLevel(idx: number, delta: number): void {
    const sorted = levelsSorted.value;
    const target = idx + delta;
    if (target < 0 || target >= sorted.length) return;
    const a = sorted[idx]!;
    const b = sorted[target]!;
    const ao = a.order;
    a.order = b.order;
    b.order = ao;
  }

  /** Mirror the BFF's layer→level resolution: global filter → group
   *  membership → explicit list → unknownLayer fallback. Returns HOW it
   *  resolved so the unpinned rows can flag fallback / filtered layers the
   *  operator didn't pin by hand. */
  function resolveLevel(key: string): ResolvedLevel {
    if (!draft.value) return { levelId: null, via: 'default' };
    const u = key.toUpperCase();
    const gf = safeRegex(draft.value.filter.layer);
    if (gf && !gf.test(u)) return { levelId: null, via: 'filtered' };
    for (const g of draft.value.groups ?? []) {
      if (g.layers.some((k) => k.toUpperCase() === u)) return { levelId: g.level, via: 'group' };
    }
    for (const lvl of draft.value.levels) {
      if (lvl.layers.some((k) => k.toUpperCase() === u)) return { levelId: lvl.id, via: 'explicit' };
    }
    return { levelId: draft.value.unknownLayer.level, via: 'default' };
  }

  function levelLabel(levelId: string | null): string {
    if (!levelId) return '—';
    return draft.value?.levels.find((l) => l.id === levelId)?.label ?? levelId;
  }

  return { levelsSorted, addLevel, removeLevel, moveLevel, resolveLevel, levelLabel };
}
