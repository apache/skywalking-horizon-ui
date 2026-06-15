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
 * Selected endpoint for the per-layer page. Backed by the
 * `layerSelection` Pinia store — URL hydrates on entry, store
 * holds the live value, URL stays frozen. See
 * `state/layerSelection.ts` for the contract.
 */

import { computed } from 'vue';
import { useLayerSelectionStore } from '@/state/layerSelection';

export function useSelectedEndpoint() {
  const store = useLayerSelectionStore();

  const selectedEndpoint = computed<string | null>(() => store.endpoint);

  function setSelectedEndpoint(name: string | null): void {
    store.setEndpoint(name);
  }

  // Multi-entity lock (endpoint scope). Locked set is CROSS-SERVICE
  // compound keys; `isEndpointLocked` checks `name` under the current
  // primary service via the store (compound-aware).
  const lockedEndpointNames = computed<string[]>(() => store.activeCompareSet('endpoint'));
  function toggleLockEndpoint(name: string): void {
    store.toggleLock('endpoint', name);
  }
  function isEndpointLocked(name: string): boolean {
    return store.isLocked('endpoint', name);
  }

  return {
    selectedEndpoint,
    setSelectedEndpoint,
    lockedEndpointNames,
    toggleLockEndpoint,
    isEndpointLocked,
  };
}
