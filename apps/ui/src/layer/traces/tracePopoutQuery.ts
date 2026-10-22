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

/** The one address of a trace, on any page: `?traceId=` with `?traceType=`
 *  naming the trace source that reads it — the names a layer template's
 *  `traces.sources` uses, each one query against OAP. */

import type { LocationQuery } from 'vue-router';
import { TRACE_STORES, type TraceStore } from '@skywalking-horizon-ui/api-client';

export const TRACE_POPOUT_QUERY = 'traceId';
export const TRACE_POPOUT_AT = 'traceAt';
export const TRACE_POPOUT_TYPE = 'traceType';
export const TRACE_POPOUT_SEGMENT = 'traceSegmentId';
export const TRACE_POPOUT_SPAN_INDEX = 'traceSpanIndex';
export const TRACE_POPOUT_SPAN = 'traceSpanId';

export type TracePopoutQuery = LocationQuery;
export type TraceFocus = { segmentId?: string | null; spanIndex?: number | null; spanId?: string | null };

/** The trace source the address names, or null — none, or one not in
 *  {@link TRACE_STORES}; such a link opens the notice. */
export function traceStoreOf(query: TracePopoutQuery): TraceStore | null {
  const v = query[TRACE_POPOUT_TYPE];
  return typeof v === 'string' && (TRACE_STORES as readonly string[]).includes(v) ? (v as TraceStore) : null;
}

/** Every key of the address: the id, its source, its moment or window, and
 *  the span to select. */
export const TRACE_ADDRESS_KEYS: readonly string[] = [
  TRACE_POPOUT_QUERY, TRACE_POPOUT_TYPE, TRACE_POPOUT_AT, 'traceEnd', 'traceLookback',
  TRACE_POPOUT_SEGMENT, TRACE_POPOUT_SPAN_INDEX, TRACE_POPOUT_SPAN,
];

export function clearTraceAddress(query: TracePopoutQuery): TracePopoutQuery {
  const next = { ...query };
  for (const key of TRACE_ADDRESS_KEYS) delete next[key];
  return next;
}

export function withTraceFocus(query: TracePopoutQuery, focus?: TraceFocus): TracePopoutQuery {
  const next = { ...query };
  if (focus?.segmentId) next[TRACE_POPOUT_SEGMENT] = focus.segmentId; else delete next[TRACE_POPOUT_SEGMENT];
  if (focus?.spanIndex != null) next[TRACE_POPOUT_SPAN_INDEX] = String(focus.spanIndex); else delete next[TRACE_POPOUT_SPAN_INDEX];
  if (focus?.spanId) next[TRACE_POPOUT_SPAN] = focus.spanId; else delete next[TRACE_POPOUT_SPAN];
  return next;
}

/** A shareable link to a trace from the page at `href`. An address the page
 *  already carries for the same trace keeps its span and window; one for
 *  another trace is dropped whole. */
export function traceLink(href: string, traceId: string, store: TraceStore): URL {
  const url = new URL(href);
  if (url.searchParams.get(TRACE_POPOUT_QUERY) !== traceId) {
    for (const key of TRACE_ADDRESS_KEYS) url.searchParams.delete(key);
  }
  url.searchParams.set(TRACE_POPOUT_QUERY, traceId);
  url.searchParams.set(TRACE_POPOUT_TYPE, store);
  return url;
}
