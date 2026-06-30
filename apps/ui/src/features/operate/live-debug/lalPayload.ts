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
 * Pure payload→view helpers + view-model types behind the LAL
 * live-debugger view (`DebugLal.vue`). Zero Vue dependencies — every
 * function here is a deterministic transform over the wire payload
 * shapes; the view owns the reactive graph and passes the narrowed
 * payloads in.
 *
 * Each LAL execution is one `SessionRecord` whose `samples[]` walk
 * `input → function → output`. Sample payloads carry the unified
 * envelope `{aborted, hasParsed, input?, output?, parsedKeys}` —
 * `input` populated on the first sample (raw `LogData` / `Message`),
 * `output` populated on every sample after `bindInput` (the
 * `LogBuilder` snapshot, including the merged `tags[]` with
 * `original | lal-added | lal-override` status).
 */

import type {
  LalLogBuilderOutput,
  LalLogBuilderTag,
  LalLogDataInput,
  LalSamplePayload,
  NodeSlice,
  SampleType,
  SessionRecord,
  SessionSample,
} from '@skywalking-horizon-ui/api-client';
import { isLalSamplePayload } from './payload.js';

export interface LalCellData {
  rec: SessionRecord;
  recIdx: number;
  sample: SessionSample;
  payload: LalSamplePayload | null;
}

/** A row in the per-record × per-block grid. `key` uniquely identifies
 *  the row across statement-mode (where multiple `function` samples
 *  fire per record at distinct DSL lines). */
export interface LalStep {
  key: string;
  type: SampleType;
  /** 1-based DSL line in statement mode; 0 for block-level samples. */
  sourceLine: number;
  /** Sample-type kicker — `input` / `function` / `output`, used as
   *  the row's small uppercase header. */
  kindLabel: string;
  /** Optional secondary line: in statement-mode this carries the
   *  verbatim DSL slice for function samples (`tag stage: 'extractor'`,
   *  …) so each row reads as the operation it actually performs. Empty
   *  for input/output and for block-mode functions where the
   *  recorder doesn't supply a per-statement fragment. */
  nameLabel: string;
}

export interface LalRecordView {
  rec: SessionRecord;
  recIdx: number;
}

export interface LalNodeView extends NodeSlice {
  records: SessionRecord[];
  recordViews: LalRecordView[];
  steps: LalStep[];
  /** stepKey → recIdx → cell. Lookup with `cellAt(view, step, recIdx)`. */
  cells: Map<string, Map<number, LalCellData>>;
}

export interface KvEntry {
  k: string;
  v: string;
  hl?: boolean;
}

export function stepKeyOf(s: SessionSample): string {
  return `${s.type}@${s.sourceLine ?? 0}`;
}

export function nodeKey(n: NodeSlice): string {
  return n.nodeId ?? n.peer ?? '?';
}

export function cellAt(
  view: LalNodeView,
  step: LalStep,
  recIdx: number,
): LalCellData | undefined {
  return view.cells.get(step.key)?.get(recIdx);
}

export function logBuilderOutput(p: LalSamplePayload | null): LalLogBuilderOutput | null {
  if (!p?.output) return null;
  // The snapshot's concrete type is the builder class — `LogBuilder` for
  // generic logs, `EnvoyAccessLogBuilder` for Envoy ALS — all LogBuilder-
  // shaped. Accept any `*Builder`, or every Envoy output renders blank.
  if (!p.output.type.endsWith('Builder')) return null;
  return p.output as LalLogBuilderOutput;
}

export function logDataInput(p: LalSamplePayload | null): LalLogDataInput | null {
  if (!p?.input) return null;
  if (p.input.type !== 'LogData') return null;
  return p.input as LalLogDataInput;
}

/** Keys rendered in their own groups (or as the cell's format kicker),
 *  not as scalar rows. */
const STRUCTURAL_KEYS = new Set(['type', 'tags', 'body', 'content']);

/** Generic scalar dump of an LAL payload object. LAL inputs and outputs
 *  are OAP-serialized JSON whose field set varies by log format — a
 *  `LogData` carries service/endpoint/layer, an `EnvoyAccessLogBuilder`
 *  adds responseCode/responseFlags/…, a proto the recorder couldn't
 *  serialize carries `error`/`detail`. Render whatever scalar keys are
 *  present rather than a fixed subset; structural keys (tags/body/content)
 *  and nullish values are skipped, objects are stringified. */
export function objectEntries(
  obj: Record<string, unknown> | null | undefined,
  full = false,
): KvEntry[] {
  if (!obj) return [];
  const out: KvEntry[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (STRUCTURAL_KEYS.has(k)) continue;
    if (v === null || v === undefined || v === '') continue;
    // Complex object fields are OAP-serialized JSON — pretty-print them in
    // the popout (`full`) so nested structures read cleanly; keep them
    // compact in the dense matrix cell.
    const value =
      typeof v === 'object' ? JSON.stringify(v, null, full ? 2 : undefined) : String(v);
    out.push({ k, v: value });
  }
  return out;
}

