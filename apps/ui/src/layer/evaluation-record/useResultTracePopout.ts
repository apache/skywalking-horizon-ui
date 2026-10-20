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

import type { GenAITraceRefType } from '@skywalking-horizon-ui/api-client';
import { useTracePopout } from '@/layer/traces/useTracePopout';
import { useZipkinTracePopout } from '@/layer/traces/useZipkinTracePopout';
import { useTraceQLTracePopout } from '@/layer/traceql/useTraceQLTracePopout';

export type ResultTraceRef = {
  type: GenAITraceRefType;
  traceId: string;
  segmentId?: string | null;
  spanIndex?: number | null;
  spanId?: string | null;
};

/** Opens an evaluation result's trace on the popout of the store its
 *  traceRef.type names, with the judged span selected. */
export function useResultTracePopout() {
  const { openTrace: openNativeTrace } = useTracePopout();
  const { openTrace: openZipkinTrace } = useZipkinTracePopout();
  const { openTrace: openTraceQLTrace } = useTraceQLTracePopout();

  function openResultTrace(ref: ResultTraceRef, atMs?: number): void {
    if (!ref.traceId) return;
    const focus = {
      segmentId: ref.segmentId ?? null,
      spanIndex: ref.spanIndex ?? null,
      spanId: ref.spanId ?? null,
    };
    if (ref.type === 'OTLP') {
      // TraceQL looks an id up across everything it retains, so the record's
      // moment has nothing to bound.
      openTraceQLTrace(ref.traceId, 'otlp', { spanId: focus.spanId });
    } else if (ref.type === 'ZIPKIN') {
      // The moment bounds the lookup the same way it does for a native trace:
      // without it OAP searches only its default day, and a record older than
      // that (cold stage on) opens to an empty popout.
      openZipkinTrace(ref.traceId, { ...focus, at: atMs });
    } else {
      openNativeTrace(ref.traceId, atMs, ref.type, focus);
    }
  }

  return { openResultTrace };
}
