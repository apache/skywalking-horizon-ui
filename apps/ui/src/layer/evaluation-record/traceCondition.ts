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

import type { GenAITraceRefType, TraceStore } from '@skywalking-horizon-ui/api-client';
import {
  TRACE_POPOUT_QUERY, TRACE_POPOUT_SEGMENT, TRACE_POPOUT_SPAN, TRACE_POPOUT_SPAN_INDEX, traceStoreOf, type TracePopoutQuery,
} from '@/layer/traces/tracePopoutQuery';

/** The store OAP keeps a trace in, by the source that reads it. */
const REF_TYPE: Record<TraceStore, GenAITraceRefType> = {
  native: 'SKYWALKING_NATIVE',
  'traceql-native': 'SKYWALKING_NATIVE',
  zipkin: 'ZIPKIN',
  'traceql-zipkin': 'ZIPKIN',
  'traceql-otlp': 'OTLP',
};

export interface TraceCondition {
  traceId: string;
  type: GenAITraceRefType;
  segmentId: string;
  spanIndex: number | '';
  spanId: string;
}

/** The trace-id condition a link to the tab carries: the address of a trace
 *  (and of one span of it), as every trace link writes it. A link naming no
 *  trace source, or one it does not know, carries none — the notice asks
 *  which source to read it from. */
export function traceConditionOf(query: TracePopoutQuery): TraceCondition | null {
  const text = (key: string): string => {
    const v = query[key];
    return typeof v === 'string' ? v : '';
  };
  const traceId = text(TRACE_POPOUT_QUERY);
  const store = traceStoreOf(query);
  if (!traceId || !store) return null;
  const segmentId = text(TRACE_POPOUT_SEGMENT);
  const spanId = text(TRACE_POPOUT_SPAN);
  // A native span is a segment and the span's place in it, named by the span
  // id beside the segment or by the index. A link naming two different ones
  // narrows to neither: which of them exists is only known from the spans.
  const byId = segmentId && spanId ? Number(spanId) : NaN;
  const byIndex = Number(text(TRACE_POPOUT_SPAN_INDEX) || NaN);
  const isIndex = (n: number) => Number.isInteger(n) && n >= 0;
  const index = isIndex(byId) && isIndex(byIndex) && byId !== byIndex ? NaN : isIndex(byId) ? byId : byIndex;
  return {
    traceId,
    type: REF_TYPE[store],
    segmentId,
    spanIndex: Number.isInteger(index) && index >= 0 ? index : '',
    spanId,
  };
}
