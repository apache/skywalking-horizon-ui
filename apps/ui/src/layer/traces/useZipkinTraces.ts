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
 * Zipkin trace composables. Two queries:
 *   1. `useZipkinTraces({...})` — list of `ZipkinTraceListRow` summaries
 *      with the standard Zipkin v2 query params (serviceName / spanName
 *      / minDuration / lookback / endTs / limit).
 *   2. `useZipkinTrace(traceId)` — full span tree for one trace.
 *
 * Both call through `bffClient.zipkin*` which proxies OAP's
 * `ZipkinQueryHandler`. The composables stay deliberately thin — the
 * BFF route already curates the list shape, so the SPA just renders.
 */

import { computed, type Ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type {
  ZipkinTraceDetailResponse,
  ZipkinTraceListResponse,
} from '@skywalking-horizon-ui/api-client';
import { bffClient, type ZipkinTraceQuery } from '@/api/client';

export interface ZipkinTracesParams {
  serviceName: Ref<string | null>;
  remoteServiceName?: Ref<string | null>;
  spanName?: Ref<string | null>;
  minDuration?: Ref<number | null>;
  maxDuration?: Ref<number | null>;
  /** Window end in ms since epoch. null = "now". */
  endTs?: Ref<number | null>;
  /** Window size in ms. */
  lookback: Ref<number>;
  limit: Ref<number>;
  annotationQuery?: Ref<string | null>;
  /** Run only when the user has clicked Run query — mirrors the native
   *  trace tab's "explicit fetch" model. */
  enabled?: Ref<boolean>;
  /** REPLAY mode: the captured list (with inline spans) to render from. When
   *  present the query NEVER fetches — a reloaded conversation replays the exact
   *  data with zero OAP round-trip and survives an offline OAP. */
  replayData?: Ref<ZipkinTraceListResponse | null>;
}

export function useLayerZipkinTraces(params: ZipkinTracesParams) {
  // Replay is on whenever captured data is supplied.
  const replay = computed(() => !!params.replayData?.value);
  // Zipkin allows "all services" — a blank serviceName queries every
  // local endpoint. Only gate on the operator's explicit `enabled`
  // flag (Run query click), not on serviceName presence. Replay is static:
  // never fetch (data comes from replayData below).
  const enabled = computed(() => (params.enabled ? params.enabled.value : true) && !replay.value);
  const q = useQuery<ZipkinTraceListResponse>({
    queryKey: [
      'zipkin-traces',
      params.serviceName,
      params.remoteServiceName ?? computed(() => null),
      params.spanName ?? computed(() => null),
      params.minDuration ?? computed(() => null),
      params.maxDuration ?? computed(() => null),
      params.endTs ?? computed(() => null),
      params.lookback,
      params.limit,
      params.annotationQuery ?? computed(() => null),
    ],
    queryFn: () => {
      const body: ZipkinTraceQuery = {
        ...(params.serviceName.value ? { serviceName: params.serviceName.value } : {}),
        ...(params.remoteServiceName?.value ? { remoteServiceName: params.remoteServiceName.value } : {}),
        ...(params.spanName?.value ? { spanName: params.spanName.value } : {}),
        ...(params.minDuration?.value ? { minDuration: params.minDuration.value } : {}),
        ...(params.maxDuration?.value ? { maxDuration: params.maxDuration.value } : {}),
        ...(params.endTs?.value ? { endTs: params.endTs.value } : {}),
        ...(params.annotationQuery?.value ? { annotationQuery: params.annotationQuery.value } : {}),
        lookback: params.lookback.value,
        limit: params.limit.value,
      };
      return bffClient.zipkin.traces(body);
    },
    enabled,
    staleTime: 15_000,
  });
  // Replay renders straight from the captured payload — NOT through the shared
  // query cache. Seeding initialData under the live query key would let a chat
  // snapshot serve a live view during staleTime (and vice-versa).
  const data = computed(() => (replay.value ? (params.replayData?.value ?? null) : (q.data.value ?? null)));
  // A read fails two ways: the request itself (live only) or a `reachable:false`
  // payload. Both are derived from whichever payload is in play, so a captured
  // failure replays as a failure instead of an innocent empty window.
  const reachable = computed<boolean>(() => data.value?.reachable ?? true);
  const error = computed<string | null>(() => {
    if (!replay.value && q.error.value) return String(q.error.value);
    return data.value && !data.value.reachable ? (data.value.error ?? null) : null;
  });
  return {
    data,
    traces: computed(() => data.value?.traces ?? []),
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    reachable,
    error,
    refetch: q.refetch,
  };
}

export function useZipkinTrace(traceId: Ref<string | null>, replay?: Ref<boolean>) {
  const q = useQuery<ZipkinTraceDetailResponse>({
    queryKey: ['zipkin-trace', traceId],
    queryFn: () => bffClient.zipkin.trace(traceId.value!),
    // Replay rows carry their spans inline, so the by-id fallback never fires.
    enabled: computed(() => Boolean(traceId.value) && !replay?.value),
    staleTime: 60_000,
  });
  return {
    data: computed(() => q.data.value ?? null),
    spans: computed(() => q.data.value?.spans ?? []),
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    error: q.error,
  };
}
