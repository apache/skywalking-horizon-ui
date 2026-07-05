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
 * Tiny REST client for OAP's Zipkin Query plugin endpoints.
 *
 * Zipkin lives on the SAME host:port as OAP's GraphQL (the
 * `oap.queryUrl`) but uses standard zipkin v2 paths instead of
 * GraphQL:
 *
 *   GET /api/v2/services
 *   GET /api/v2/spans
 *   GET /api/v2/traces?serviceName=&spanName=&minDuration=&maxDuration=&endTs=&lookback=&limit=
 *   GET /api/v2/trace/{traceId}
 *
 * Wire shape is the standard Zipkin v2 JSON span format. We surface
 * it verbatim — no field mapping into the SkyWalking-native shape.
 *
 * Errors are bubbled as plain `Error` instances; the route handler
 * wraps them into a soft-fail response so the parallel native fetch
 * still surfaces results.
 */

import type {
  FetchLike,
  ZipkinSpan,
  ZipkinTraceListRow,
} from '@skywalking-horizon-ui/api-client';

export interface ZipkinClientOpts {
  queryUrl: string;
  timeoutMs: number;
  fetch?: FetchLike;
  /** Optional basic-auth — same shape as the GraphQL client. */
  auth?: { username: string; password: string };
}

export interface ZipkinTracesQuery {
  serviceName?: string;
  remoteServiceName?: string;
  spanName?: string;
  /** Zipkin annotation query — `key` / `key=value`, AND-joined. */
  annotationQuery?: string;
  /** Microseconds. */
  minDuration?: number;
  /** Microseconds. */
  maxDuration?: number;
  /** Upper bound time in millis since epoch (defaults to now). */
  endTs?: number;
  /** Lookback in millis (defaults 30 min). */
  lookback?: number;
  limit?: number;
}

const DEFAULT_LOOKBACK_MS = 30 * 60_000;

async function zipkinFetch<T>(opts: ZipkinClientOpts, path: string): Promise<T> {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const url = opts.queryUrl.replace(/\/$/, '') + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.auth) {
    const raw = `${opts.auth.username}:${opts.auth.password}`;
    const b64 = Buffer.from(raw, 'utf8').toString('base64');
    headers.authorization = `Basic ${b64}`;
  }
  let res: Response;
  try {
    res = await f(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`zipkin ${res.status} ${url} — ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/**
 * Summarise a zipkin trace's span array into a list-row. Zipkin
 * doesn't ship a "traces summary" endpoint; the list endpoint
 * returns `Span[][]` (one inner array per trace), so we compute
 * the headline fields ourselves from the root span.
 */
export function summariseZipkinTrace(spans: ZipkinSpan[]): ZipkinTraceListRow {
  if (spans.length === 0) {
    return {
      traceId: '',
      rootName: null,
      rootService: null,
      timestamp: null,
      duration: null,
      spanCount: 0,
      errorCount: 0,
    };
  }
  const root = spans.find((s) => !s.parentId) ?? spans[0];
  let errorCount = 0;
  for (const s of spans) {
    if (s.tags && (s.tags.error !== undefined || s.tags['otel.status_code'] === 'ERROR')) {
      errorCount += 1;
    }
  }
  return {
    traceId: root.traceId,
    rootName: root.name ?? null,
    rootService: root.localEndpoint?.serviceName ?? null,
    timestamp: root.timestamp ?? null,
    duration: root.duration ?? null,
    spanCount: spans.length,
    errorCount,
  };
}

/**
 * List traces matching the operator's filter. Zipkin's wire
 * response is `Span[][]` (one inner array per trace); we summarise
 * each entry into a single list-row for the UI table.
 */
export async function zipkinFetchTraces(
  opts: ZipkinClientOpts,
  query: ZipkinTracesQuery,
): Promise<ZipkinTraceListRow[]> {
  const qs = new URLSearchParams();
  if (query.serviceName) qs.set('serviceName', query.serviceName);
  if (query.remoteServiceName) qs.set('remoteServiceName', query.remoteServiceName);
  if (query.spanName) qs.set('spanName', query.spanName);
  if (query.annotationQuery) qs.set('annotationQuery', query.annotationQuery);
  if (typeof query.minDuration === 'number') qs.set('minDuration', String(query.minDuration));
  if (typeof query.maxDuration === 'number') qs.set('maxDuration', String(query.maxDuration));
  const endTs = query.endTs ?? Date.now();
  const lookback = query.lookback ?? DEFAULT_LOOKBACK_MS;
  qs.set('endTs', String(endTs));
  qs.set('lookback', String(lookback));
  qs.set('limit', String(query.limit ?? 20));
  const path = `/api/v2/traces?${qs.toString()}`;
  const arr = await zipkinFetch<ZipkinSpan[][]>(opts, path);
  return arr.map(summariseZipkinTrace).filter((r) => r.traceId);
}

/** Fetch a single trace by id. Returns the full span array
 *  unmodified — the UI's zipkin waterfall renders zipkin fields
 *  natively (kind / annotations / localEndpoint / remoteEndpoint /
 *  tags map). */
export async function zipkinFetchTraceById(
  opts: ZipkinClientOpts,
  traceId: string,
): Promise<ZipkinSpan[]> {
  const path = `/api/v2/trace/${encodeURIComponent(traceId)}`;
  return zipkinFetch<ZipkinSpan[]>(opts, path);
}

/** The Zipkin service universe (`localEndpoint.serviceName` of recent spans) —
 *  a flat list of names, GLOBAL (Zipkin has no layer concept). The AI assistant
 *  reads this to match a user/SkyWalking service to its Zipkin-side name. */
export async function zipkinFetchServices(opts: ZipkinClientOpts): Promise<string[]> {
  const body = await zipkinFetch<unknown>(opts, '/api/v2/services');
  return Array.isArray(body) ? (body as unknown[]).filter((s): s is string => typeof s === 'string') : [];
}
