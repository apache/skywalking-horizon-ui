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
 *   GET /api/v2/traceMany?traceIds=
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
  ZipkinTraceListResponse,
  ZipkinTraceListRow,
} from '@skywalking-horizon-ui/api-client';
import { normalizeZipkinTraceId } from '@skywalking-horizon-ui/api-client';
import { wireFetch } from './wire-log.js';
import type { HorizonConfig } from '../config/schema.js';

export interface ZipkinClientOpts {
  queryUrl: string;
  timeoutMs: number;
  fetch?: FetchLike;
  /** Optional basic-auth — same shape as the GraphQL client. */
  auth?: { username: string; password: string };
}

/**
 * Build {@link ZipkinClientOpts} from the live config.
 *
 * Exists because {@link ZipkinClientOpts} and the GraphQL client's options are
 * STRUCTURALLY IDENTICAL — both are `{ queryUrl, timeoutMs, auth?, fetch? }` —
 * so handing GraphQL options to a Zipkin call type-checks cleanly and then
 * sends Zipkin requests to the GraphQL port, which answers 404.
 *
 * That is not hypothetical — `fetchZipkinList` did exactly this. It is not
 * reachable from a BUNDLED layer today: the five templates that select Zipkin
 * (mesh, mesh_cp, mesh_dp, k8s, k8s_service) are pure-`zipkin`, and a
 * pure-`zipkin` layer renders the Zipkin view, which goes through
 * `/api/zipkin/*` and resolves its base URL correctly. The broken path is
 * `/api/layer/:key/traces` with `source: zipkin | both` — a custom template
 * using `both`, or any direct API consumer.
 *
 * Build Zipkin options through here rather than reusing the GraphQL ones.
 */
export function buildZipkinOpts(cfg: HorizonConfig, fetch?: FetchLike): ZipkinClientOpts {
  return {
    queryUrl: cfg.oap.zipkinUrl,
    timeoutMs: cfg.oap.timeoutMs,
    auth: cfg.oap.auth,
    fetch,
  };
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
  /** Read the BanyanDB cold stage instead of hot+warm — OAP's own addition to
   *  the Zipkin API, honoured with `endTs`/`lookback`. */
  coldStage?: boolean;
}

/** The window and stage a by-id lookup may carry. Any one of them makes OAP
 *  build a duration, and the others then take OAP's defaults: `endTs` now,
 *  `lookback` its configured day. With none of the three the lookup is
 *  unbounded. */
export interface ZipkinTraceWindow {
  endTs?: number;
  lookback?: number;
  coldStage?: boolean;
}

const DEFAULT_LOOKBACK_MS = 30 * 60_000;

/** A non-2xx answer, with its status: a lookup by id reads OAP's 404 as
 *  "none of these ids was found" rather than as a failure. */
export class ZipkinHttpError extends Error {
  readonly status: number;
  /** The answer's body, trimmed: OAP's own 404 names the ids it did not find. */
  readonly body: string;
  constructor(status: number, message: string, body = '') {
    super(message);
    this.name = 'ZipkinHttpError';
    this.status = status;
    this.body = body;
  }
}

async function zipkinFetch<T>(opts: ZipkinClientOpts, path: string): Promise<T> {
  const f = wireFetch(opts.fetch ?? globalThis.fetch.bind(globalThis));
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
    throw new ZipkinHttpError(res.status, `zipkin ${res.status} ${url} — ${body.slice(0, 200)}`, body.trim());
  }
  return (await res.json()) as T;
}

/**
 * Summarise a zipkin trace's span array into a list-row. Zipkin
 * doesn't ship a "traces summary" endpoint; the list endpoint
 * returns `Span[][]` (one inner array per trace), so we compute
 * the headline fields ourselves from the root span — the one with no
 * parent, else the earliest. A span counts as an error when it carries an
 * `error` tag, an HTTP 5xx `http.status_code`, or `otel.status_code=ERROR`:
 * one rule for every Zipkin list, so a trace reads the same however it was
 * found.
 */
export function summariseZipkinTrace(spans: ZipkinSpan[]): ZipkinTraceListRow {
  const root = spans.find((s) => !s.parentId)
    ?? spans.slice().sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))[0]
    ?? null;
  const errorCount = spans.reduce((n, s) => {
    const t = s.tags ?? {};
    return t['error'] != null || t['http.status_code']?.startsWith('5') || t['otel.status_code'] === 'ERROR' ? n + 1 : n;
  }, 0);
  return {
    traceId: root?.traceId ?? '',
    rootName: root?.name ?? null,
    rootService: root?.localEndpoint?.serviceName ?? null,
    timestamp: root?.timestamp ?? null,
    duration: root?.duration ?? null,
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
  /** Carry each trace's spans through on the row (for a frozen, offline-replayable
   *  capture); the interactive list omits them and re-fetches on click. */
  carrySpans = false,
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
  if (query.coldStage) qs.set('coldStage', 'true');
  const path = `/api/v2/traces?${qs.toString()}`;
  const arr = await zipkinFetch<ZipkinSpan[][]>(opts, path);
  return arr
    .map((spans) => (carrySpans ? { ...summariseZipkinTrace(spans), spans } : summariseZipkinTrace(spans)))
    .filter((r) => r.traceId);
}

