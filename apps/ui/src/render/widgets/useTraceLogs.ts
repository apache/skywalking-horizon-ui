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

import { computed, ref, watch, type Ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { bffClient } from '@/api/client';
import { errorText } from '@/api/permissionDenied';
import { normalizeZipkinTraceId, type TraceLogsResponse } from '@skywalking-horizon-ui/api-client';

/** Which logs to read: a trace, or one span of it — native by segment and span
 *  id, OTLP or Zipkin by hex id. The window is the trace's own span range — the
 *  BFF widens it. */
export interface TraceLogsScope {
  traceId: string;
  segmentId?: string;
  spanId?: number;
  otlpSpanId?: string;
  /** Another spelling OAP may hold the logs under — see {@link zipkinLogTraceIds}. */
  altTraceId?: string;
  startMs: number;
  endMs: number;
}

const PAGE_SIZE = 50;

/**
 * The ids a Zipkin trace's logs may be stored under: OAP's normalized form of
 * the id, and — for a 64-bit id — its zero-padded 32-character form, which OAP
 * keeps for an OTLP log when it stores OTLP traces natively. Which one a
 * deployment holds follows its storage setting, so both are offered.
 */
export function zipkinLogTraceIds(id: string): { traceId: string; altTraceId?: string } {
  const traceId = normalizeZipkinTraceId(id) ?? id;
  return traceId.length === 16 ? { traceId, altTraceId: '0'.repeat(16) + traceId } : { traceId };
}

/** One page of a trace's logs. Reads only while `scope` is set, so a view
 *  that is not showing logs costs OAP nothing; a new scope starts at page 1. */
export function useTraceLogs(scope: Ref<TraceLogsScope | null>) {
  const page = ref(1);
  /** The id the first page's lines were found by; later pages read by it. */
  const answeredBy = ref<string | null>(null);
  watch(
    () => JSON.stringify(scope.value),
    () => { page.value = 1; answeredBy.value = null; },
  );
  const q = useQuery<TraceLogsResponse>({
    queryKey: ['trace-logs', scope, page],
    queryFn: ({ signal }) => {
      const s = scope.value!;
      const p = page.value;
      return bffClient.log.forTrace(
        p > 1 ? (answeredBy.value ?? s.traceId) : s.traceId,
        {
          startMs: s.startMs,
          endMs: s.endMs,
          ...(s.segmentId ? { segmentId: s.segmentId, spanId: s.spanId } : {}),
          ...(s.otlpSpanId ? { otlpSpanId: s.otlpSpanId } : {}),
          ...(p === 1 && s.altTraceId ? { altTraceId: s.altTraceId } : {}),
          page: p,
          pageSize: PAGE_SIZE,
        },
        signal,
      );
    },
    enabled: computed(() => scope.value !== null),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const data = computed(() => q.data.value ?? null);
  // Immediate: a reopened box is handed page 1 from the cache before any read.
  watch(data, (d) => { if (d && page.value === 1) answeredBy.value = d.traceId; }, { immediate: true });
  return {
    page,
    data,
    logs: computed(() => data.value?.logs ?? []),
    hasNext: computed(() => data.value?.hasNext ?? false),
    withheld: computed(() => data.value?.withheld ?? 0),
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    error: computed<string | null>(() => {
      if (q.error.value) return errorText(q.error.value);
      return data.value && !data.value.reachable ? (data.value.error ?? '') : null;
    }),
  };
}
