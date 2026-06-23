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
 * Explore — cross-layer trace/log query power-tool wire contract.
 *
 * One POST /api/explore/query carries a `kind` (trace|log) + a source
 * (native|zipkin for trace, raw|browser for log) + an entity + a window,
 * and the BFF dispatches onto the SAME query logic the per-layer Traces/
 * Logs tabs use — but without a layer. The entity is identified by a
 * pre-resolved OAP id (Pick mode) or a name + `real` flag (Type mode);
 * the BFF encodes `base64(name).{1|0}` so no `listServices(layer)` is
 * needed. Responses reuse the per-layer response shapes verbatim, tagged
 * by kind+source so the UI renderer narrows.
 */

import type {
  NativeTraceListResponse,
  TraceQueryOrder,
  TraceQueryState,
  ZipkinTraceListResponse,
} from './trace.js';
import type { LogsResponse } from './logs.js';
import type { BrowserErrorCategory, BrowserErrorsResponse } from './browser-errors.js';

export type ExploreKind = 'trace' | 'log';
export type ExploreTraceSource = 'native' | 'zipkin';
export type ExploreLogSource = 'raw' | 'browser';

/**
 * How the operator named the entity. Pick mode forwards OAP ids the
 * metadata routes already minted; Type mode supplies a name + the
 * real/normal flag and the BFF builds the id (`base64(name).{1|0}`),
 * so a layer is never needed. Zipkin uses a raw service name (no id).
 */
export interface ExploreEntity {
  mode: 'pick' | 'type';
  /** Pick: pre-resolved OAP service id (native/raw/browser). */
  serviceId?: string;
  instanceId?: string;
  endpointId?: string;
  /** Type: name + flag the BFF encodes. Also the zipkin service name. */
  serviceName?: string;
  isReal?: boolean;
  instanceName?: string;
  endpointName?: string;
}

/** Self-owned triage window (SECOND precision). Explicit start/end (epoch
 *  ms) override the rolling `windowMinutes`. */
export interface ExploreWindow {
  windowMinutes?: number;
  startMs?: number;
  endMs?: number;
}

export interface ExploreRequest {
  kind: ExploreKind;
  /** when kind === 'trace' */
  traceSource?: ExploreTraceSource;
  /** when kind === 'log' */
  logSource?: ExploreLogSource;
  /** Optional — a trace/log query needs no entity (query all services in
   *  the window, or filter by trace id / conditions only). */
  entity?: ExploreEntity;
  window: ExploreWindow;
  pageNum?: number;
  pageSize?: number;
  // ── trace conditions ──
  traceId?: string;
  traceState?: TraceQueryState;
  queryOrder?: TraceQueryOrder;
  minTraceDuration?: number;
  maxTraceDuration?: number;
  tags?: Array<{ key: string; value: string }>;
  // ── zipkin-only (service name lives on entity.serviceName) ──
  remoteServiceName?: string;
  spanName?: string;
  annotationQuery?: string;
  // ── log (raw) conditions ──
  keywordsOfContent?: string[];
  relatedTraceId?: string;
  // ── log (browser) condition ──
  category?: BrowserErrorCategory;
}

/** Query-transparency echo: what the BFF actually resolved + ran. */
export interface ExploreResolved {
  kind: ExploreKind;
  source: ExploreTraceSource | ExploreLogSource;
  /** native: 'queryTraces' | 'queryBasicTraces'. */
  backend?: string;
  /** Resolved OAP id (native/raw/browser) or zipkin service name. */
  entityId?: string;
  /** The condition the BFF sent (display-only). */
  condition: Record<string, unknown>;
}

export type ExploreResponse =
  | { kind: 'trace'; traceSource: 'native'; generatedAt: number; native: NativeTraceListResponse; resolved: ExploreResolved }
  | { kind: 'trace'; traceSource: 'zipkin'; generatedAt: number; zipkin: ZipkinTraceListResponse; resolved: ExploreResolved }
  | { kind: 'log'; logSource: 'raw'; generatedAt: number; logs: LogsResponse; resolved: ExploreResolved }
  | { kind: 'log'; logSource: 'browser'; generatedAt: number; browser: BrowserErrorsResponse; resolved: ExploreResolved };
