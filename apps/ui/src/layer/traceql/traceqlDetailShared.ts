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
 * Shared bits of the TraceQL trace detail, in OTLP's own terms.
 *
 * These mirror the native trace detail's helpers deliberately — same palette,
 * same latency colours, so the two read alike — but they take OTLP spans and
 * speak OTLP's vocabulary. Nothing here maps OTLP onto SkyWalking's span
 * model: a span kind is `SPAN_KIND_SERVER`, a status is ok / error / unset,
 * and a parent is a span id string, because that is what the data is.
 */

import type { TraceQLSpan } from '@skywalking-horizon-ui/api-client';

const SERVICE_PALETTE = [
  'var(--sw-accent)', 'var(--sw-info)', 'var(--sw-cyan)', 'var(--sw-purple)',
  'var(--sw-ok)', 'var(--sw-warn)', 'var(--sw-pink)',
  '#a78bfa', '#fb7185', '#34d399', '#fbbf24', '#60a5fa',
];

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function buildServiceColors(spans: readonly TraceQLSpan[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of spans) {
    if (!m.has(s.service)) m.set(s.service, SERVICE_PALETTE[hashString(s.service) % SERVICE_PALETTE.length]!);
  }
  return m;
}

export function serviceColorFrom(colors: Map<string, string>, service: string): string {
  return colors.get(service) ?? 'var(--sw-fg-2)';
}

/**
 * An OTLP span kind, read in SkyWalking's vocabulary.
 *
 * OTLP has no entry/exit: it has client, server, producer and consumer. They
 * say the same thing from the other side — a SERVER span is where a call
 * ENTERS this service and a CLIENT span is where one LEAVES it, and messaging
 * follows: a CONSUMER span is an arrival, a PRODUCER span a departure. Every
 * other trace surface in Horizon says Entry and Exit, so these do too.
 *
 * Not translated, for the reason the native tab's `Entry` is not: it is
 * SkyWalking's enum vocabulary, which operators read across the project.
 */
export function kindLabel(kind: string): string {
  switch (kind) {
    case 'SPAN_KIND_SERVER':
    case 'SPAN_KIND_CONSUMER':
      return 'Entry';
    case 'SPAN_KIND_CLIENT':
    case 'SPAN_KIND_PRODUCER':
      return 'Exit';
    case 'SPAN_KIND_INTERNAL':
      return 'Local';
    default:
      return 'Unspecified';
  }
}

/** The protocol's own name for the kind — `server`, `consumer`, … The label
 *  above is a reading of this, not a replacement for it, so the span detail
 *  shows both and nothing about the OTLP data is lost. */
export function otlpKindName(kind: string): string {
  return kind.replace(/^SPAN_KIND_/, '').toLowerCase() || 'unspecified';
}

export function kindColor(kind: string): string {
  switch (kind) {
    case 'SPAN_KIND_SERVER': return 'var(--sw-accent)';
    case 'SPAN_KIND_CLIENT': return 'var(--sw-info)';
    case 'SPAN_KIND_PRODUCER':
    case 'SPAN_KIND_CONSUMER': return 'var(--sw-purple)';
    // Purple, as the native detail paints a Local span — the glyph beside it
    // is the same ring, so the colour must not say something else.
    case 'SPAN_KIND_INTERNAL': return 'var(--sw-purple)';
    default: return 'var(--sw-fg-2)';
  }
}

/** The direction an OTLP kind describes, for the shared glyph. Messaging keeps
 *  its own two shapes: a consumer span reads Entry, but it is an envelope
 *  arriving rather than a call, and the picture should say which. */
export function kindGlyphFamily(kind: string): 'entry' | 'exit' | 'local' | 'producer' | 'consumer' | 'other' {
  switch (kind) {
    case 'SPAN_KIND_SERVER': return 'entry';
    case 'SPAN_KIND_CLIENT': return 'exit';
    case 'SPAN_KIND_PRODUCER': return 'producer';
    case 'SPAN_KIND_CONSUMER': return 'consumer';
    case 'SPAN_KIND_INTERNAL': return 'local';
    default: return 'other';
  }
}

export function statusColor(status: TraceQLSpan['status']): string {
  if (status === 'error') return 'var(--sw-err)';
  if (status === 'ok') return 'var(--sw-ok)';
  // UNSET is not success: the Zipkin converter defaults to it.
  return 'var(--sw-fg-3)';
}

