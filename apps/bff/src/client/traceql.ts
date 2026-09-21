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
 * REST client for OAP's TraceQL service — the Tempo query API, served by a
 * separate HTTP server (default port 3200) with one context path per
 * datasource. Each datasource is configured as a full URL, so this client
 * never assembles OAP's path layout.
 *
 *   GET <base>/api/status/buildinfo
 *   GET <base>/api/search?q&start&end&limit
 *   GET <base>/api/v2/search/tags?start&end
 *   GET <base>/api/v2/search/tag/{tagName}/values?q&start&end
 *   GET <base>/api/v2/traces/{traceId}?start&end
 *
 * Two things about this API differ from every other OAP surface, and both
 * live here so nothing above has to remember them:
 *
 *   1. `start` / `end` are UNIX **seconds**. Horizon speaks milliseconds
 *      everywhere else (and formatted date strings to native GraphQL).
 *   2. On the native datasource a trace id is hex-encoded UTF-8, because
 *      Tempo requires hex trace ids. The encoded form is a wire detail that
 *      NEVER crosses the BFF boundary in either direction: requests leave
 *      encoded, responses are decoded before they are returned. Span ids are
 *      NOT encoded, even though they sit beside an encoded trace id in the
 *      same object. Zipkin ids are already hex and are left alone.
 */

import type {
  FetchLike,
  TraceQLDatasource,
  TraceQLServiceEntry,
  TraceQLSpan,
  TraceQLTagScope,
  TraceQLTraceRow,
} from '@skywalking-horizon-ui/api-client';
import { attributesReportError } from '@skywalking-horizon-ui/api-client';
import { wireFetch } from './wire-log.js';
import type { HorizonConfig } from '../config/schema.js';

/**
 * Where a datasource answers: the one TraceQL endpoint plus that datasource's
 * context path. An empty endpoint, or an empty path, means this deployment
 * does not serve it — the caller reports that as "not configured" rather than
 * probing a URL nobody enabled.
 */
export function traceqlUrlFor(cfg: HorizonConfig, ds: TraceQLDatasource): string {
  const { url, nativePath, zipkinPath, otlpPath } = cfg.oap.traceql;
  const path = { native: nativePath, zipkin: zipkinPath, otlp: otlpPath }[ds];
  if (!url || !path) return '';
  return `${url.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export interface TraceQLClientOpts {
  /** Full base URL including OAP's context path, e.g. `http://oap:3200/skywalking`. */
  baseUrl: string;
  ds: TraceQLDatasource;
  timeoutMs: number;
  fetch?: FetchLike;
  auth?: { username: string; password: string };
  /** The caller's cancellation. Read routes pass the client's; a probe that
   *  was cancelled measured nothing, so its result must not be cached. */
  signal?: AbortSignal;
}

/** Resolve a datasource's options, or `null` when no URL is configured —
 *  which is how a source is turned off. */
export function buildTraceQLOpts(
  cfg: HorizonConfig,
  ds: TraceQLDatasource,
  fetch?: FetchLike,
  signal?: AbortSignal,
): TraceQLClientOpts | null {
  const baseUrl = traceqlUrlFor(cfg, ds);
  if (!baseUrl) return null;
  return {
    baseUrl,
    ds,
    timeoutMs: cfg.oap.timeoutMs,
    fetch,
    auth: cfg.oap.auth,
    ...(signal ? { signal } : {}),
  };
}

/** A non-2xx answer with its status. 404 on a by-id read means the trace was
 *  not found; every other status is a failure worth surfacing, including the
 *  400 whose body carries OAP's own message for a refused expression. */
export class TraceQLHttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, message: string, body = '') {
    super(message);
    this.name = 'TraceQLHttpError';
    this.status = status;
    this.body = body;
  }
}

/** OAP answers a refused expression with `{"error":"…"}`. */
function errorMessageOf(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === 'string' ? parsed.error : null;
  } catch {
    return null;
  }
}

