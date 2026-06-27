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
import type { NativeTraceListRow, ZipkinTraceListRow } from '@/api/client';

/**
 * Adapt a Zipkin trace-list row onto the shared `NativeTraceListRow`
 * shape the trace distribution scatter + list widgets consume.
 *
 * Two unit conversions matter — Zipkin reports microseconds, the shared
 * widgets assume the native milli-scale:
 *   - `duration`  µs → ms  (the widgets render the bar / tooltip in ms).
 *   - `timestamp` µs → ms  (carried as the `start` numeric string the
 *     widgets `Number()`-parse into ms-since-epoch for the scatter X).
 *
 * `key` / `traceIds` stay the Zipkin `traceId` so the host's pick set
 * and row selection key on the trace id.
 */
export function zipkinRowToNative(r: ZipkinTraceListRow): NativeTraceListRow {
  return {
    key: r.traceId,
    segmentId: '',
    endpointNames: [r.rootName ?? r.rootService ?? '—'],
    duration: Math.round((r.duration ?? 0) / 1000),
    start: String((r.timestamp ?? 0) / 1000),
    isError: r.errorCount > 0,
    traceIds: [r.traceId],
  };
}
