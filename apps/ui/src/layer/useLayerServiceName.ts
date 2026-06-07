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

import { computed, type ComputedRef, type Ref } from 'vue';
import { useSelectedService } from './useSelectedService';
import { useLayerServices } from './useLayerServices';
import type { useLayerLanding } from './useLayerLanding';

/**
 * Resolve the selected service's NAME for a layer tab — sample first,
 * then the full roster.
 *
 * The landing rollup only carries the metric-probed sample (the top
 * `query.landingServiceCap` services), so a service picked from the long
 * tail of a big layer — or arriving via a deep link — is NOT in
 * `sampledRows`. Resolving names from the sample alone returns `null` for
 * those, which silently breaks the tab's per-service query (logs/traces
 * fire with no service; endpoint-dependency never enables). We look in
 * the sample first (already loaded), then fall back to the full roster
 * (`useLayerServices`), so EVERY selectable service yields a name. `null`
 * only when the id is in neither (genuinely unknown / not yet loaded).
 *
 * This is the single source of truth for service-name resolution across
 * every per-layer tab. Keep the lookup here — re-inlining it is exactly
 * how tabs drifted into sample-only lookups that drop tail selections.
 */
export function useLayerServiceName(
  layerKey: Ref<string>,
  landing: ReturnType<typeof useLayerLanding>,
): ComputedRef<string | null> {
  const { selectedId } = useSelectedService();
  const { services: roster } = useLayerServices(layerKey);
  return computed<string | null>(() => {
    const rows = landing.data.value?.sampledRows ?? landing.rows.value ?? [];
    const match = rows.find((r) => r.serviceId === selectedId.value);
    if (match) return match.serviceName;
    const fromRoster = roster.value.find((s) => s.id === selectedId.value);
    return fromRoster?.name ?? null;
  });
}