async function traceqlFetch<T>(
  opts: TraceQLClientOpts,
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<T> {
  const f = wireFetch(opts.fetch ?? globalThis.fetch.bind(globalThis));
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const url = opts.baseUrl.replace(/\/$/, '') + path + suffix;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.auth) {
    const raw = `${opts.auth.username}:${opts.auth.password}`;
    headers.authorization = `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
  }
  // Combined rather than chosen between: the caller's cancellation must not
  // discard this client's own timeout.
  const signal = opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal;
  // The timer covers the BODY as well as the headers: a native search embeds
  // every span of every trace, so the bytes are where the time actually goes.
  try {
    const res = await f(url, { method: 'GET', headers, signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const detail = errorMessageOf(body) ?? body.slice(0, 200);
      throw new TraceQLHttpError(res.status, `traceql ${res.status} ${url} — ${detail}`, body.trim());
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Milliseconds to the UNIX seconds this API takes. */
function toSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

/* ---------------------------------------------------------------- trace ids */

/** Native only: hex of the id's UTF-8 bytes, which is what Tempo requires. */
export function encodeNativeTraceId(traceId: string): string {
  return Buffer.from(traceId, 'utf8').toString('hex');
}

/** Inverse of {@link encodeNativeTraceId}. Only ever applied to an id that
 *  CAME from the native datasource, which is always encoded — so there is no
 *  guessing to do, and a hex id that decodes to nothing sensible is returned
 *  unchanged rather than mangled. */
export function decodeNativeTraceId(encoded: string): string {
  if (!/^(?:[0-9a-f]{2})+$/i.test(encoded)) return encoded;
  const bytes = Buffer.from(encoded, 'hex');
  const decoded = bytes.toString('utf8');
  // Round-tripping proves the bytes were valid UTF-8 rather than an id that
  // merely looked like hex.
  return Buffer.from(decoded, 'utf8').equals(bytes) ? decoded : encoded;
}

/** What to put on the wire. The caller holds a REAL id — that is the
 *  invariant — so this always encodes on the native datasource. A hex id
 *  pasted out of Grafana is handled by {@link traceqlTraceById}'s retry, not
 *  by guessing here: a guess that gets it wrong fails a valid lookup silently,
 *  which is the worse of the two errors. */
export function wireTraceId(ds: TraceQLDatasource, traceId: string): string {
  return ds === 'native' ? encodeNativeTraceId(traceId) : traceId;
}

/** What to show for an id that came off the wire. */
export function displayTraceId(ds: TraceQLDatasource, traceId: string): string {
  return ds === 'native' ? decodeNativeTraceId(traceId) : traceId;
}

/* ------------------------------------------------------------- wire shapes */

/** OTLP/JSON `AnyValue`. Every field is optional and exactly one is set.
 *
 *  Only the `/otlp` datasource uses more than `stringValue`: it serves the
 *  spans as the SDK exported them, so an attribute keeps its own type. The
 *  Zipkin and SkyWalking datasources convert everything to a string on the way
 *  out, which is why reading `stringValue` alone worked until `/otlp` existed
 *  — against it, every number and boolean simply vanished from the span. */
interface WireAnyValue {
  stringValue?: string;
  /** int64, so proto3 JSON renders it as a decimal STRING, not a number. */
  intValue?: string | number;
  boolValue?: boolean;
  doubleValue?: number;
  bytesValue?: string;
  arrayValue?: { values?: WireAnyValue[] };
  kvlistValue?: { values?: Array<{ key?: string; value?: WireAnyValue }> };
}

interface WireAttribute {
  key: string;
  value?: WireAnyValue;
}

interface WireSearchSpan {
  spanID?: string;
  startTimeUnixNano?: string;
  durationNanos?: string;
  attributes?: WireAttribute[];
}

interface WireSearchTrace {
  traceID?: string;
  rootServiceName?: string;
  rootTraceName?: string;
  startTimeUnixNano?: string;
  durationMs?: number;
  spanSets?: Array<{ spans?: WireSearchSpan[]; matched?: number }>;
  /** Span and error counts per service over the WHOLE trace, which the span
   *  sets are not: they hold the spans that matched, capped at `spss`. */
  serviceStats?: Record<string, { spanCount?: number; errorCount?: number }>;
}

interface WireSearchResponse {
  traces?: WireSearchTrace[];
}

interface WireOtlpSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  kind?: string;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes?: WireAttribute[];
  events?: Array<{ timeUnixNano?: string; name?: string; attributes?: WireAttribute[] }>;
  status?: { code?: string; message?: string };
}

interface WireOtlpResponse {
  trace?: {
    resourceSpans?: Array<{
      resource?: { attributes?: WireAttribute[] };
      scopeSpans?: Array<{ scope?: { name?: string; version?: string }; spans?: WireOtlpSpan[] }>;
    }>;
  };
}

interface WireTagsV2Response {
  scopes?: Array<{ name?: string; tags?: string[] }>;
}

interface WireTagValuesResponse {
  tagValues?: Array<{ type?: string; value?: string }>;
}

export interface TraceQLBuildInfo {
  version: string;
}

/**
 * One attribute value as text, whatever type it arrived as.
 *
 * The UI renders attributes as text and filters on them as text, so the type
 * is flattened here rather than carried through every view. A number keeps its
 * decimal spelling (an int64 already arrives as a string, and must not go
 * through `Number` — beyond 2^53 that loses digits), a boolean becomes
 * `true`/`false`, and the two composite kinds are rendered as JSON so a
 * `http.request.header.accept` array reads as a list rather than as nothing.
 *
 * Returns undefined when no field is set, which is not the same as an empty
 * string — see the span-status table on why that distinction matters.
 */
function attrText(v: WireAnyValue | undefined): string | undefined {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return String(v.intValue);
  if (v.boolValue !== undefined) return String(v.boolValue);
  if (v.doubleValue !== undefined) return String(v.doubleValue);
  if (v.bytesValue !== undefined) return v.bytesValue;
  if (v.arrayValue) return JSON.stringify((v.arrayValue.values ?? []).map(attrText));
  if (v.kvlistValue) {
    return JSON.stringify(Object.fromEntries(
      (v.kvlistValue.values ?? []).map((e) => [e.key ?? '', attrText(e.value)]),
    ));
  }
  return undefined;
}

/** Attributes as they arrive: a LIST, which may repeat a key. OAP emits
 *  `net.host.ip` twice when an endpoint has both IPv4 and IPv6, so folding
 *  this into an object silently keeps only the last one. */
function attrList(attrs: WireAttribute[] | undefined): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const a of attrs ?? []) {
    const value = attrText(a.value);
    if (a.key && value !== undefined) out.push({ key: a.key, value });
  }
  return out;
}

/** First value for a key — for the few derived reads (service name, kind)
 *  where one value is what the caller means. */
function attrOf(attrs: WireAttribute[] | undefined, key: string): string | undefined {
  return attrText(attrs?.find((a) => a.key === key)?.value);
}

function num(raw: string | number | undefined): number {
  const n = typeof raw === 'number' ? raw : Number(raw ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/* ----------------------------------------------------------------- queries */

export async function traceqlBuildInfo(opts: TraceQLClientOpts): Promise<TraceQLBuildInfo> {
  const raw = await traceqlFetch<{ version?: string }>(opts, '/api/status/buildinfo');
  return { version: raw.version ?? '' };
}

export interface TraceQLSearchQuery {
  /** The TraceQL expression, verbatim. Empty means the bare `{}` match-all. */
  q?: string;
  startMs: number;
  endMs: number;
  limit: number;
}

/**
 * Search, reduced.
 *
 * The native datasource returns EVERY span of every matched trace with no
 * cap (`spss` is accepted and ignored upstream), so a page can be tens of
 * thousands of span objects. Nothing above needs them: the row keeps the
 * summary, the span count and the services touched, and the detail call
 * fetches spans when a trace is actually opened.
 */
export async function traceqlSearch(
  opts: TraceQLClientOpts,
  query: TraceQLSearchQuery,
): Promise<TraceQLTraceRow[]> {
  const raw = await traceqlFetch<WireSearchResponse>(opts, '/api/search', {
    q: query.q && query.q.trim() ? query.q.trim() : undefined,
    start: toSeconds(query.startMs),
    end: toSeconds(query.endMs),
    limit: query.limit,
  });
  const focus = focusServiceOf(query.q);
  return (raw.traces ?? []).map((t) => toRow(opts.ds, t, focus));
}

/**
 * The service a query is about, if it names one.
 *
 * Read off the expression rather than passed in, so a hand-written query gets
 * the same treatment as one the builder produced. Only the equality form is
 * recognised, which is the only form this backend honours anyway.
 */
export function focusServiceOf(q: string | undefined): string | null {
  if (!q) return null;
  const m = /(?:^|[{\s&|(])\.?(?:resource\.)?service(?:\.name)?\s*=\s*"([^"]+)"/.exec(q);
  return m ? m[1] : null;
}

/** Whether OAP counted a failure anywhere in the trace. `serviceStats` counts
 *  the WHOLE trace, unlike a span set, so a count above zero settles it — on
 *  the datasources whose counting rule Horizon shares.
 *
 *  ZIPKIN IS NOT ONE OF THEM. `ZipkinOTLPConverter` counts a span whose tags
 *  merely CONTAIN `error`, whatever its value, so `error="false"` — a span
 *  reporting success — counts as one. Horizon reads that value and calls it
 *  ok, so trusting the count there paints a healthy trace failed and settles
 *  the row, which stops anything from opening it and finding out.
 *
 *  A count of ZERO settles nothing anywhere, which is why this answers a
 *  boolean. OAP counts by its own rule while Horizon reads a wider set of
 *  markers when it opens the trace: a Zipkin span carrying an HTTP 503 and no
 *  `error` tag is zero errors, and the default projection omits the status
 *  code, so the response says nothing either way. */
function traceWideFailure(ds: TraceQLDatasource, t: WireSearchTrace): boolean {
  if (ds === 'zipkin') return false;
  for (const s of Object.values(t.serviceStats ?? {})) {
    if ((s.errorCount ?? 0) > 0) return true;
  }
  return false;
}

function toRow(ds: TraceQLDatasource, t: WireSearchTrace, focus: string | null): TraceQLTraceRow {
  const spans = (t.spanSets ?? []).flatMap((s) => s.spans ?? []);
  const traceStartNs = num(t.startTimeUnixNano);
  const services: string[] = [];
  let anyError = false;
  let entry: TraceQLServiceEntry | undefined;
  let entryStartNs: number | null = null;
  for (const s of spans) {
    const svc = attrOf(s.attributes, 'service.name');
    if (svc && !services.includes(svc)) services.push(svc);
    // OAP projects a `status` onto every search-result span — `error`, `ok` or
    // `unset` — so a list can show failures without reading each trace. Older
    // OAPs send none, and then failure is read from whichever of the known
    // markers the span happens to carry. `emptyIsAbsent` because THIS response
    // is padded: OAP writes every projected key on every span of a span set,
    // the missing ones as `""`.
    // The projected `status` carries the SAME Zipkin rule as the counts: the
    // converter writes `error` when the tags merely contain the key, so a span
    // that wrote `error="false"` is projected as failed. Horizon reads that
    // value and calls it ok, so on that datasource the projection is not a
    // verdict either — the row is left to be read.
    const listed = ds === 'zipkin' ? undefined : attrOf(s.attributes, 'status');
    if (listed === 'error') anyError = true;
    else if (listed !== 'ok' && !anyError
      && attributesReportError(attrList(s.attributes), { emptyIsAbsent: true })) anyError = true;
    if (focus && svc === focus) {
      const startNs = num(s.startTimeUnixNano);
      // The service's FIRST span — where it enters the trace. A service can be
      // re-entered, and summing its spans would double-count nested ones.
      // Compared in NANOSECONDS: the stored offset is rounded to ms, so
      // comparing against it picks the wrong span for sub-millisecond gaps.
      if (entryStartNs === null || startNs < entryStartNs) {
        entryStartNs = startNs;
        entry = {
          service: svc,
          offsetMs: Math.max(0, Math.round((startNs - traceStartNs) / 1e6)),
          durationMs: Math.round(num(s.durationNanos) / 1e6),
          kind: attrOf(s.attributes, 'span.kind') ?? '',
        };
      }
    }
  }
  return {
    traceId: displayTraceId(ds, t.traceID ?? ''),
    rootService: t.rootServiceName ?? '',
    rootName: t.rootTraceName ?? '',
    startMs: Math.round(traceStartNs / 1e6),
    durationMs: num(t.durationMs),
    spanCount: spans.length,
    services,
    serviceEntry: entry,
    // A search settles FAILURE and nothing else. `undefined` is UNKNOWN, and
    // the list reads those traces one at a time — which is the only place a
    // trace is judged whole, by Horizon's own rules, against every span.
    isError: anyError || traceWideFailure(ds, t) ? true : undefined,
  };
}

export interface TraceQLTraceDetail {
  traceId: string;
  spans: TraceQLSpan[];
}

/**
 * Trace detail as a flat span list, parent linkage intact.
 *
 * `startMs` / `endMs` are optional: omitting them makes the native
 * datasource search from 2020 and makes Zipkin ignore the window entirely,
 * which is what a lookup with no time range wants.
 */
export async function traceqlTraceById(
  opts: TraceQLClientOpts,
  traceId: string,
  window?: { startMs: number; endMs: number },
): Promise<TraceQLTraceDetail | null> {
  const wireId = wireTraceId(opts.ds, traceId);
  let raw: WireOtlpResponse;
  try {
    raw = await traceqlFetch<WireOtlpResponse>(opts, `/api/v2/traces/${encodeURIComponent(wireId)}`, {
      start: window ? toSeconds(window.startMs) : undefined,
      end: window ? toSeconds(window.endMs) : undefined,
    });
  } catch (e) {
    if (e instanceof TraceQLHttpError && e.status === 404) return null;
    throw e;
  }
  const spans: TraceQLSpan[] = [];
  for (const rs of raw.trace?.resourceSpans ?? []) {
    const resourceAttributes = attrList(rs.resource?.attributes);
    const service = attrOf(rs.resource?.attributes, 'service.name') ?? '';
    for (const ss of rs.scopeSpans ?? []) {
      for (const s of ss.spans ?? []) {
        const startNs = num(s.startTimeUnixNano);
        const endNs = num(s.endTimeUnixNano);
        spans.push({
          spanId: s.spanId ?? '',
          parentSpanId: s.parentSpanId ?? '',
          service,
          resourceAttributes,
          ...(ss.scope?.name ? { scopeName: ss.scope.name } : {}),
          ...(ss.scope?.version ? { scopeVersion: ss.scope.version } : {}),
          name: s.name ?? '',
          kind: s.kind ?? '',
          startUs: Math.round(startNs / 1000),
          durationUs: Math.max(0, Math.round((endNs - startNs) / 1000)),
          // OTLP has three states and UNSET is not success — the Zipkin
          // converter defaults to it, so collapsing it to `false` would paint
          // every unknown span green.
          status: s.status?.code === 'STATUS_CODE_ERROR' ? 'error'
            : s.status?.code === 'STATUS_CODE_OK' ? 'ok' : 'unset',
          statusMessage: s.status?.message || undefined,
          attributes: attrList(s.attributes),
          events: (s.events ?? []).map((ev) => ({
            timeUs: Math.round(num(ev.timeUnixNano) / 1000),
            name: ev.name ?? '',
            attributes: attrList(ev.attributes),
          })),
        });
      }
    }
  }
  if (spans.length === 0) return null;
  // The caller passed the REAL id, so it is returned unchanged — decoding it
  // again would mangle an id that merely looks like hex.
  return { traceId, spans };
}

export async function traceqlTags(
  opts: TraceQLClientOpts,
  window: { startMs: number; endMs: number },
): Promise<TraceQLTagScope[]> {
  const raw = await traceqlFetch<WireTagsV2Response>(opts, '/api/v2/search/tags', {
    start: toSeconds(window.startMs),
    end: toSeconds(window.endMs),
  });
  return (raw.scopes ?? []).map((s) => ({ name: s.name ?? '', tags: s.tags ?? [] }));
}

/**
 * Values for one tag.
 *
 * The tag name has to reach OAP in the form its handler switches on:
 * `resource.service.name` and `status` are special-cased, ordinary tags want
 * the `span.` prefix, and `name` / `resource.instance` / `resource.remote.service`
 * need a service-bearing `q` or they answer empty by design.
 */
export async function traceqlTagValues(
  opts: TraceQLClientOpts,
  tag: string,
  window: { startMs: number; endMs: number },
  q?: string,
): Promise<string[]> {
  const raw = await traceqlFetch<WireTagValuesResponse>(
    opts,
    `/api/v2/search/tag/${encodeURIComponent(tag)}/values`,
    {
      q: q && q.trim() ? q.trim() : undefined,
      start: toSeconds(window.startMs),
      end: toSeconds(window.endMs),
    },
  );
  return (raw.tagValues ?? []).map((v) => v.value ?? '').filter((v) => v !== '');
}
