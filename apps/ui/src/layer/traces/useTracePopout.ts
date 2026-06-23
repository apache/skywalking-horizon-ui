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
 * Global trace-id popout coordinator.
 *
 * Any place in the app that knows a SkyWalking trace id (refs in a
 * span detail, a log row's traceId, an alarm payload, …) can call
 * `openTrace(id)` to open a centered modal showing that trace's
 * waterfall. The state is round-tripped through the URL as
 * `?openTraceId=<id>` so links + back/forward + share-URL all work
 * without an extra session store.
 *
 * The popout component itself lives at `components/trace/TracePopout.vue`
 * and is mounted once globally inside `AppShell.vue`. It listens to
 * the same query param and fetches the trace via `useTraceDetail`.
 */

import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useTraceSourceIsZipkin } from './useZipkinTracePopout';

/** Query-string keys. Any URL with TRACE_POPOUT_QUERY auto-opens the
 *  trace popout — shareable. TRACE_POPOUT_AT carries the trace's
 *  approximate timestamp (epoch ms) so the popout can widen the
 *  BanyanDB lookup window — needed for trace IDs older than the
 *  default 1-day `queryTrace` search (most often: clicking a trace
 *  link on a 12d-old log row with the Cold pill on). Callers without
 *  a timestamp hint (paste-the-ID-in-the-URL flows) omit it; the
 *  popout falls back to the default 1-day search. */
export const TRACE_POPOUT_QUERY = 'traceId';
export const TRACE_POPOUT_AT = 'traceAt';

export function useTracePopout() {
  const route = useRoute();
  const router = useRouter();

  const sourceIsZipkin = useTraceSourceIsZipkin();
  const openTraceId = computed<string | null>(() => {
    const v = route.query[TRACE_POPOUT_QUERY];
    return typeof v === 'string' && v.length > 0 && !sourceIsZipkin.value ? v : null;
  });
  const openTraceAtMs = computed<number | null>(() => {
    const v = route.query[TRACE_POPOUT_AT];
    if (typeof v !== 'string') return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  });

  function openTrace(id: string, atMs?: number): void {
    if (!id) return;
    const next: Record<string, string | (string | null)[] | null | undefined> = {
      ...route.query,
      [TRACE_POPOUT_QUERY]: id,
    };
    if (typeof atMs === 'number' && Number.isFinite(atMs) && atMs > 0) {
      next[TRACE_POPOUT_AT] = String(atMs);
    } else {
      delete next[TRACE_POPOUT_AT];
    }
    void router.push({ path: route.path, query: next });
  }

  function closeTrace(): void {
    const q = { ...route.query };
    delete q[TRACE_POPOUT_QUERY];
    delete q[TRACE_POPOUT_AT];
    void router.replace({ path: route.path, query: q });
  }

  return { openTraceId, openTraceAtMs, openTrace, closeTrace };
}
