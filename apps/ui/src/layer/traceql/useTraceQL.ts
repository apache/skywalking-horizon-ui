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
 * The TraceQL tab's data.
 *
 * A query runs from the Run button and from nothing else — not on mount, not
 * on a keystroke, not on the refresh ticker. The expression is the operator's
 * sentence, and firing a half-typed one costs a real backend search and
 * answers about a query nobody asked.
 */

import { computed, onScopeDispose, ref, watch, type ComputedRef, type Ref } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import type {
  TraceListRow,
  TraceQLDatasource,
  TraceQLSpan,
  TraceQLSourceStatus,
  TraceQLTraceRow,
} from '@skywalking-horizon-ui/api-client';
import { bffClient } from '@/api/client';
import { usePreviewLayerBlock } from '@/controls/previewConfig';

/** Adapt a TraceQL row onto the shared list/scatter row — a presentation
 *  shape every trace source fills, not a span model.
 *
 *  `errorUnknown` is the honest part: the search response carries no failure
 *  marker, so the widgets must not paint those rows as successes. */
export function traceqlRowToListRow(r: TraceQLTraceRow): TraceListRow {
  return {
    key: r.traceId,
    endpointNames: [r.rootName || r.rootService || '—'],
    duration: r.durationMs,
    start: String(r.startMs),
    isError: r.isError ?? false,
    errorUnknown: r.isError === undefined,
    traceIds: [r.traceId],
  };
}

/** A time choice of 0: no window at all, which only a lookup by trace id
 *  offers. The trace tabs each own this sentinel rather than importing one
 *  from another feature. */
export const NO_TIME_RANGE = 0;

export function useTraceQLSources() {
  const q = useQuery({
    queryKey: ['traceql-sources'],
    queryFn: ({ signal }) => bffClient.traceql.sources(signal),
    staleTime: 60_000,
    // A probe that FAILED must not be believed for the same minute a healthy
    // one is: the tab would go on calling the datasource unreachable after it
    // came back, and there is nothing on the page to retry with. A configured
    // source that did not answer is re-probed until it does.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((s) => s.configured && !s.reachable) ? 10_000 : false,
  });
  const sources = computed<TraceQLSourceStatus[]>(() => q.data.value ?? []);
  const statusOf = (ds: TraceQLDatasource) => sources.value.find((s) => s.ds === ds) ?? null;
  return { sources, statusOf, isLoading: q.isLoading };
}

/** Everything a run is: the expression, the window and the limit as they were
 *  when Run was pressed, plus the press itself. The `nonce` is what makes a
 *  second press with identical inputs actually re-read — without it the query
 *  cache answers from the previous run and the button does nothing. */
export interface TraceQLSubmission {
  q: string;
  window: { startMs: number; endMs: number };
  limit: number;
  nonce: number;
}

export interface TraceQLSearchInput {
  ds: ComputedRef<TraceQLDatasource>;
  submitted: Ref<TraceQLSubmission | null>;
}

