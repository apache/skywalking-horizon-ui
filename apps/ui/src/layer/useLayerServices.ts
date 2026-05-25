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
 * Reactive full-service-roster lookup for a layer. Backs the layer
 * shell's URL-service validator — when a deep link or hierarchy peer
 * click arrives with `?service=<id>`, the shell checks the id against
 * this roster (the layer's REAL service list, independent of
 * landing's top-N rollup which can miss low-traffic services). A
 * missing id pops the "service not found" notice; a present id is
 * trusted regardless of landing visibility.
 */

import { computed, type Ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { bffClient } from '@/api/client';

export interface LayerServiceRow {
  id: string;
  name: string;
  normal: boolean | null;
}

export function useLayerServices(layerKey: Ref<string>) {
  const q = useQuery({
    queryKey: ['layer-services', layerKey],
    queryFn: () => bffClient.layer.services(layerKey.value),
    enabled: computed(() => layerKey.value.length > 0),
    // The BFF caches the catalog snapshot for 60s server-side. Match
    // that here so the UI doesn't re-fire on every layer entry.
    staleTime: 60_000,
  });
  return {
    data: computed(() => q.data.value ?? null),
    services: computed<LayerServiceRow[]>(() => q.data.value?.services ?? []),
    isLoading: q.isLoading,
    isFetching: q.isFetching,
  };
}
