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

import type { LocationQuery } from 'vue-router';

export const TRACE_POPOUT_QUERY = 'traceId';
export const TRACE_POPOUT_AT = 'traceAt';
export const TRACE_POPOUT_TYPE = 'traceType';
export const TRACE_POPOUT_SEGMENT = 'traceSegmentId';
export const TRACE_POPOUT_SPAN_INDEX = 'traceSpanIndex';
export const TRACE_POPOUT_SPAN = 'traceSpanId';

export type TracePopoutQuery = LocationQuery;
export type TraceFocus = { segmentId?: string | null; spanIndex?: number | null; spanId?: string | null };

export function withTraceFocus(query: TracePopoutQuery, focus?: TraceFocus): TracePopoutQuery {
  const next = { ...query };
  if (focus?.segmentId) next[TRACE_POPOUT_SEGMENT] = focus.segmentId; else delete next[TRACE_POPOUT_SEGMENT];
  if (focus?.spanIndex != null) next[TRACE_POPOUT_SPAN_INDEX] = String(focus.spanIndex); else delete next[TRACE_POPOUT_SPAN_INDEX];
  if (focus?.spanId) next[TRACE_POPOUT_SPAN] = focus.spanId; else delete next[TRACE_POPOUT_SPAN];
  return next;
}

export function clearTraceFocus(query: TracePopoutQuery): TracePopoutQuery {
  const next = { ...query };
  delete next[TRACE_POPOUT_SEGMENT];
  delete next[TRACE_POPOUT_SPAN_INDEX];
  delete next[TRACE_POPOUT_SPAN];
  return next;
}
