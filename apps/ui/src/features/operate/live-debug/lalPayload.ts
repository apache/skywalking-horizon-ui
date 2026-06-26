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
  if (p.output.type !== 'LogBuilder') return null;
  return p.output as LalLogBuilderOutput;
}

export function logDataInput(p: LalSamplePayload | null): LalLogDataInput | null {
  if (!p?.input) return null;
  if (p.input.type !== 'LogData') return null;
  return p.input as LalLogDataInput;
}

export function inputEntries(p: LalSamplePayload | null): KvEntry[] {
  const inp = logDataInput(p);
  if (!inp) return [];
  return [
    { k: 'service', v: inp.service ?? '—' },
    { k: 'endpoint', v: inp.endpoint ?? '—' },
    { k: 'instance', v: inp.serviceInstance ?? '—' },
    { k: 'layer', v: inp.layer ?? '—' },
  ];
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

export function outputEntries(p: LalSamplePayload | null): KvEntry[] {
  const out = logBuilderOutput(p);
  if (!out) return [];
  return [
    { k: 'service', v: out.service ?? '—' },
    { k: 'endpoint', v: out.endpoint ?? '—' },
    { k: 'timestamp', v: out.timestamp ? String(out.timestamp) : '—' },
  ];
}

export function bodyPreview(p: LalSamplePayload | null): string {
  const inp = logDataInput(p);
  const text = inp?.body?.text;
  if (!text) return '';
  const t = text.trim();
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
}

export function contentPreview(p: LalSamplePayload | null): string {
  const lb = logBuilderOutput(p);
  if (!lb?.content) return '';
  const t = lb.content.trim();
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
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
    if (p.input?.type === 'LogData') {
      const body = (p.input as LalLogDataInput).body;
      const text = body?.text;
      if (typeof text === 'string' && text.toLowerCase().includes(needle)) return true;
    }
    if (p.output?.type === 'LogBuilder') {
      const out = p.output as LalLogBuilderOutput;
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
