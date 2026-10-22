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

/** URL-backed popout state for Zipkin traces: `?traceId=` with
 *  `?traceType=zipkin`. */

import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { clearTraceAddress, traceStoreOf, withTraceFocus } from './tracePopoutQuery';

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
  const openTraceId = computed<string | null>(() => {
    const v = route.query.traceId;
    return typeof v === 'string' && v.length > 0 && traceStoreOf(route.query) === 'zipkin' ? v : null;
  });
  const openTraceWindow = computed(() => (openTraceId.value ? zipkinPopoutWindow(route.query as Record<string, unknown>) : null));

  /** Open a trace; `window` is the list window it was pasted or picked
   *  in, `at` the moment a row gave — either bounds the lookup. */
  function openTrace(id: string, options?: ZipkinTraceOpenOptions): void {
    if (!id) return;
    const next = withTraceFocus({ ...clearTraceAddress(route.query), traceId: id, traceType: 'zipkin' }, options);
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
    void router.replace({ path: route.path, query: clearTraceAddress(route.query) });
  }

  return { openTraceId, openTraceWindow, openTrace, closeTrace };
}