export function useTraceQLSearch(input: TraceQLSearchInput) {
  const q = useQuery({
    queryKey: computed(() => {
      const s = input.submitted.value;
      return ['traceql-search', input.ds.value, s?.q ?? '', s?.window.startMs ?? 0, s?.window.endMs ?? 0, s?.limit ?? 0, s?.nonce ?? 0];
    }),
    // Nothing runs until Run has been pressed. The datasource is part of the
    // key AND of the submission, so switching stores cannot fire the previous
    // store's query against the new one.
    enabled: computed(() => input.submitted.value !== null),
    queryFn: ({ signal }) => {
      const s = input.submitted.value!;
      return bffClient.traceql.search(input.ds.value, s.q, s.window, s.limit, signal);
    },
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const rows = computed<TraceListRow[]>(() => (q.data.value?.traces ?? []).map(traceqlRowToListRow));
  const traces = computed<TraceQLTraceRow[]>(() => q.data.value?.traces ?? []);
  const maxDuration = computed(() => rows.value.reduce((m, r) => Math.max(m, r.duration), 0));
  return {
    rows,
    traces,
    maxDuration,
    capped: computed(() => q.data.value?.capped ?? false),
    // A request that never landed is NOT a reachable source with no traces.
    // Reading only the payload's own flag turned a failed fetch into an empty
    // list, which reads as "no traces matched" — the wrong conclusion.
    reachable: computed(() => (q.error.value ? false : (q.data.value?.reachable ?? true))),
    error: computed(() => q.data.value?.error ?? (q.error.value ? String(q.error.value) : null)),
    /** True once a run has produced an answer of any kind. */
    answered: computed(() => q.data.value !== undefined || q.error.value != null),
    isFetching: q.isFetching,
    refetch: q.refetch,
  };
}

/**
 * Look several trace ids up at once.
 *
 * The Tempo API has no batch endpoint — only `/api/v2/traces/{id}`, one id per
 * call — so unlike the Zipkin tab (which has `traceMany`) this is a fan-out,
 * one request per id. That is why the count is capped, and why the page says
 * what it is doing rather than pretending a batch happened.
 */
export const TRACE_ID_LOOKUP_MAX = 20;

export interface TraceIdSubmission {
  ids: string[];
  window: { startMs: number; endMs: number } | null;
  nonce: number;
}

export function useTraceQLTraceIds(
  ds: ComputedRef<TraceQLDatasource>,
  submitted: Ref<TraceIdSubmission | null>,
) {
  const q = useQuery({
    // The nonce is what makes a second Run with the same ids re-read; without
    // it the cache answers and the button does nothing. The window is part of
    // the SUBMISSION, so changing the picker does not fire a query by itself.
    queryKey: computed(() => {
      const s = submitted.value;
      return ['traceql-trace-ids', ds.value, s?.ids.join(',') ?? '', s?.window?.startMs ?? null, s?.nonce ?? 0];
    }),
    enabled: computed(() => (submitted.value?.ids.length ?? 0) > 0),
    queryFn: async ({ signal }) => {
      const sub = submitted.value!;
      const wanted = sub.ids.slice(0, TRACE_ID_LOOKUP_MAX);
      // Ids past the cap were never asked about. They are reported as such
      // rather than dropped, or the answer would look complete.
      const skipped = sub.ids.slice(TRACE_ID_LOOKUP_MAX);
      const answers = await Promise.all(
        wanted.map((id) =>
          bffClient.traceql
            .trace(ds.value, id, sub.window ?? undefined, signal)
            // A read that FAILED is not a trace that is absent, and the two
            // must not be reported alike — one is an outage, the other an
            // answer.
            .catch(() => ({ failed: true as const })),
        ),
      );
      return [
        ...wanted.map((id, i) => ({ id, answer: answers[i]! })),
        ...skipped.map((id) => ({ id, answer: { skipped: true as const } })),
      ];
    },
    staleTime: 0,
    retry: false,
    // A lookup runs from Run query. Coming back to the tab must not repeat the
    // whole id fan-out and replace the results being read.
    refetchOnWindowFocus: false,
  });
  type Answer =
    | { failed: true }
    | { skipped: true }
    | { failed?: false; skipped?: false; traceId: string; spans: TraceQLSpan[]; reachable: boolean; notFound: boolean };
  const resolved = computed(() =>
    (q.data.value ?? []).map((a) => ({ id: a.id, answer: a.answer as Answer })),
  );
  /** One row per id that resolved, in the order they were typed. */
  const rows = computed<TraceListRow[]>(() =>
    resolved.value
      .filter((a) => !('failed' in a.answer) && !('skipped' in a.answer) && !a.answer.notFound && a.answer.spans.length > 0)
      .map((a) => {
        const detail = a.answer as Extract<Answer, { spans: TraceQLSpan[] }>;
        const spans = detail.spans;
        const start = Math.min(...spans.map((s) => s.startUs));
        const end = Math.max(...spans.map((s) => s.startUs + s.durationUs));
        const root = spans.find((s) => !s.parentSpanId) ?? spans[0]!;
        // A trace is failed when a span says so. Spans that say `unset` say
        // nothing, so a trace of only-unset spans stays UNKNOWN rather than
        // being called a success.
        const anyError = spans.some((s) => s.status === 'error');
        const anyKnown = spans.some((s) => s.status !== 'unset');
        return {
          key: detail.traceId,
          endpointNames: [root.name || root.service || '—'],
          duration: Math.round((end - start) / 1000),
          start: String(Math.round(start / 1000)),
          isError: anyError,
          errorUnknown: !anyKnown,
          traceIds: [detail.traceId],
        } satisfies TraceListRow;
      }),
  );
  /** Ids the source ANSWERED for, and did not have. A read that never landed
   *  is not an absence — it is in `failed`, and saying "not found" for it would
   *  report an outage as a fact about the trace. */
  const missing = computed(() =>
    resolved.value
      .filter((a) => !('failed' in a.answer) && !('skipped' in a.answer) && a.answer.reachable
        && (a.answer.notFound || a.answer.spans.length === 0))
      .map((a) => a.id),
  );
  /** Ids whose read never landed — an outage, not an absence. */
  const failed = computed(() =>
    resolved.value
      .filter((a) => 'failed' in a.answer || (!('skipped' in a.answer) && !a.answer.reachable))
      .map((a) => a.id),
  );
  /** Ids the cap left out of this submission — asked about by nobody. */
  const skipped = computed(() => resolved.value.filter((a) => 'skipped' in a.answer).map((a) => a.id));
  return {
    rows,
    missing,
    failed,
    skipped,
    isFetching: q.isFetching,
    answered: computed(() => q.data.value !== undefined),
  };
}

/** How many traces the deferred status check reads at once. Four keeps a
 *  20-row page under a second on a healthy OAP without queuing behind the
 *  reads an operator actually asked for. */
const STATUS_RESOLVE_CONCURRENCY = 4;

/**
 * Settle the status of rows the list could not.
 *
 * A search answers with what it found, and for most traces that is no failure
 * evidence at all — the projected attributes need not include one, and the
 * backend's own `status` filter can only classify a page it did not truncate.
 * The remaining rows are therefore READ, one trace at a time, after the list
 * has landed: an OTLP span carries its own status, so a trace settles its own
 * row.
 *
 * It runs at a bounded concurrency, is abandoned when a new query runs, and
 * fills the same cache the detail view reads, so opening one of these traces
 * afterwards costs nothing.
 */
export function useTraceQLStatusResolver(
  ds: ComputedRef<TraceQLDatasource>,
  window: ComputedRef<{ startMs: number; endMs: number } | null>,
  onStatus: (v: { traceId: string; isError: boolean }) => void,
) {
  const qc = useQueryClient();
  const pending = ref(0);
  let round: AbortController | null = null;

  function stop(): void {
    round?.abort();
    round = null;
    pending.value = 0;
  }

  async function resolve(rows: readonly TraceListRow[]): Promise<void> {
    stop();
    const queue = rows.filter((r) => r.errorUnknown).map((r) => r.key);
    if (queue.length === 0) return;
    const mine = new AbortController();
    round = mine;
    pending.value = queue.length;
    const win = window.value;
    const source = ds.value;
    async function worker(): Promise<void> {
      for (;;) {
        if (mine.signal.aborted) return;
        const traceId = queue.shift();
        if (!traceId) return;
        try {
          const detail = await qc.fetchQuery({
            // The detail view's own key, so this read IS that read. BOTH
            // bounds are in it: a window that moved only its end would
            // otherwise answer from the narrower read and classify a trace
            // against spans the new range was meant to include.
            queryKey: ['traceql-trace', source, traceId, win?.startMs ?? null, win?.endMs ?? null],
            // The ROUND's signal, not the query library's: aborting a round
            // has to stop the reads it started, or a new search leaves four
            // abandoned trace reads running against OAP.
            queryFn: () => bffClient.traceql.trace(source, traceId, win ?? undefined, mine.signal),
            staleTime: 30_000,
          });
          const spans = detail?.spans ?? [];
          // A trace of only-unset spans stays unknown: `unset` is the absence
          // of a verdict, not a success.
          if (spans.some((sp) => sp.status !== 'unset') && !mine.signal.aborted) {
            onStatus({ traceId, isError: spans.some((sp) => sp.status === 'error') });
          }
        } catch {
          // A status nobody could read stays unknown.
        }
        if (!mine.signal.aborted) pending.value = Math.max(0, pending.value - 1);
      }
    }
    await Promise.all(Array.from({ length: STATUS_RESOLVE_CONCURRENCY }, worker));
    if (round === mine) stop();
  }

  onScopeDispose(stop);
  return { resolve, stop, pending };
}

export function useTraceQLTrace(
  ds: ComputedRef<TraceQLDatasource>,
  traceId: Ref<string | null>,
  window: ComputedRef<{ startMs: number; endMs: number } | null>,
) {
  const q = useQuery({
    queryKey: computed(() => [
      'traceql-trace', ds.value, traceId.value, window.value?.startMs ?? null, window.value?.endMs ?? null,
    ]),
    enabled: computed(() => !!traceId.value),
    queryFn: ({ signal }) =>
      bffClient.traceql.trace(ds.value, traceId.value!, window.value ?? undefined, signal),
    staleTime: 30_000,
    retry: false,
  });
  return {
    spans: computed(() => q.data.value?.spans ?? []),
    notFound: computed(() => q.data.value?.notFound ?? false),
    reachable: computed(() => (q.error.value ? false : (q.data.value?.reachable ?? true))),
    isFetching: q.isFetching,
  };
}

/** Service / span / tag options for the builder. Fetched per datasource and
 *  layer, because the Tempo API lists every service of the underlying store
 *  and only the layer's own filter narrows it. */
export function useTraceQLOptions(
  ds: ComputedRef<TraceQLDatasource>,
  layerKey: ComputedRef<string>,
  window: ComputedRef<{ startMs: number; endMs: number }>,
  service: Ref<string> | ComputedRef<string>,
) {
  // An admin previewing an edited service filter must see THAT filter narrow
  // the picker, so the draft rides along and keys the query.
  const previewTraces = usePreviewLayerBlock(layerKey, 'traces');
  const services = useQuery({
    // The window is part of what was asked, so it is part of the key — a list
    // fetched for another window is a different answer, not a cached one.
    queryKey: computed(() => [
      'traceql-services', ds.value, layerKey.value, window.value.startMs, window.value.endMs, previewTraces.value ?? '',
    ]),
    queryFn: ({ signal }) =>
      bffClient.traceql.tagValues(ds.value, 'resource.service.name', window.value, {
        layer: layerKey.value,
        ...(previewTraces.value ? { previewConfig: previewTraces.value } : {}),
        signal,
      }),
    staleTime: 60_000,
  });
  const tags = useQuery({
    queryKey: computed(() => ['traceql-tags', ds.value, window.value.startMs, window.value.endMs]),
    queryFn: ({ signal }) => bffClient.traceql.tags(ds.value, window.value, signal),
    staleTime: 60_000,
  });
  // Span names resolve against a service id upstream, so asking without one
  // returns an empty list by design rather than by accident.
  const spanNames = useQuery({
    queryKey: computed(() => ['traceql-span-names', ds.value, service.value, window.value.startMs, window.value.endMs]),
    enabled: computed(() => !!service.value),
    queryFn: ({ signal }) =>
      bffClient.traceql.tagValues(ds.value, 'name', window.value, {
        // The value is interpolated into an expression, so it is escaped the
        // same way the builder escapes it.
        q: `{resource.service.name="${service.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"}`,
        layer: layerKey.value,
        signal,
      }),
    staleTime: 60_000,
  });
  const tagKeys = computed<string[]>(
    () => tags.data.value?.scopes.find((s) => s.name === 'span')?.tags ?? [],
  );
  // Keyed by DATASOURCE, WINDOW and tag: the same tag holds different values in
  // each store, and values read for another window are a different answer —
  // the same reason the two queries above carry the window in their keys.
  const tagValues = ref<Record<string, string[]>>({});
  const inFlight = new Map<string, AbortController>();
  function cacheKeyOf(tag: string): string {
    return `${ds.value}\u0000${window.value.startMs}\u0000${window.value.endMs}\u0000${tag}`;
  }
  function cancelInFlight(): void {
    for (const c of inFlight.values()) c.abort();
    inFlight.clear();
  }
  // A lookup whose answer can no longer be used is stopped rather than left to
  // land: it still costs the backend a read, and the tab may already be gone.
  watch([ds, () => window.value.startMs, () => window.value.endMs], () => {
    cancelInFlight();
    tagValues.value = {};
  });
  onScopeDispose(cancelInFlight);
  async function loadTagValues(key: string): Promise<void> {
    const cacheKey = cacheKeyOf(key);
    if (!key || tagValues.value[cacheKey] || inFlight.has(cacheKey)) return;
    const ctl = new AbortController();
    inFlight.set(cacheKey, ctl);
    try {
      const res = await bffClient.traceql.tagValues(ds.value, `span.${key}`, window.value, { signal: ctl.signal });
      tagValues.value = { ...tagValues.value, [cacheKey]: res.values };
    } catch {
      // Autocomplete is an aid; a failed or abandoned lookup leaves the field
      // as free text.
    } finally {
      inFlight.delete(cacheKey);
    }
  }
  function valuesFor(key: string): string[] {
    return tagValues.value[cacheKeyOf(key)] ?? [];
  }
  return {
    serviceOptions: computed(() => services.data.value?.values ?? []),
    spanNameOptions: computed(() => spanNames.data.value?.values ?? []),
    tagKeys,
    valuesFor,
    loadTagValues,
  };
}
