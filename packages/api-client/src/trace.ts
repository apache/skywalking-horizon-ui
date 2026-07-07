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
 * Wire types for the per-layer Traces tab.
 *
 * SkyWalking native traces and Zipkin traces COEXIST in the same UI.
 * The layer's `traces.source` setting decides which one(s) the page
 * fetches; the operator can also override per-query via the
 * filter-bar selector. Native and Zipkin keep separate wire shapes —
 * we do NOT normalise into a "common" trace; each backend's fields
 * are surfaced verbatim, with its own waterfall renderer.
 *
 * Native traces are served by one of two OAP queries: `queryTraces`
 * (one call, spans inline) or `queryBasicTraces` (segment list, then
 * a per-trace `queryTrace` fetch by id). The BFF picks the right one
 * based on `hasQueryTracesV2Support` and the caller doesn't need to
 * know which.
 */

export type TraceSource = 'native' | 'zipkin' | 'both';

/** Per-layer traces dashboard config. Lives at `template.traces` in
 *  the layer JSON. When absent, defaults to `{ source: 'both' }`. */
export interface TracesConfig {
  source: TraceSource;
}

// ── Native trace types (both OAP queries share the span shape) ─────

/** Which OAP query served the native trace list/detail. Driven by the
 *  OAP storage backend, not its version:
 *  - `queryTraces`      — Trace Query v2 API; returns the whole trace
 *    (spans inline). Only available on the BanyanDB backend.
 *  - `queryBasicTraces` — Trace Query v1 API; returns segment
 *    summaries, the full trace is fetched on demand via
 *    `queryTrace(traceId)`. Available on every backend (ES, …). */
export type TraceQueryApi = 'queryTraces' | 'queryBasicTraces';

export interface TraceKeyValue {
  key: string;
  value: string;
}
export interface TraceLogEntry {
  time: number;
  data: TraceKeyValue[];
}
export interface TraceAttachedEventTime {
  seconds: number;
  nanos: number;
}
export interface TraceAttachedEvent {
  startTime: TraceAttachedEventTime;
  endTime: TraceAttachedEventTime;
  event: string;
  tags: TraceKeyValue[];
  summary: TraceKeyValue[];
}
export interface TraceRef {
  traceId: string;
  parentSegmentId: string;
  parentSpanId: number;
  type: string;
}
export interface NativeSpan {
  traceId: string;
  segmentId: string;
  spanId: number;
  parentSpanId: number;
  refs: TraceRef[];
  serviceCode: string;
  serviceInstanceName: string;
  startTime: number;
  endTime: number;
  endpointName: string;
  type: string;
  peer: string;
  component: string;
  isError: boolean;
  layer: string;
  tags: TraceKeyValue[];
  logs: TraceLogEntry[];
  attachedEvents: TraceAttachedEvent[];
}

/** One row in the trace list. Both queries share this shape. The
 *  segmentId / traceIds pair lets the operator open the full trace
 *  through the `queryTrace`-by-id fetch path; `queryTraces` already
 *  embeds spans so the list endpoint may surface them directly. */
export interface NativeTraceListRow {
  key: string;
  segmentId: string;
  endpointNames: string[];
  duration: number;
  start: string;
  isError: boolean;
  traceIds: string[];
  /** Only populated when the BFF served the list via `queryTraces`
   *  (spans inline). `queryBasicTraces` returns these undefined; the
   *  SPA fetches detail on demand via the trace-by-id endpoint. */
  spans?: NativeSpan[];
}

export type TraceQueryOrder = 'BY_START_TIME' | 'BY_DURATION';
export type TraceQueryState = 'ALL' | 'SUCCESS' | 'ERROR';

export interface NativeTraceListResponse {
  source: 'native';
  /** Which OAP query answered — informational, lets the SPA decide
   *  whether list rows already carry spans (`queryTraces`) or need a
   *  follow-up `queryTrace` fetch (`queryBasicTraces`). */
  api: TraceQueryApi;
  traces: NativeTraceListRow[];
  reachable: boolean;
  error?: string;
}

export interface NativeTraceDetailResponse {
  source: 'native';
  api: TraceQueryApi;
  traceId: string;
  spans: NativeSpan[];
  reachable: boolean;
  error?: string;
}

// Zipkin's wire shape is the v2 JSON span format (zipkin.io/zipkin-api).
// We surface it verbatim so the operator sees zipkin-shaped data when
// they're inspecting a zipkin trace.

export interface ZipkinEndpoint {
  serviceName?: string | null;
  ipv4?: string | null;
  ipv6?: string | null;
  port?: number | null;
}
export interface ZipkinAnnotation {
  timestamp: number;
  value: string;
}
export type ZipkinKind = 'CLIENT' | 'SERVER' | 'PRODUCER' | 'CONSUMER' | 'INTERNAL';
export interface ZipkinSpan {
  traceId: string;
  id: string;
  parentId?: string | null;
  name?: string | null;
  kind?: ZipkinKind | null;
  /** Microseconds since epoch. */
  timestamp?: number | null;
  /** Microseconds. */
  duration?: number | null;
  localEndpoint?: ZipkinEndpoint | null;
  remoteEndpoint?: ZipkinEndpoint | null;
  annotations?: ZipkinAnnotation[];
  tags?: Record<string, string>;
  debug?: boolean;
  shared?: boolean;
}

/** One row in the Zipkin trace list, derived from the span tree's
 *  root entry. Zipkin doesn't ship a "trace summary" endpoint — the
 *  BFF computes the fields below from the first span. */
export interface ZipkinTraceListRow {
  traceId: string;
  rootName: string | null;
  rootService: string | null;
  /** Microseconds since epoch. */
  timestamp: number | null;
  /** Microseconds. */
  duration: number | null;
  spanCount: number;
  errorCount: number;
  /** The trace's full span tree. Zipkin's `/traces` already ships every
   *  span per trace, so the list route carries them through and the inline
   *  detail renders without a second `/trace/{id}` round-trip (mirrors
   *  native `queryTraces`). Optional — the AI-assistant list path omits it. */
  spans?: ZipkinSpan[];
}

export interface ZipkinTraceListResponse {
  source: 'zipkin';
  traces: ZipkinTraceListRow[];
  reachable: boolean;
  error?: string;
}

export interface ZipkinTraceDetailResponse {
  source: 'zipkin';
  traceId: string;
  spans: ZipkinSpan[];
  reachable: boolean;
  error?: string;
}

// When the operator picks `source = both`, the list endpoint fans
// out to both backends and surfaces them on independent slots. The
// UI renders two separate tables (one per backend) rather than
// mixing rows that don't share a schema.

export interface TraceListResponse {
  generatedAt: number;
  /** Echo of the requested source — keeps the UI's filter selector in
   *  sync without an extra round trip. */
  source: TraceSource;
  native?: NativeTraceListResponse;
  zipkin?: ZipkinTraceListResponse;
}

export interface TraceDetailResponse {
  generatedAt: number;
  /** The detail call always knows its source up front — the caller
   *  picks via the URL when opening a trace from one of the two
   *  list tables. */
  source: 'native' | 'zipkin';
  native?: NativeTraceDetailResponse;
  zipkin?: ZipkinTraceDetailResponse;
}
