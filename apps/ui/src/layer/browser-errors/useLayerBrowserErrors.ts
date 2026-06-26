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

import { computed, type Ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { bffClient } from '@/api/client';
import type { BrowserErrorCategory, BrowserErrorsResponse } from '@/api/client';

export interface BrowserErrorParams {
  service: Ref<string | null>;
  /** OAP serviceVersionId — the BROWSER "Version" (instance) filter. */
  serviceVersionId?: Ref<string>;
  /** OAP pagePathId — the BROWSER "Page" (endpoint) filter. */
  pagePathId?: Ref<string>;
  category: Ref<BrowserErrorCategory>;
  page: Ref<number>;
  pageSize: Ref<number>;
  /** Rolling window in minutes (ignored when an explicit start/end pair is
   *  supplied). Own to this triage page — the global ticker is paused here. */
  windowMinutes: Ref<number>;
  /** Explicit absolute range as epoch MS; when both set they win over
   *  `windowMinutes`. The BFF applies the OAP timezone offset. */
  startMs?: Ref<number | null>;
  endMs?: Ref<number | null>;
  /** Gate the query — when false it never runs. Manual-fire holds it until
   *  the operator presses Run query. Defaults to always-on. */
  enabled?: Ref<boolean>;
}

export function useLayerBrowserErrors(layerKey: Ref<string>, params: BrowserErrorParams) {
  const q = useQuery<BrowserErrorsResponse>({
    queryKey: [
      'layer-browser-errors',
      layerKey,
      params.service,
      params.serviceVersionId ?? computed(() => ''),
      params.pagePathId ?? computed(() => ''),
      params.category,
      params.page,
      params.pageSize,
      params.windowMinutes,
      params.startMs ?? computed(() => null),
      params.endMs ?? computed(() => null),
    ],
    queryFn: () =>
      bffClient.browserErrors.list(layerKey.value, {
        ...(params.service.value ? { service: params.service.value } : {}),
        ...(params.serviceVersionId?.value ? { serviceVersionId: params.serviceVersionId.value } : {}),
        ...(params.pagePathId?.value ? { pagePathId: params.pagePathId.value } : {}),
        ...(params.category.value && params.category.value !== 'ALL'
          ? { category: params.category.value }
          : {}),
        ...(params.startMs?.value && params.endMs?.value
          ? { startMs: params.startMs.value, endMs: params.endMs.value }
          : params.windowMinutes.value
            ? { windowMinutes: params.windowMinutes.value }
            : {}),
        page: params.page.value,
        pageSize: params.pageSize.value,
      }),
    enabled: computed(() => layerKey.value.length > 0 && (params.enabled ? params.enabled.value : true)),
    staleTime: 15_000,
  });
  // No auto-refresh subscription: this is a triage page that owns its time
  // range, and the topbar suspends the global ticker for it ("Paused").

  return {
    data: computed(() => q.data.value ?? null),
    logs: computed(() => q.data.value?.logs ?? []),
    total: computed(() => q.data.value?.total ?? 0),
    reachable: computed(() => q.data.value?.reachable ?? true),
    queryError: computed(() => q.data.value?.error ?? null),
    isFetching: q.isFetching,
    error: q.error,
    refetch: q.refetch,
  };
}
