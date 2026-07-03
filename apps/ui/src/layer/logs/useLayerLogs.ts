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
import type { LogFacetsResponse, LogsResponse, LogTagFilter } from '@/api/client';

export interface LogListParams {
  service: Ref<string | null>;
  instanceId: Ref<string | null>;
  endpointId: Ref<string | null>;
  traceId: Ref<string | null>;
  keywords: Ref<string[]>;
  tags: Ref<LogTagFilter[]>;
  page: Ref<number>;
  pageSize: Ref<number>;
  windowMinutes?: Ref<number>;
  startMs?: Ref<number | null>;
  endMs?: Ref<number | null>;
  /** Gate the query — when false it never runs. Manual-fire pages hold it
   *  until the operator presses Run query. Defaults to always-on. */
  enabled?: Ref<boolean>;
}

export function useLayerLogs(layerKey: Ref<string>, params: LogListParams) {
  const q = useQuery<LogsResponse>({
    queryKey: [
      'layer-logs',
      layerKey,
      params.service,
      params.instanceId,
      params.endpointId,
      params.traceId,
      params.keywords,
      params.tags,
      params.page,
      params.pageSize,
      params.windowMinutes ?? computed(() => 0),
      params.startMs ?? computed(() => null),
      params.endMs ?? computed(() => null),
    ],
    queryFn: () =>
      bffClient.log.list(layerKey.value, {
        ...(params.service.value ? { service: params.service.value } : {}),
        ...(params.instanceId.value ? { serviceInstanceId: params.instanceId.value } : {}),
        ...(params.endpointId.value ? { endpointId: params.endpointId.value } : {}),
        ...(params.traceId.value ? { traceId: params.traceId.value } : {}),
        ...(params.keywords.value.length > 0 ? { keywordsOfContent: params.keywords.value } : {}),
        ...(params.tags.value.length > 0 ? { tags: params.tags.value } : {}),
        ...(params.windowMinutes?.value ? { windowMinutes: params.windowMinutes.value } : {}),
        ...(params.startMs?.value && params.endMs?.value
          ? { startMs: params.startMs.value, endMs: params.endMs.value }
          : {}),
        page: params.page.value,
        pageSize: params.pageSize.value,
      }),
    enabled: computed(() => layerKey.value.length > 0 && (params.enabled ? params.enabled.value : true)),
    staleTime: 15_000,
  });

  return {
    data: computed(() => q.data.value ?? null),
    logs: computed(() => q.data.value?.logs ?? []),
    total: computed(() => q.data.value?.total ?? 0),
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    error: q.error,
    refetch: q.refetch,
  };
}

/**
 * Window-scoped facets (level + service breakdown). Separate query so
 * level toggles can update the row list without re-running the bigger
 * facet sample. Keys intentionally omit `tags` + `page` + `pageSize`
 * since facets are unfiltered + always sampled from page 1.
 */
export interface LogFacetParams {
  service: Ref<string | null>;
  instanceId: Ref<string | null>;
  endpointId: Ref<string | null>;
  traceId: Ref<string | null>;
  keywords: Ref<string[]>;
  windowMinutes?: Ref<number>;
  startMs?: Ref<number | null>;
  endMs?: Ref<number | null>;
  enabled?: Ref<boolean>;
}

export function useLayerLogFacets(layerKey: Ref<string>, params: LogFacetParams) {
  const q = useQuery<LogFacetsResponse>({
    queryKey: [
      'layer-log-facets',
      layerKey,
      params.service,
      params.instanceId,
      params.endpointId,
      params.traceId,
      params.keywords,
      params.windowMinutes ?? computed(() => 0),
      params.startMs ?? computed(() => null),
      params.endMs ?? computed(() => null),
    ],
    queryFn: () =>
      bffClient.log.facets(layerKey.value, {
        ...(params.service.value ? { service: params.service.value } : {}),
        ...(params.instanceId.value ? { serviceInstanceId: params.instanceId.value } : {}),
        ...(params.endpointId.value ? { endpointId: params.endpointId.value } : {}),
        ...(params.traceId.value ? { traceId: params.traceId.value } : {}),
        ...(params.keywords.value.length > 0 ? { keywordsOfContent: params.keywords.value } : {}),
        ...(params.windowMinutes?.value ? { windowMinutes: params.windowMinutes.value } : {}),
        ...(params.startMs?.value && params.endMs?.value
          ? { startMs: params.startMs.value, endMs: params.endMs.value }
          : {}),
        sampleSize: 200,
      }),
    enabled: computed(() => layerKey.value.length > 0 && (params.enabled ? params.enabled.value : true)),
    staleTime: 30_000,
  });
  return {
    facets: computed(() => q.data.value ?? null),
    isFetching: q.isFetching,
    error: q.error,
    refetch: q.refetch,
  };
}

// Log tag autocomplete uses OAP's native `queryLogTagAutocomplete`
// endpoints (mirrors booster-ui's ConditionTags) via the BFF helpers
// `bffClient.log.tagKeys()` + `bffClient.log.tagValues(key)`. Called
// directly from `LayerLogsView` — no composable needed since they're
// one-shot fetches keyed by the window + (optionally) the typed key.
