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
 * Wire types for the per-layer Logs tab. Mirrors OAP's
 * `queryLogs(LogQueryCondition)` shape — keys + values verbatim so
 * the UI can render zero-loss alongside the raw payload. Visual
 * treatment leans Loki / Datadog (density timeline + dense stream
 * + inline row expand).
 */

export interface LogKeyValue {
  key: string;
  value: string;
}

export interface LogRow {
  serviceName: string | null;
  serviceId: string | null;
  serviceInstanceName: string | null;
  serviceInstanceId: string | null;
  endpointName: string | null;
  endpointId: string | null;
  traceId: string | null;
  /** Unix millis. */
  timestamp: number;
  /** Content MIME — `text/plain` or `application/json` (or any
   *  custom type OAP forwards). The UI's detail renderer picks a
   *  syntax based on this. */
  contentType: string;
  content: string;
  tags: LogKeyValue[];
}

export interface LogTagFilter {
  key: string;
  value: string;
}

export interface LogQueryRequest {
  serviceId?: string;
  serviceInstanceId?: string;
  endpointId?: string;
  traceId?: string;
  /** Free-text content keywords. AND-joined server-side. */
  keywordsOfContent?: string[];
  /** Tag matches. AND-joined server-side. */
  tags?: LogTagFilter[];
  /** Page number, 1-based. */
  page?: number;
  /** Page size, defaults 50 client-side. */
  pageSize?: number;
  /** Rolling time-window for the query in minutes, ending at "now".
   *  Falls back to the BFF default (~60min) when omitted. Ignored when
   *  an explicit `startMs` / `endMs` pair is supplied. */
  windowMinutes?: number;
  /** Explicit absolute window in epoch ms. When both are set the rolling
   *  `windowMinutes` is ignored; the BFF applies the OAP offset. */
  startMs?: number;
  endMs?: number;
}

export interface LogsResponse {
  generatedAt: number;
  /** Echo of the query so the SPA can render "page N of M" without
   *  re-stating the request. */
  query: LogQueryRequest;
  /** Total rows OAP claims to know about across all pages. */
  total: number;
  logs: LogRow[];
  reachable: boolean;
  error?: string;
}

/**
 * Per-level and per-service counts derived from a server-side facet
 * sample. The BFF pulls a larger window (default 200 rows) and folds
 * the counts so the UI can render the left-rail facets against
 * window-scope numbers rather than the visible page only.
 */
export interface LogFacetsResponse {
  generatedAt: number;
  /** Total rows OAP reported across the facet window. */
  total: number;
  /** Rows actually included in the facet sample (capped). */
  sampled: number;
  /** Count by `level` tag value, normalised to lowercase. Buckets
   *  outside (error / warn / info / debug) fall into `other`. */
  level: Record<'error' | 'warn' | 'info' | 'debug' | 'other', number>;
  /** Top services by count, capped. */
  services: Array<{ name: string; count: number }>;
  reachable: boolean;
  error?: string;
}

/** Distinct tag keys + sampled values returned by
 *  `POST /api/layer/:key/logs/tags-suggest`. Used to power the
 *  conditions-bar tag autocomplete. */
export interface LogTagsSuggestResponse {
  keys: Array<{ key: string; values: string[] }>;
  reachable: boolean;
  error?: string;
}
