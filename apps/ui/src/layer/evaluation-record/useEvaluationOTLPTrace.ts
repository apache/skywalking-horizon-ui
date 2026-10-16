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
import type { TraceQLTraceDetailResponse, ZipkinTraceDetailResponse } from '@skywalking-horizon-ui/api-client';
import { bffClient } from '@/api/client';
import { errorText } from '@/api/permissionDenied';

export type EvaluationTraceWindow = { startMs: number; endMs: number };
type EvaluationOTLPTrace =
  | { source: 'otlp'; detail: TraceQLTraceDetailResponse }
  | { source: 'zipkin'; detail: ZipkinTraceDetailResponse };

/** An OTLP trace reference describes span addressing, not the storage mode.
 * Prefer original OTLP; only an absent/disabled source or a confirmed miss
 * permits the legacy Zipkin lookup. An outage must remain visible. */
export async function readEvaluationOTLPTrace(
  traceId: string,
  window: EvaluationTraceWindow | null,
  signal?: AbortSignal,
): Promise<EvaluationOTLPTrace> {
  const sources = await bffClient.traceql.sources(signal);
  const otlp = sources.find((source) => source.ds === 'otlp');
  if (!otlp) throw new Error('OTLP trace source status is missing.');
  if (otlp.configured && otlp.served !== false) {
    const detail = await bffClient.traceql.trace('otlp', traceId, window ?? undefined, signal);
    if (!detail.reachable || !detail.notFound) return { source: 'otlp', detail };
  }
  if (signal?.aborted) throw signal.reason;
  const detail = await bffClient.zipkin.trace(traceId, window
    ? { endTs: window.endMs, lookback: window.endMs - window.startMs }
    : { endTs: null, lookback: null });
  return { source: 'zipkin', detail };
}

export function useEvaluationOTLPTrace(traceId: Ref<string | null>, window: Ref<EvaluationTraceWindow | null>) {
  const q = useQuery({
    queryKey: computed(() => ['evaluation-otlp-trace', traceId.value, window.value?.startMs ?? null, window.value?.endMs ?? null]),
    enabled: computed(() => !!traceId.value),
    queryFn: ({ signal }) => readEvaluationOTLPTrace(traceId.value!, window.value, signal),
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const data = computed(() => q.data.value ?? null);
  const otlpSpans = computed(() => data.value?.source === 'otlp' ? data.value.detail.spans : []);
  const zipkinSpans = computed(() => data.value?.source === 'zipkin' ? data.value.detail.spans : []);
  const failure = computed(() => {
    if (q.error.value) return errorText(q.error.value);
    const detail = data.value?.detail;
    return detail && !detail.reachable && !detail.notFound ? (detail.error || 'Backend unreachable.') : null;
  });
  return { data, otlpSpans, zipkinSpans, failure, isFetching: q.isFetching, refetch: q.refetch };
}
