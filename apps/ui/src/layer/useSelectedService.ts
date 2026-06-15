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
 * Selected service for the per-layer page. Backed by the
 * `layerSelection` Pinia store, which is seeded from the URL on
 * landing and updated in-memory afterwards. The URL is a
 * shareable starting point, not a live state mirror — see
 * `state/layerSelection.ts` for the contract.
 */

import { computed } from 'vue';
import { useLayerSelectionStore } from '@/state/layerSelection';

export function useSelectedService() {
  const store = useLayerSelectionStore();

  const selectedId = computed<string | null>(() => store.service);

  function setSelected(id: string | null, opts: { keepNarrower?: boolean } = {}): void {
    store.setService(id, opts);
  }

  // Multi-entity lock (service scope).
  const lockedServiceIds = computed<string[]>(() => store.activeCompareSet('service'));
  function toggleLockService(id: string): void {
    store.toggleLock('service', id);
  }

  return { selectedId, setSelected, lockedServiceIds, toggleLockService };
}
