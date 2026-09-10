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

/** URL-backed popout state for Zipkin traces, sharing the native
 *  popout's `?traceId=` param. */

import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useLayers } from '@/shell/useLayers';
import { withTraceFocus, clearTraceFocus } from './tracePopoutQuery';

// Native vs Zipkin keys on the trace source, not the ID shape — native IDs
// can be bare hex, same as Zipkin. An explicit `?source=` (written by the
// shareable-URL copy) wins; otherwise the layer's route decides. Trace
// inspect serves both sources from one route, so it relies on `?source=`.
export function useTraceSourceIsZipkin() {
  const route = useRoute();
  const { layers } = useLayers();
  return computed<boolean>(() => {
    if (route.query.traceType === 'OTLP') return true;
    if (route.query.traceType === 'SKYWALKING_NATIVE') return false;
    const src = route.query.source;
    if (src === 'zipkin') return true;
    if (src === 'native') return false;
    if (/\/zipkin-trace(\/|$|\?)/.test(route.path)) return true;
    const key = String(route.params.layerKey ?? '');
    return (layers.value.find((l) => l.key === key)?.traces?.source ?? 'native') === 'zipkin';
  });
}

/** The window a popped-out Zipkin trace is looked up in, from the address:
 *  the list's window when the id was opened from one (`traceEnd` +
 *  `traceLookback`), else half a day either side of the moment a row gave
 *  (`traceAt`, as the native popout does), else nothing. With nothing and
 *  the Cold pill off, OAP looks the id up unbounded; with the pill on it
 *  searches its default day, which a cold trace is older than — so the
 *  window is what finds a cold trace at all. */
export function zipkinPopoutWindow(query: Record<string, unknown>): { endTs: number; lookback: number } | null {
  const num = (k: string): number | null => {
    const v = query[k];
    const n = typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const end = num('traceEnd');
  const lookback = num('traceLookback');
  if (end !== null && lookback !== null) return { endTs: end, lookback };
  const at = num('traceAt');
  if (at !== null) return { endTs: at + HALF_DAY_MS, lookback: 2 * HALF_DAY_MS };
  return null;
}

const HALF_DAY_MS = 12 * 60 * 60_000;

interface ZipkinTraceOpenOptions {
  endTs?: number | null;
  lookback?: number | null;
  at?: number | null;
  segmentId?: string | null;
  spanIndex?: number | null;
  spanId?: string | null;
}

export function useZipkinTracePopout() {
  const route = useRoute();
  const router = useRouter();
  const sourceIsZipkin = useTraceSourceIsZipkin();

  const openTraceId = computed<string | null>(() => {
    const v = route.query.traceId;
    return typeof v === 'string' && v.length > 0 && sourceIsZipkin.value ? v : null;
  });
  const openTraceWindow = computed(() => (openTraceId.value ? zipkinPopoutWindow(route.query as Record<string, unknown>) : null));

  /** Open a trace; `window` is the list window it was pasted or picked
   *  in, `at` the moment a row gave — either bounds the lookup. */
  function openTrace(id: string, options?: ZipkinTraceOpenOptions): void {
    if (!id) return;
    // Force the shared trace-id popout coordinator to select the Zipkin
    // renderer even when the current layer's default source is native.
    const next = withTraceFocus({ ...route.query, traceId: id, traceType: 'OTLP' as const }, options);
    delete next.traceAt;
    delete next.traceEnd;
    delete next.traceLookback;
    const given = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    if (given(options?.lookback)) {
      next.traceEnd = String(given(options?.endTs) ? options.endTs : Date.now());
      next.traceLookback = String(options.lookback);
    } else if (given(options?.at)) {
      next.traceAt = String(options.at);
    }
    void router.replace({ path: route.path, query: next });
  }

  function closeTrace(): void {
    if (!openTraceId.value) return;
    const next = clearTraceFocus({ ...route.query });
    delete next.traceId;
    delete next.traceAt;
    delete next.traceEnd;
    delete next.traceLookback;
    if (next.traceType === 'OTLP') delete next.traceType;
    void router.replace({ path: route.path, query: next });
  }

  return { openTraceId, openTraceWindow, openTrace, closeTrace };
}