export function inputEntries(p: LalSamplePayload | null, full = false): KvEntry[] {
  return objectEntries(p?.input, full);
}

/** The agent-supplied log tags (`code.filepath`, `os.type`,
 *  `gen_ai.*`, …). These pre-LAL tags are the raw key/value bag the
 *  OTLP exporter sent with the log; LAL rules read them via
 *  `tag("…")` and may overwrite or extend them, but the input
 *  sample captures them verbatim. */
export function inputTags(p: LalSamplePayload | null): { key: string; value: string }[] {
  const inp = logDataInput(p);
  return inp?.tags ?? [];
}

/** Split the merged-tag view on a LogBuilder snapshot into two
 *  semantic groups so the operator can tell at a glance what survived
 *  from the agent vs. what the rule added:
 *  - `carried` — tags whose status is `original`; came in on the
 *    LogData and weren't touched by the rule.
 *  - `added` — tags the rule created or overwrote; covers both
 *    `lal-added` (new) and `lal-override` (key collided with an input
 *    tag, runtime concatenated). */
export function carriedTags(p: LalSamplePayload | null): LalLogBuilderTag[] {
  const out = logBuilderOutput(p);
  if (!out?.tags) return [];
  return out.tags.filter((t) => t.status === 'original');
}

export function addedTags(p: LalSamplePayload | null): LalLogBuilderTag[] {
  const out = logBuilderOutput(p);
  if (!out?.tags) return [];
  return out.tags.filter((t) => t.status === 'lal-added' || t.status === 'lal-override');
}

export function outputEntries(p: LalSamplePayload | null, full = false): KvEntry[] {
  return objectEntries(p?.output, full);
}

/** Pretty-print JSON content (ALS / structured-log content is JSON);
 *  fall back to the raw trimmed string when it isn't parseable JSON. */
function prettyJson(s: string): string {
  const t = s.trim();
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return t;
  }
}

/** Input body / output content text. `full` returns the complete value
 *  (pretty-printed if JSON) for the cell popout; otherwise a one-glance
 *  preview clipped to 80 chars for the dense matrix cell. */
export function bodyPreview(p: LalSamplePayload | null, full = false): string {
  const text = logDataInput(p)?.body?.text;
  if (!text) return '';
  if (full) return prettyJson(text);
  const t = text.trim();
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
}

export function contentPreview(p: LalSamplePayload | null, full = false): string {
  const content = logBuilderOutput(p)?.content;
  if (!content) return '';
  if (full) return prettyJson(content);
  const t = content.trim();
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
}

/** The cell's complete payload object (the `input` or `output` side) as
 *  pretty JSON — the source for the inspect popout's JSON viewer and the
 *  same-format diff. The builder's `content` is itself a JSON string, so
 *  inline it as nested JSON rather than leave it an escaped blob. */
export function fullJson(p: LalSamplePayload | null, stepType: SampleType): string {
  const obj = stepType === 'input' ? p?.input : p?.output;
  if (!obj) return '';
  const clone: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
  if (typeof clone.content === 'string') {
    try {
      clone.content = JSON.parse(clone.content);
    } catch {
      /* not JSON — leave the raw string */
    }
  }
  return JSON.stringify(clone, null, 2);
}

/** Free-text filter on log content. A record matches when ANY of its
 *  samples carry text containing the substring (case-insensitive):
 *    - input LogData body.text
 *    - output LogBuilder.content
 *    - any LogBuilder tag key/value
 *  Empty query matches everything. */
export function recordMatches(rec: SessionRecord, q: string): boolean {
  if (q === '') return true;
  const needle = q.toLowerCase();
  for (const sample of rec.samples ?? []) {
    if (!isLalSamplePayload(sample.payload)) continue;
    const p = sample.payload;
    const text = logDataInput(p)?.body?.text;
    if (typeof text === 'string' && text.toLowerCase().includes(needle)) return true;
    const out = logBuilderOutput(p);
    if (out) {
      if (typeof out.content === 'string' && out.content.toLowerCase().includes(needle)) {
        return true;
      }
      for (const t of out.tags ?? []) {
        if (
          t.key.toLowerCase().includes(needle) ||
          t.value.toLowerCase().includes(needle)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Minimal escape — step keys are `<type>@<digits>`, no special chars
 *  beyond `@` which is querySelector-safe. Keep this honest in case
 *  the key shape ever broadens. */
export function cssEscape(s: string): string {
  return s.replace(/(["\\\[\]'])/g, '\\$1');
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms3 = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms3}`;
}
