// Licensed to the Apache Software Foundation (ASF) under one or more
// contributor license agreements.  See the NOTICE file distributed with
// this work for additional information regarding copyright ownership.
// The ASF licenses this file to You under the Apache License, Version 2.0
// (the "License"); you may not use this file except in compliance with
// the License.  You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Shared span-render primitives for the native trace-detail views
// (default waterfall, tree, statistics, span modal). Kept feature-local
// to the trace-detail card so its sub-views share one colour palette and
// one set of kind/latency/format helpers without re-deriving them.

import type { NativeSpan } from '@/api/client';
import { fmtMetric } from '@/utils/formatters';

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
  return (h >>> 0);
}

/** Deterministic service → palette colour map for one trace's spans. */
export function buildServiceColors(spans: NativeSpan[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of spans) {
    if (!m.has(s.serviceCode)) {
      m.set(s.serviceCode, SERVICE_PALETTE[hashString(s.serviceCode) % SERVICE_PALETTE.length]);
    }
  }
  return m;
}

export function serviceColorFrom(colors: Map<string, string>, c: string): string {
  return colors.get(c) ?? 'var(--sw-fg-2)';
}

export function kindColor(type: string | null | undefined): string {
  const k = (type ?? '').toUpperCase();
  if (k.includes('SERVER') || k === 'ENTRY') return 'var(--sw-accent)';
  if (k.includes('CLIENT') || k === 'EXIT') return 'var(--sw-info)';
  if (k === 'LOCAL') return 'var(--sw-purple)';
  if (k.includes('PRODUCER') || k.includes('CONSUMER')) return 'var(--sw-purple)';
  if (k.includes('DATABASE') || k.includes('SQL') || k.includes('CACHE')) return 'var(--sw-cyan)';
  return 'var(--sw-fg-2)';
}

/**
 * Span-kind family — Entry, Local, Exit, plus the GraphQL-spelled
 * Server/Client/Producer/Consumer set. Drives the inline SVG glyph.
 */
export type KindFamily = 'entry' | 'local' | 'exit' | 'server' | 'client' | 'producer' | 'consumer' | 'other';
export function kindFamily(type: string | null | undefined): KindFamily {
  const k = (type ?? '').toUpperCase();
  if (k === 'ENTRY' || k.includes('SERVER')) return 'entry';
  if (k === 'EXIT' || k.includes('CLIENT')) return 'exit';
  if (k === 'LOCAL') return 'local';
  if (k.includes('PRODUCER')) return 'producer';
  if (k.includes('CONSUMER')) return 'consumer';
  return 'other';
}

export function fmtMs(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return `${fmtMetric(v)} ms`;
}

export function fmtDateTime(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtAttachedTs(at: { seconds: number; nanos: number }): string {
  const ms = at.seconds * 1000 + at.nanos / 1_000_000;
  return fmtDateTime(ms) + '.' + String(at.nanos).padStart(9, '0').slice(0, 6);
}

/**
 * Latency-band color for tree nodes. Cool-to-warm gradient topping
 * out at the accent orange — red is reserved for actual error states
 * (isError === true), not slow successful spans.
 */
export function latencyColor(durationMs: number): string {
  if (durationMs >= 1000) return 'var(--sw-accent)';
  if (durationMs >= 500) return 'var(--sw-warn)';
  if (durationMs >= 100) return 'var(--sw-info)';
  return 'var(--sw-ok)';
}
