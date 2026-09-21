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

/** The legacy single-source enum. Still READ from stored templates — never
 *  written — and resolved into {@link TraceStore} list at the edges. */
export type TraceSource = 'native' | 'zipkin' | 'both';

/**
 * One trace store a layer can expose. Named for the API that answers it, so
 * the string says which surface serves it rather than which release added it:
 *
 *  - `native`         — the SkyWalking query-protocol trace query
 *  - `zipkin`         — OAP's Zipkin v2 REST API, which also carries the
 *                       OpenTelemetry spans OAP converts into Zipkin form
 *  - `traceql-native` — the Tempo API over native spans
 *  - `traceql-zipkin` — the Tempo API over Zipkin spans
 *  - `traceql-otlp`   — the Tempo API over the OTLP spans OAP stores as they
 *                       arrived, converting nothing. It is not the same store
 *                       as `traceql-zipkin`: which of the two holds a
 *                       deployment's OTLP traces depends on whether its
 *                       receiver keeps them natively or converts them.
 */
export type TraceStore = 'native' | 'zipkin' | 'traceql-native' | 'traceql-zipkin' | 'traceql-otlp';

export const TRACE_STORES: readonly TraceStore[] = [
  'native',
  'zipkin',
  'traceql-native',
  'traceql-zipkin',
  'traceql-otlp',
];

/**
 * Per-layer traces config, at `template.traces` in the layer JSON.
 *
 * `sources` is a CHECKLIST, and there is no default: a layer that names no
 * store has no trace rows at all. Which stores exist is a fact about a
 * deployment, and guessing one produces a tab that queries a store nobody
 * writes to — an empty list that reads as "no traces" rather than "wrong
 * store". `names` overrides a row's sidebar label, because a store's useful
 * name belongs to the deployment rather than to the protocol.
 *
 * `source` is the legacy enum, accepted when reading a stored template and
 * resolved by {@link resolveTraceStores}. Nothing writes it.
 */
/**
 * Per-store settings a layer can carry.
 *
 * `serviceFilter` narrows the SERVICE PICKER, and exists because the Tempo API
 * has no notion of a layer: its service-name values are every service of the
 * underlying store — the whole GENERAL layer on the native datasource, every
 * Zipkin service on the other — so a layer that owns a subset of them has no
 * protocol-level way to say so. The pattern is matched against each candidate
 * service name; an invalid one filters nothing rather than emptying the list.
 * It shapes the picker only: filtering result rows would hide the cross-service
 * traces that are the point of having traces.
 */
export interface TraceStoreConfig {
  /** Sidebar label for this store's row. Absent uses the built-in name. */
  name?: string;
  serviceFilter?: { pattern: string; flags?: string };
}

export interface TracesConfig {
  sources?: TraceStore[];
  /** Per-store settings, keyed by store. */
  stores?: Partial<Record<TraceStore, TraceStoreConfig>>;
  /** @deprecated read-only compatibility with templates written before the list. */
  source?: TraceSource;
}

/** The longest service-filter pattern accepted, in characters. */
export const SERVICE_FILTER_MAX_PATTERN = 200;

/**
 * Whether a pattern is one the BFF will run.
 *
 * A LENGTH limit bounds nothing: `^(a+)+$` is eight characters and hangs on a
 * 28-character subject, and `^a*a*a*a*a*a*a*a*b$` takes over a second on a
 * 100-character one. The BFF matches every service name the store reports,
 * synchronously on its event loop, so one such filter stalls every other
 * request and no cancellation can interrupt it.
 *
 * Two syntactic rules, both conservative, keep a pattern linear:
 *
 *  1. No quantifier on a group that itself repeats or branches — `(a+)+`,
 *     `(a|a)*` — which is the exponential class.
 *  2. At most ONE variable-length quantifier anywhere. Two or more multiply:
 *     `a*a*…` is polynomial in the number of them, which at eight stars and a
 *     100-character name is a hang in every sense that matters.
 *
 * This is a gate, not a proof — a backtracking engine has no cheap proof. It
 * refuses safe-but-unusual shapes too, `(foo|bar)+` and `[a-z]+::.*` among
 * them. A service filter is a prefix or a small alternation, and because the
 * match is a SEARCH rather than a full match, a leading or trailing `.*` is
 * redundant and dropping it is usually all such a pattern needs.
 */
export function backtracksBadly(pattern: string): boolean {
  /** Per open group: does its body repeat or branch? Index 0 is the pattern
   *  itself and is never popped — an unbalanced `)` must not empty the stack,
   *  because this runs before anything has tried to compile the pattern. */
  const stack: Array<{ risky: boolean }> = [{ risky: false }];
  const top = () => stack[stack.length - 1]!;
  let variableQuantifiers = 0;

  /** Where a quantifier at `i` ends, or -1. `fixed` marks `{3}`, which repeats
   *  a known number of times and so multiplies nothing. */
  const quantifier = (i: number): { end: number; fixed: boolean } | null => {
    const c = pattern[i];
    if (c === '*' || c === '+' || c === '?') return { end: i + 1, fixed: false };
    if (c !== '{') return null;
    const close = pattern.indexOf('}', i);
    if (close < 0) return null;
    const body = pattern.slice(i + 1, close);
    const m = /^(\d*)(?:,(\d*))?$/.exec(body);
    if (!m || (!m[1] && !m[2])) return null;
    const fixed = m[2] === undefined;
    return { end: close + 1, fixed };
  };

  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]!;
    // An escape and a character class are each ONE unit, and the quantifier
    // that may follow is read by the shared tail below — skipping to the next
    // character here is what let `\w+` through.
    if (c === '\\') {
      i += 1;
    } else if (c === '[') {
      i += 1;
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1;
    } else if (c === '(') {
      stack.push({ risky: false });
      continue;
    } else if (c === ')') {
      const group = stack.length > 1 ? stack.pop()! : { risky: false };
      const q = quantifier(i + 1);
      if (q) {
        if (group.risky) return true;
        if (!q.fixed) variableQuantifiers += 1;
        top().risky = true;
        i = q.end - 1;
      }
      if (group.risky) top().risky = true;
      continue;
    } else if (c === '|') {
      top().risky = true;
      continue;
    }
    const q = quantifier(i + 1);
    if (q) {
      if (!q.fixed) variableQuantifiers += 1;
      top().risky = true;
      i = q.end - 1;
    }
  }
  return variableQuantifiers > 1;
}

