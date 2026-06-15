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

import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useLayerSelectionStore, MAX_LOCKED, compoundKey, splitCompound } from './layerSelection';

describe('layerSelection — multi-entity lock', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('compoundKey / splitCompound round-trip', () => {
    const k = compoundKey('svcA', 'inst-1');
    expect(splitCompound(k)).toEqual({ service: 'svcA', name: 'inst-1' });
    // a plain (non-compound) key decodes to name-only
    expect(splitCompound('plain')).toEqual({ service: '', name: 'plain' });
  });

  it('toggleLock adds then removes a service', () => {
    const s = useLayerSelectionStore();
    s.toggleLock('service', 'a');
    expect(s.activeCompareSet('service')).toEqual(['a']);
    s.toggleLock('service', 'a');
    expect(s.activeCompareSet('service')).toEqual([]);
  });

  it('caps each set at MAX_LOCKED — the 7th lock is a no-op', () => {
    const s = useLayerSelectionStore();
    for (let i = 1; i <= MAX_LOCKED + 1; i += 1) s.toggleLock('service', `svc${i}`);
    expect(s.activeCompareSet('service')).toHaveLength(MAX_LOCKED);
    expect(s.activeCompareSet('service')).not.toContain(`svc${MAX_LOCKED + 1}`);
  });

  it('service / instance / endpoint sets are independent', () => {
    const s = useLayerSelectionStore();
    s.setService('svc1');
    s.toggleLock('service', 'svcA');
    s.toggleLock('instance', 'i1');
    s.toggleLock('endpoint', 'e1');
    expect(s.activeCompareSet('service')).toEqual(['svcA']);
    expect(s.activeCompareSet('instance')).toEqual([compoundKey('svc1', 'i1')]);
    expect(s.activeCompareSet('endpoint')).toEqual([compoundKey('svc1', 'e1')]);
  });

  it('instance pins are CROSS-SERVICE — different services kept together, never dropped on switch', () => {
    const s = useLayerSelectionStore();
    s.setService('svc1');
    s.toggleLock('instance', 'i1');
    s.setService('svc2'); // switch primary — must NOT drop svc1's pin
    s.toggleLock('instance', 'i2');
    expect(s.activeCompareSet('instance')).toEqual([
      compoundKey('svc1', 'i1'),
      compoundKey('svc2', 'i2'),
    ]);
    s.setService('svc1'); // switch back — still both
    expect(s.activeCompareSet('instance')).toEqual([
      compoundKey('svc1', 'i1'),
      compoundKey('svc2', 'i2'),
    ]);
  });

  it('isLocked is compound-aware — a pin shows locked only under its OWN service', () => {
    const s = useLayerSelectionStore();
    s.setService('svc1');
    s.toggleLock('instance', 'i1');
    expect(s.isLocked('instance', 'i1')).toBe(true);
    s.setService('svc2');
    // i1 belongs to svc1 — not "locked" relative to svc2's row list
    expect(s.isLocked('instance', 'i1')).toBe(false);
  });

  it('removeKey removes an exact compound key regardless of current service', () => {
    const s = useLayerSelectionStore();
    s.setService('svc1');
    s.toggleLock('instance', 'i1');
    s.setService('svc2');
    s.toggleLock('instance', 'i2');
    // unlock svc1's pin while the primary is svc2 (cohort chip ×)
    s.removeKey('instance', compoundKey('svc1', 'i1'));
    expect(s.activeCompareSet('instance')).toEqual([compoundKey('svc2', 'i2')]);
  });

  it('activeCompareSet is empty for instance/endpoint when no primary', () => {
    const s = useLayerSelectionStore();
    expect(s.activeCompareSet('service')).toEqual([]);
    expect(s.activeCompareSet('instance')).toEqual([]);
    expect(s.activeCompareSet('endpoint')).toEqual([]);
  });

  it('clear() wipes every lock list', () => {
    const s = useLayerSelectionStore();
    s.setService('svc1');
    s.toggleLock('service', 'svcA');
    s.toggleLock('instance', 'i1');
    s.toggleLock('endpoint', 'e1');
    s.clear();
    expect(s.lockedServices).toEqual([]);
    expect(s.lockedInstances).toEqual([]);
    expect(s.lockedEndpoints).toEqual([]);
  });

  it('keepNarrower preserves the instance pick across a service switch', () => {
    const s = useLayerSelectionStore();
    s.setService('svc1');
    s.setInstance('i1');
    s.setService('svc2', { keepNarrower: true });
    expect(s.instance).toBe('i1');
    s.setService('svc3');
    expect(s.instance).toBe(null);
  });
});