export function fmtMs(us: number): string {
  const ms = us / 1000;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 1) return `${ms.toFixed(1)} ms`;
  return `${us} µs`;
}

export function fmtDateTime(us: number): string {
  const d = new Date(us / 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function latencyColor(durationUs: number): string {
  const ms = durationUs / 1000;
  if (ms >= 1000) return 'var(--sw-err)';
  if (ms >= 300) return 'var(--sw-warn)';
  return 'var(--sw-ok)';
}

/**
 * The query key the TraceQL rows share a trace with.
 *
 * Deliberately NOT `traceId`: that one belongs to the native and Zipkin
 * popouts, which are reachable from a TraceQL page too — the AI panel's log
 * rows link to them. A TraceQL page claiming `traceId` read those ids through
 * the Tempo API, which is the wrong trace in the wrong renderer, and dropped
 * the timestamp hint the popout needs for an old id.
 */
export const TRACEQL_POPOUT_QUERY = 'traceqlId';

export interface SpanTreeRow {
  span: TraceQLSpan;
  depth: number;
  /** Offset from the trace's earliest span, in microseconds. */
  offsetUs: number;
  /** The span's position in the trace as it arrived — a render identity, since
   *  two Zipkin records can share one `spanId`. Never shown. */
  key: number;
}

/**
 * Depth-first order with each span's offset, built from OTLP parentage —
 * `parentSpanId` against `spanId`, both opaque strings. A span whose parent is
 * absent from the set is a root, which is how a partial trace still renders.
 *
 * Identity is a span's POSITION, not its id. A Zipkin client and server span
 * legitimately share one span id and OAP's converter keeps both records, so
 * keying on the id drops the second from the waterfall while the header and the
 * statistics go on counting it. The first record with an id owns that id's
 * children, or a shared id would draw its whole subtree twice.
 */
export function buildSpanTree(spans: readonly TraceQLSpan[]): SpanTreeRow[] {
  if (spans.length === 0) return [];
  const firstWithId = new Map<string, number>();
  spans.forEach((s, i) => { if (!firstWithId.has(s.spanId)) firstWithId.set(s.spanId, i); });

  const children = new Map<string, number[]>();
  const roots: number[] = [];
  spans.forEach((s, i) => {
    // A span that is its own parent is a root; anything else is parented when
    // the id it names is in this set.
    if (s.parentSpanId && s.parentSpanId !== s.spanId && firstWithId.has(s.parentSpanId)) {
      const arr = children.get(s.parentSpanId) ?? [];
      arr.push(i);
      children.set(s.parentSpanId, arr);
    } else {
      roots.push(i);
    }
  });
  const byStart = (a: number, b: number) => spans[a]!.startUs - spans[b]!.startUs;
  for (const arr of children.values()) arr.sort(byStart);
  roots.sort(byStart);

  const minStart = Math.min(...spans.map((s) => s.startUs));
  const out: SpanTreeRow[] = [];
  const seen = new Set<number>();
  function walk(i: number, depth: number): void {
    // A cycle cannot happen in a well-formed trace, but a malformed one must
    // not hang the page.
    if (seen.has(i)) return;
    seen.add(i);
    const s = spans[i]!;
    out.push({ span: s, depth, offsetUs: s.startUs - minStart, key: i });
    if (firstWithId.get(s.spanId) !== i) return;
    for (const c of children.get(s.spanId) ?? []) walk(c, depth + 1);
  }
  for (const r of roots) walk(r, 0);
  // Malformed parentage — a cycle — leaves a component with no root. Walking
  // only from roots would drop those spans silently while the header and the
  // statistics still counted them, so each remaining component is entered at
  // its earliest span and shown at depth 0.
  if (out.length < spans.length) {
    for (const i of spans.map((_, n) => n).sort(byStart)) walk(i, 0);
  }
  return out;
}

/** The trace's own span, if it has one: the root of the tree. */
export function rootSpanOf(spans: readonly TraceQLSpan[]): TraceQLSpan | null {
  const byId = new Set(spans.map((s) => s.spanId));
  return spans.find((s) => !s.parentSpanId || !byId.has(s.parentSpanId)) ?? spans[0] ?? null;
}