/** Fetch a single trace by id. Returns the full span array
 *  unmodified — the UI's zipkin waterfall renders zipkin fields
 *  natively (kind / annotations / localEndpoint / remoteEndpoint /
 *  tags map). */
export async function zipkinFetchTraceById(
  opts: ZipkinClientOpts,
  traceId: string,
  window?: ZipkinTraceWindow,
): Promise<ZipkinSpan[]> {
  const qs = zipkinWindowParams(window);
  const path = `/api/v2/trace/${encodeURIComponent(traceId)}${qs ? `?${qs}` : ''}`;
  return zipkinFetch<ZipkinSpan[]>(opts, path);
}

/** The query string of a by-id window: empty when nothing is asked. */
export function zipkinWindowParams(window: ZipkinTraceWindow | undefined): string {
  if (!window) return '';
  const qs = new URLSearchParams();
  if (typeof window.endTs === 'number' && Number.isFinite(window.endTs)) qs.set('endTs', String(window.endTs));
  if (typeof window.lookback === 'number' && Number.isFinite(window.lookback)) qs.set('lookback', String(window.lookback));
  if (window.coldStage) qs.set('coldStage', 'true');
  return qs.toString();
}

/** An operator's trace ids, normalized and without duplicates — OAP refuses
 *  the whole request on a duplicate, and `abc` and `0000000000000abc` are one
 *  id to it. The first value that is not a trace id is returned instead. */
export function parseZipkinTraceIds(raw: readonly string[]): { ids: string[] } | { invalid: string } {
  const ids: string[] = [];
  for (const value of raw) {
    if (!value.trim()) continue;
    const id = normalizeZipkinTraceId(value);
    if (!id) return { invalid: value.trim() };
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids };
}

/**
 * Look traces up by id with `/api/v2/traceMany`, within `window` when one is
 * given. With none, OAP searches everything its hot and warm stages keep (only
 * the last day on OAP 11.0.0 and earlier with BanyanDB); the cold stage is read
 * only within a window, so pass `coldStage` only with `endTs` and `lookback` —
 * alone it reads cold over OAP's default day. Each row carries its spans;
 * `missing` lists the ids OAP returned nothing for.
 */
export async function zipkinFetchTracesByIds(
  opts: ZipkinClientOpts,
  traceIds: readonly string[],
  window?: ZipkinTraceWindow,
): Promise<{ rows: ZipkinTraceListRow[]; missing: string[] }> {
  if (traceIds.length === 0) return { rows: [], missing: [] };
  const qs = new URLSearchParams({ traceIds: traceIds.join(',') });
  for (const [k, v] of new URLSearchParams(zipkinWindowParams(window))) qs.set(k, v);
  let traces: ZipkinSpan[][];
  try {
    traces = await zipkinFetch<ZipkinSpan[][]>(opts, `/api/v2/traceMany?${qs.toString()}`);
  } catch (err) {
    // OAP answers "<the traceIds it was sent> not found" when none was found.
    // Any other 404 — a wrong Zipkin URL (the GraphQL port answers 404 too), a
    // proxy's "404 page not found" — reads as a failure.
    if (err instanceof ZipkinHttpError && err.status === 404 && err.body === `${qs.get('traceIds')} not found`) {
      return { rows: [], missing: [...traceIds] };
    }
    throw err;
  }
  const rows = (Array.isArray(traces) ? traces : [])
    .map((spans) => ({ ...summariseZipkinTrace(spans), spans }))
    .filter((r) => r.traceId);
  const found = new Set(rows.map((r) => r.traceId.toLowerCase()));
  return { rows, missing: traceIds.filter((id) => !found.has(id)) };
}

/** A lookup by trace id as the list every Zipkin trace surface renders. At
 *  most `maxIds` ids: more is refused rather than trimmed. */
export async function zipkinLookupTraces(
  opts: ZipkinClientOpts,
  rawIds: readonly string[],
  maxIds: number,
  window?: ZipkinTraceWindow,
): Promise<ZipkinTraceListResponse> {
  const refuse = (error: string): ZipkinTraceListResponse => ({
    source: 'zipkin', traces: [], hasNext: false, reachable: false, error,
  });
  const parsed = parseZipkinTraceIds(rawIds);
  if ('invalid' in parsed) return refuse(`Not a Zipkin trace id: ${parsed.invalid}`);
  if (parsed.ids.length > maxIds) return refuse(`At most ${maxIds} trace ids can be looked up at once.`);
  try {
    const { rows, missing } = await zipkinFetchTracesByIds(opts, parsed.ids, window);
    return {
      source: 'zipkin',
      traces: rows,
      hasNext: false,
      reachable: true,
      ...(missing.length > 0 ? { missingTraceIds: missing } : {}),
    };
  } catch (err) {
    return refuse(err instanceof Error ? err.message : String(err));
  }
}

/** The Zipkin service universe (`localEndpoint.serviceName` of recent spans) —
 *  a flat list of names, GLOBAL (Zipkin has no layer concept). The AI assistant
 *  reads this to match a user/SkyWalking service to its Zipkin-side name. */
export async function zipkinFetchServices(opts: ZipkinClientOpts): Promise<string[]> {
  const body = await zipkinFetch<unknown>(opts, '/api/v2/services');
  return Array.isArray(body) ? (body as unknown[]).filter((s): s is string => typeof s === 'string') : [];
}
