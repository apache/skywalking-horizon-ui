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
 * Per-DSL helpers that narrow the unified `SessionSample` payload union.
 *
 * The wire collapsed the per-DSL stage vocabulary into five sample
 * types (`input | filter | function | aggregation | output`); each
 * view already knows its catalog (it picks one from the picker), so
 * the discriminator is just `sample.type` + the contextual catalog.
 *
 * MAL / LAL / OAL all share the five-type vocabulary but emit
 * different `payload` shapes inside each sample. These predicates let
 * the views narrow without an `as` cast leaking everywhere.
 */

import type {
  LalSamplePayload,
  MalOutputPayload,
  MalSamplesPayload,
  OalMetricsPayload,
  OalSourcePayload,
  SamplePayload,
  SampleType,
  SessionSample,
} from '@skywalking-horizon-ui/api-client';

// ─── MAL ───────────────────────────────────────────────────────────

/** MAL non-output payload — `SampleFamily.toJson()` shape. Identified
 *  by the presence of `samples` / `empty` / `items`. The MAL
 *  file-level filter probe additionally emits a `families` count and
 *  nests `items[]` as per-family sub-payloads, which we treat as the
 *  same shape (`isMalSamplesPayload` accepts either). */
export function isMalSamplesPayload(p: SamplePayload | undefined): p is MalSamplesPayload {
  if (typeof p !== 'object' || p === null) return false;
  return 'samples' in p || 'empty' in p || 'families' in p || 'items' in p;
}

/** MAL `output`-type payload — the materialised metric. Identified by
 *  the presence of `metric` + `entity`. */
export function isMalOutputPayload(p: SamplePayload | undefined): p is MalOutputPayload {
  if (typeof p !== 'object' || p === null) return false;
  return 'metric' in p && 'entity' in p;
}

// ─── LAL ───────────────────────────────────────────────────────────

/** LAL sample payload — every stage carries the same `{aborted,
 *  hasParsed, input?, output?, parsedKeys?}` envelope. Identified by
 *  the presence of `aborted` / `hasParsed` (non-trivial samples) or
 *  by carrying a typed `input` / `output` slot. */
export function isLalSamplePayload(p: SamplePayload | undefined): p is LalSamplePayload {
  if (typeof p !== 'object' || p === null) return false;
  return 'aborted' in p || 'hasParsed' in p || 'input' in p || 'output' in p || 'parsedKeys' in p;
}

// ─── OAL ───────────────────────────────────────────────────────────

/** OAL input / filter payload — the source object with `fields.scope`. */
export function isOalSourcePayload(p: SamplePayload | undefined): p is OalSourcePayload {
  if (typeof p !== 'object' || p === null) return false;
  if (!('type' in p) || !('fields' in p)) return false;
  const fields = (p as { fields: unknown }).fields;
  return typeof fields === 'object' && fields !== null;
}

/** OAL function / aggregation / output payload — the metric class's
 *  toJson. Identified by `type` + `timeBucket` (every metric carries
 *  it) without nested `fields`. */
export function isOalMetricsPayload(p: SamplePayload | undefined): p is OalMetricsPayload {
  if (typeof p !== 'object' || p === null) return false;
  if (!('type' in p)) return false;
  if ('fields' in p) return false;
  return 'timeBucket' in p || 'value' in p || 'total' in p;
}

// ─── Tone ──────────────────────────────────────────────────────────

/** Short-form a SHA-256 hex into the first 8 chars (or `—` when empty). */
export function shortHash(h: string | undefined | null): string {
  if (!h) return '—';
  return h.slice(0, 8);
}

/** Trim a captured sample value for display. Integers (the common
 *  counter case — `3692965`) render exact; floats that arrive as long
 *  repeating decimals from `rate()` / `avg()` (`57.03333333333…`,
 *  `0.66666666…`) collapse to ≤4 significant digits so they stop
 *  overflowing the value column. Non-finite sentinels (`NaN`,
 *  `Infinity`) pass through verbatim. Callers keep the precise value on
 *  a `title` so nothing is lost — this is display-only rounding. */
export function formatSampleValue(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return String(v);
  const abs = Math.abs(v);
  // ≥1 → cap at 4 decimals; <1 → 4 significant figures so tiny rates
  // don't round to a misleading 0. `String()` drops trailing zeros.
  return String(abs >= 1 ? Math.round(v * 1e4) / 1e4 : Number(v.toPrecision(4)));
}

/** Pill tone for a sample-type badge. Centralised across MAL / LAL /
 *  OAL views so a tone tweak lands in one place.
 *
 *  Tones reflect pipeline progression: `input` is the entry point
 *  (ok); `filter` is the gate (warn); transforms / builders are info;
 *  the L1-bound terminal `output` is active so operators' eyes catch
 *  it; `aggregation` (OAL-only) is info. */
export function sampleTone(t: SampleType): 'ok' | 'warn' | 'info' | 'dim' | 'active' {
  switch (t) {
    case 'output':
      return 'active';
    case 'aggregation':
    case 'function':
      return 'info';
    case 'filter':
      return 'warn';
    case 'input':
      return 'ok';
    default:
      return 'dim';
  }
}

/** Tone for a sample's `continueOn` flag — operators read at-a-glance
 *  whether the pipeline kept going past this probe. */
export function continueTone(continueOn: boolean): 'ok' | 'warn' {
  return continueOn ? 'ok' : 'warn';
}

/** True when the sample fired against an empty SampleFamily (MAL only).
 *  Used to dim such rows in the waterfall — they're informative but
 *  trivial. */
export function isEmptySample(sample: SessionSample): boolean {
  const p = sample.payload;
  if (typeof p !== 'object' || p === null) return false;
  return (p as { empty?: boolean }).empty === true;
}

// ─── Highlight ─────────────────────────────────────────────────────

export interface Segment {
  text: string;
  highlight: boolean;
}

/** Split a rule field into highlight / plain segments around every
 *  exact occurrence of the selected step's `sourceText`. Drives the
 *  inline `<mark>` collaborative highlight inside the captured DSL —
 *  clicking a step lights up the matching expression in the rule
 *  statement above the chain. */
export function highlightSegments(text: string | undefined, fragment: string): Segment[] {
  if (!text) return [];
  if (fragment === '') return [{ text, highlight: false }];
  const segments: Segment[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const at = text.indexOf(fragment, cursor);
    if (at < 0) {
      segments.push({ text: text.slice(cursor), highlight: false });
      break;
    }
    if (at > cursor) segments.push({ text: text.slice(cursor, at), highlight: false });
    segments.push({ text: fragment, highlight: true });
    cursor = at + fragment.length;
  }
  return segments;
}
