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
 * vue-query wrappers for the per-layer Traces tab:
 *   - useLayerTraces  → POST /api/layer/:key/traces (native + zipkin)
 *   - useTraceDetail  → GET  /api/trace/:id (single source)
 */

import { computed, type Ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { usePreviewLayerBlock } from '@/controls/previewConfig';
import { bffClient } from '@/api/client';
import type {
  TraceDetailResponse,
  TraceListResponse,
  TraceQueryOrder,
  TraceQueryState,
  TraceSource,
} from '@/api/client';

export interface TraceListParams {
  source: Ref<TraceSource>;
  service: Ref<string | null>;
  instanceId: Ref<string | null>;
  endpointId: Ref<string | null>;
  traceId: Ref<string | null>;
  traceState: Ref<TraceQueryState>;
  queryOrder: Ref<TraceQueryOrder>;
  minDuration: Ref<number | null>;
  maxDuration: Ref<number | null>;
  pageNum: Ref<number>;
  pageSize: Ref<number>;
  tags: Ref<Array<{ key: string; value: string }>>;
  /** Rolling-window length in minutes — the trace tab owns its own
   *  time range rather than reading the global topbar one. */
  windowMinutes: Ref<number>;
  /** Optional explicit start/end (ISO). When both are non-empty they
   *  override `windowMinutes`. */
  customStart: Ref<string | null>;
  customEnd: Ref<string | null>;
  /** Suppress the list query when false — used by the trace tab to
   *  skip fetching while the popout is open (shareable URLs land on
   *  trace detail; no need to also pull a list page). */
  enabled?: Ref<boolean>;
}

export function useLayerTraces(layerKey: Ref<string>, params: TraceListParams) {
  // Preview-only: forward the draft `traces` block (source selector).
  const previewCfg = usePreviewLayerBlock(layerKey, 'traces');
  const q = useQuery<TraceListResponse>({
    queryKey: [
      'layer-traces',
      layerKey,
      previewCfg,
      params.source,
      params.service,
      params.instanceId,
      params.endpointId,
      params.traceId,
      params.traceState,
      params.queryOrder,
      params.minDuration,
      params.maxDuration,
      params.pageNum,
      params.pageSize,
      params.tags,
      params.windowMinutes,
      params.customStart,
      params.customEnd,
    ],
    queryFn: () =>
      bffClient.trace.list(layerKey.value, {
        source: params.source.value,
        ...(params.service.value ? { service: params.service.value } : {}),
        ...(params.instanceId.value ? { instanceId: params.instanceId.value } : {}),
        ...(params.endpointId.value ? { endpointId: params.endpointId.value } : {}),
        ...(params.traceId.value ? { traceId: params.traceId.value } : {}),
        traceState: params.traceState.value,
        queryOrder: params.queryOrder.value,
        ...(params.minDuration.value !== null ? { minTraceDuration: params.minDuration.value } : {}),
        ...(params.maxDuration.value !== null ? { maxTraceDuration: params.maxDuration.value } : {}),
        pageNum: params.pageNum.value,
        pageSize: params.pageSize.value,
        ...(params.tags.value.length > 0 ? { tags: params.tags.value } : {}),
        ...(params.customStart.value && params.customEnd.value
          ? { start: params.customStart.value, end: params.customEnd.value }
          : { windowMinutes: params.windowMinutes.value }),
        ...(previewCfg.value ? { previewConfig: previewCfg.value } : {}),
      }),
    enabled: computed(
      () => layerKey.value.length > 0 && (params.enabled ? params.enabled.value : true),
    ),
    staleTime: 15_000,
  });
  return {
    data: computed(() => q.data.value ?? null),
    native: computed(() => q.data.value?.native ?? null),
    zipkin: computed(() => q.data.value?.zipkin ?? null),
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    error: q.error,
    refetch: q.refetch,
  };
}

/** Wide search window around a timestamp hint (12 hours on either
 *  side, HOUR step). Wide enough to absorb agent clock drift and the
 *  log-record vs trace-span timing gap, narrow enough to stay inside
 *  BanyanDB's HOUR-precision cap. */
const TRACE_LOOKUP_HALF_WINDOW_MS = 12 * 60 * 60 * 1000;

export function useTraceDetail(
  traceId: Ref<string | null>,
  source: Ref<'native' | 'zipkin'>,
  /** Optional timestamp the trace is known to live near (e.g. a log
   *  row's timestamp). When present, the BFF widens the BanyanDB
   *  lookup to ±12h around it; paired with the cold-stage header,
   *  this lets cold-tier trace IDs resolve. When null, the BFF
   *  defaults to OAP's last-1-day `queryTrace` window. */
  atMs?: Ref<number | null>,
) {
  const rangeKey = computed(() => atMs?.value ?? null);
  const q = useQuery<TraceDetailResponse>({
    queryKey: ['trace-detail', traceId, source, rangeKey],
    queryFn: () => {
      const at = atMs?.value;
      const range =
        typeof at === 'number' && at > 0
          ? {
              startMs: at - TRACE_LOOKUP_HALF_WINDOW_MS,
              endMs: at + TRACE_LOOKUP_HALF_WINDOW_MS,
              step: 'HOUR' as const,
            }
          : undefined;
      return bffClient.trace.detail(traceId.value!, source.value, range);
    },
    enabled: computed(() => !!traceId.value),
    staleTime: 60_000,
  });
  return {
    data: computed(() => q.data.value ?? null),
    nativeDetail: computed(() => q.data.value?.native ?? null),
    zipkinDetail: computed(() => q.data.value?.zipkin ?? null),
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    error: q.error,
  };
}
