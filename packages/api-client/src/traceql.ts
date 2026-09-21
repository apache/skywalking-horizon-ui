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

/** Which trace store answers a TraceQL query. Each is a separate OAP
 *  datasource on its own URL; they share this API and this renderer. */
/** Which of OAP's TraceQL datasources answers — one context path each on the
 *  Tempo port. `otlp` serves the spans `receiver-otel` stored natively. */
export type TraceQLDatasource = 'native' | 'zipkin' | 'otlp';

/** The queried service's own entry into a trace — where it starts relative to
 *  the trace and how long its first span ran. Only available when the query
 *  names a service, and only on a source whose list carries every span. */
export interface TraceQLServiceEntry {
  service: string;
  offsetMs: number;
  durationMs: number;
  kind: string;
}

export interface TraceQLTraceRow {
  /** The real trace id — never the hex wire form. */
  traceId: string;
  rootService: string;
  rootName: string;
  startMs: number;
  durationMs: number;
  spanCount: number;
  services: string[];
  serviceEntry?: TraceQLServiceEntry;
  /** Absent when the source does not report failure. The native search
   *  response carries no error marker, so a row there is UNKNOWN — which the
   *  renderer must show as unknown, never as success. */
  isError?: boolean;
}

export interface TraceQLTraceListResponse {
  ds: TraceQLDatasource;
  traces: TraceQLTraceRow[];
  /** The query returned as many rows as it asked for, so there may be more.
   *  This API has no paging, so the only remedy is a narrower query. */
  capped: boolean;
  reachable: boolean;
  /** OAP's own message for a refused expression, verbatim. */
  error?: string;
}

export interface TraceQLSpanAttribute {
  key: string;
  value: string;
}

export interface TraceQLSpanEvent {
  timeUs: number;
  name: string;
  attributes: TraceQLSpanAttribute[];
}

export interface TraceQLSpan {
  spanId: string;
  parentSpanId: string;
  /** `service.name` off the span's RESOURCE — kept as its own field because
   *  every view groups by it, while the rest of the resource stays whole. */
  service: string;
  /** The resource this span belongs to, verbatim. OTLP separates resource
   *  attributes from span attributes and so does the detail view: they answer
   *  different questions (who emitted this vs what happened). */
  resourceAttributes: TraceQLSpanAttribute[];
  /** The instrumentation scope that produced the span. */
  scopeName?: string;
  scopeVersion?: string;
  name: string;
  /** OTLP span kind, e.g. `SPAN_KIND_SERVER`. */
  kind: string;
  startUs: number;
  durationUs: number;
  /** OTLP's three states. `unset` is what the Zipkin converter defaults to,
   *  and it is NOT success — rendering it as OK would paint an unknown span
   *  green. */
  status: 'ok' | 'error' | 'unset';
  statusMessage?: string;
  attributes: TraceQLSpanAttribute[];
  events: TraceQLSpanEvent[];
}

export interface TraceQLTraceDetailResponse {
  ds: TraceQLDatasource;
  traceId: string;
  spans: TraceQLSpan[];
  reachable: boolean;
  notFound: boolean;
  error?: string;
}

export interface TraceQLTagScope {
  name: string;
  tags: string[];
}

export interface TraceQLTagsResponse {
  scopes: TraceQLTagScope[];
}

export interface TraceQLTagValuesResponse {
  values: string[];
}

/** One datasource's availability, as the Cluster Status pane and the page's
 *  own empty state read it. `configured` separates "nobody set this up" from
 *  "it is set up and down"; `error` carries the failure so a wrong port, a
 *  wrong context path and a disabled datasource — which fail identically at
 *  the socket — can be told apart. */
export interface TraceQLSourceStatus {
  ds: TraceQLDatasource;
  /** The datasource's full URL — empty when this OAP does not serve it. */
  url: string;
  configured: boolean;
  /** False when the service ANSWERED but does not serve this datasource — a
   *  404, which is OAP saying the datasource is not enabled. Absent when the
   *  question never got that far. Distinct from `reachable`: nothing is down. */
  served?: boolean;
  reachable: boolean;
  version?: string;
  error?: string;
}
