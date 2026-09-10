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

import { useTracePopout } from './useTracePopout';
import { useZipkinTracePopout } from './useZipkinTracePopout';

export type ResultTraceRef = {
  type: 'SKYWALKING_NATIVE' | 'OTLP';
  traceId: string;
  segmentId?: string | null;
  spanIndex?: number | null;
  spanId?: string | null;
};

/** Opens an evaluation result's trace using the renderer implied by traceRef.type. */
export function useResultTracePopout() {
  const { openTrace: openNativeTrace } = useTracePopout();
  const { openTrace: openOtlpTrace } = useZipkinTracePopout();

  function openResultTrace(ref: ResultTraceRef, atMs?: number): void {
    if (!ref.traceId) return;
    const focus = {
      segmentId: ref.segmentId ?? null,
      spanIndex: ref.spanIndex ?? null,
      spanId: ref.spanId ?? null,
    };
    if (ref.type === 'OTLP') {
      openOtlpTrace(ref.traceId, focus);
    } else {
      openNativeTrace(ref.traceId, atMs, ref.type, focus);
    }
  }

  return { openResultTrace };
}
