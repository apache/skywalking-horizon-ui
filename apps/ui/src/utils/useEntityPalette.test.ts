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

import { describe, expect, it } from 'vitest';
import { ENTITY_PALETTE } from './metricColor';
import { useEntityPalette } from './useEntityPalette';
import { MAX_LOCKED } from '../state/layerSelection';

describe('useEntityPalette — stable id-keyed slots', () => {
  it('assigns slots 0..n for a fresh set', () => {
    const p = useEntityPalette();
    p.syncToIds(['a', 'b', 'c']);
    expect(p.byName.value.get('a')?.slot).toBe(0);
    expect(p.byName.value.get('b')?.slot).toBe(1);
    expect(p.byName.value.get('c')?.slot).toBe(2);
    expect(p.hueFor('a')).toBe(ENTITY_PALETTE[0]);
    expect(p.hueFor('c')).toBe(ENTITY_PALETTE[2]);
  });

  it('keeps survivors on their slot when the middle entity is removed', () => {
    const p = useEntityPalette();
    p.syncToIds(['a', 'b', 'c']);
    p.syncToIds(['a', 'c']);
    expect(p.byName.value.get('a')?.slot).toBe(0);
    expect(p.byName.value.get('c')?.slot).toBe(2);
    expect(p.byName.value.has('b')).toBe(false);
  });

  it('reuses the lowest freed slot for a new entity', () => {
    const p = useEntityPalette();
    p.syncToIds(['a', 'b', 'c']);
    p.syncToIds(['a', 'c']); // frees slot 1
    p.syncToIds(['a', 'c', 'd']);
    expect(p.byName.value.get('d')?.slot).toBe(1);
  });

  it('is idempotent for an unchanged set', () => {
    const p = useEntityPalette();
    p.syncToIds(['a', 'b', 'c']);
    const before = p.byName.value.get('b')?.slot;
    p.syncToIds(['a', 'b', 'c']);
    expect(p.byName.value.get('b')?.slot).toBe(before);
  });

  it('list follows lock order, not slot order', () => {
    const p = useEntityPalette();
    p.syncToIds(['a', 'b', 'c']);
    p.syncToIds(['c', 'a']); // c keeps slot 2, a keeps slot 0
    expect(p.list.value.map((h) => h.name)).toEqual(['c', 'a']);
    expect(p.list.value.map((h) => h.slot)).toEqual([2, 0]);
  });

  it('palette length equals the lock cap', () => {
    expect(ENTITY_PALETTE.length).toBe(6);
    expect(ENTITY_PALETTE.length).toBe(MAX_LOCKED);
  });

  it('palette is the historic SECONDARY hues (byte-identical)', () => {
    expect([...ENTITY_PALETTE]).toEqual([
      '#60a5fa',
      '#a78bfa',
      '#22d3ee',
      '#f472b6',
      '#34d399',
      '#fbbf24',
    ]);
  });
});
