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
 * Selected instance for the per-layer page. Backed by the
 * `layerSelection` Pinia store — URL hydrates on entry, store
 * holds the live value, URL stays frozen. See
 * `state/layerSelection.ts` for the contract.
 */

import { computed } from 'vue';
import { useLayerSelectionStore } from '@/state/layerSelection';

export function useSelectedInstance() {
  const store = useLayerSelectionStore();

  const selectedInstance = computed<string | null>(() => store.instance);

  function setSelectedInstance(name: string | null): void {
    store.setInstance(name);
  }

  // Multi-entity lock (instance scope). The locked set is CROSS-SERVICE
  // compound keys; `isInstanceLocked` checks `name` under the current
  // primary service via the store (compound-aware).
  const lockedInstanceNames = computed<string[]>(() => store.activeCompareSet('instance'));
  function toggleLockInstance(name: string): void {
    store.toggleLock('instance', name);
  }
  function isInstanceLocked(name: string): boolean {
    return store.isLocked('instance', name);
  }

  return {
    selectedInstance,
    setSelectedInstance,
    lockedInstanceNames,
    toggleLockInstance,
    isInstanceLocked,
  };
}