/** Compile a store's service filter, or `null` when it has none, is longer
 *  than {@link SERVICE_FILTER_MAX_PATTERN}, backtracks exponentially, or does
 *  not compile — a broken pattern must not empty an operator's picker. */
export function serviceFilterOf(cfg: TracesConfig | null | undefined, store: TraceStore): RegExp | null {
  const raw = cfg?.stores?.[store]?.serviceFilter;
  if (!raw?.pattern) return null;
  if (raw.pattern.length > SERVICE_FILTER_MAX_PATTERN) return null;
  if (backtracksBadly(raw.pattern)) return null;
  try {
    return new RegExp(raw.pattern, raw.flags ?? '');
  } catch {
    return null;
  }
}

/**
 * The stores a traces config names. Order follows {@link TRACE_STORES}, so two
 * templates naming the same set render the same rows in the same order.
 *
 * Two fallbacks keep a template written before the checklist working unchanged:
 *
 *  - **Says nothing** — no `traces` block, or an empty one — resolves to the
 *    native store. Every template predating the checklist relied on the tab
 *    existing without describing it, and reading silence as "no trace rows"
 *    takes the Traces row off those layers.
 *  - **The legacy `source` enum** resolves to the store(s) it named, `both`
 *    to the two it covered.
 *
 * An EXPLICIT empty `sources: []` is the one way to say no stores, and it is
 * what the editor writes when every box is unticked — silence is compatibility,
 * an empty list is a decision.
 */
export function resolveTraceStores(cfg: TracesConfig | null | undefined): TraceStore[] {
  if (cfg?.sources) {
    const named = new Set(cfg.sources);
    return TRACE_STORES.filter((s) => named.has(s));
  }
  if (cfg?.source === 'native') return ['native'];
  if (cfg?.source === 'zipkin') return ['zipkin'];
  if (cfg?.source === 'both') return ['native', 'zipkin'];
  return ['native'];
}

/** Whether a layer exposes a given trace store. Reads the legacy enum too. */
export function tracesInclude(cfg: TracesConfig | null | undefined, store: TraceStore): boolean {
  return resolveTraceStores(cfg).includes(store);
}

/** Whether the layer's plain trace row is served by ZIPKIN — it exposes the
 *  Zipkin store and not the native one. The TraceQL stores each have a row of
 *  their own, so they never decide this. */
export function traceRowIsZipkin(cfg: TracesConfig | null | undefined): boolean {
  return tracesInclude(cfg, 'zipkin') && !tracesInclude(cfg, 'native');
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

/**
 * The row every trace LIST renders, whichever source produced it: a name, a
 * duration, a start and a status.
 *
 * It carries NO span model, and that is the point — one list and one
 * distribution serve native, Zipkin and TraceQL results because none of them
 * has to agree on what a span is. Each source adapts its own rows onto this
 * shape and keeps its spans to itself.
 */
export interface TraceListRow {
  key: string;
  endpointNames: string[];
  duration: number;
  start: string;
  isError: boolean;
  /** The source does not report failure, so `isError` is not an answer.
   *  Rendered as UNKNOWN — never as success, which is what a plain `false`
   *  would paint in the one colour operators do not second-guess. */
  errorUnknown?: boolean;
  traceIds: string[];
}

/** A native trace's row: the presentation row plus what the native queries add.
 *  The segmentId / traceIds pair opens the full trace through the
 *  `queryTrace`-by-id path, and `queryTraces` embeds the spans outright. */
export interface NativeTraceListRow extends TraceListRow {
  segmentId: string;
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
  /** OAP holds at least one more trace after this page — the list was capped
   *  by the operator's limit. `TraceBrief` carries no total, so this says
   *  there IS more, never how much more. */
  hasNext: boolean;
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
  /** Zipkin returned at least one more trace than the limit allowed. Zipkin's
   *  list endpoint has no count and no offset, so this is a capped flag — it
   *  says there IS more, never how much more, and there is no next page to
   *  walk to. */
  hasNext: boolean;
  reachable: boolean;
  error?: string;
  /** A lookup by trace id: the ids OAP returned no trace for. */
  missingTraceIds?: string[];
}

export interface ZipkinTraceDetailResponse {
  source: 'zipkin';
  traceId: string;
  spans: ZipkinSpan[];
  reachable: boolean;
  error?: string;
  /** OAP answered 404 for the id. Reported as unreachable as well, since a
   *  misconfigured Zipkin URL answers 404 too; a caller sure of the id can
   *  read it as "not there yet". */
  notFound?: boolean;
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
