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
 * Pure grouping / diff / cap engine behind the MAL live-debugger view
 * (`DebugMal.vue`). Zero Vue dependencies — every function here is a
 * deterministic transform over the wire payload shapes; the view binds
 * the reactive toggle state and passes the relevant predicates in.
 *
 * The wire emits one `SessionRecord` per execution. Each record carries
 * `samples[]` whose entries discriminate via `type` (input | filter |
 * function | output for MAL). Non-output samples carry the
 * `SampleFamily.toJson()` shape (`samples`, `empty`, nested `items[]`);
 * output samples carry the materialised metric (`metric`, `entity`,
 * `valueType`, `value`, `timeBucket`).
 */

import type {
  MalOutputPayload,
  MalSampleRow as MalSampleItem,
  MalSamplesPayload,
  NodeSlice,
  SessionRecord,
  SessionSample,
} from '@skywalking-horizon-ui/api-client';
import { formatSampleValue } from './payload.js';

// Per-group rendering caps. A stage can emit hundreds of samples; the
// collapsed summary stays cheap, while an expanded group renders at
// most GROUP_DETAIL_CAP detail rows (with a "+ N more" note). The
// summary line previews the first SUMMARY_VALUE_CAP values inline.
export const GROUP_DETAIL_CAP = 50;
export const SUMMARY_VALUE_CAP = 8;

export interface MalBefore {
  samples: MalSamplesPayload | null;
  output: MalOutputPayload | null;
}

export interface MalSampleRow {
  rec: SessionRecord;
  recordIdx: number;
  nodeKey: string;
  sample: SessionSample;
  samples: MalSamplesPayload | null;
  output: MalOutputPayload | null;
  /** Previous sample's payload — what this step received as input.
   *  Null on the first sample (no upstream step). */
  before: MalBefore | null;
  /** Set only on the synthetic anchor row that stands in for a run of
   *  ≥2 `output` samples in one record — collapses the repeated meter
   *  cards into one diff-aware summary (same metric / function, one
   *  materialised entity each). */
  outputGroup?: OutputGroup | null;
}

export interface MalRecordView {
  rec: SessionRecord;
  recordIdx: number;
  rows: MalSampleRow[];
  /** Rows as rendered: the non-output chain followed by either the lone
   *  output row (rendered as a full meter card) or one anchor row
   *  carrying the merged `outputGroup`. */
  displayRows: MalSampleRow[];
}

export interface MalNodeView extends NodeSlice {
  recordViews: MalRecordView[];
}

export interface FlatRow {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** One metric-name group within a stage's payload: every leaf row that
 *  shares `name`. `count` is the exact total; `rows` caps at
 *  GROUP_DETAIL_CAP for rendering; `diff` is precomputed only when the
 *  group has >1 sample (the only case the diff toggle is offered). */
export interface SampleGroup {
  /** Stage-scoped expand/diff toggle key — see `groupKey`. */
  key: string;
  name: string;
  count: number;
  rows: FlatRow[];
  diff?: GroupDiff;
}

export interface DiffCell {
  k: string;
  v: string;
  /** Key present on a sibling sample but missing from this one. */
  absent: boolean;
}

export interface GroupDiff {
  /** Labels identical (key AND value) across every sample — the shared
   *  context, rendered once and dimmed. */
  common: EntityField[];
  /** Per-sample view carrying only the labels that vary across the
   *  group, so operators see at a glance what distinguishes each row. */
  rows: Array<{ value: number; diffs: DiffCell[] }>;
}

/** A run of ≥2 `output` samples collapsed into one block: same metric /
 *  function (the shared meter header), one materialised entity each. The
 *  entity is diffed field-by-field — whichever fields differ surface
 *  (not just `endpointName`), and each output keeps its own value — so
 *  no assumption is baked in about what distinguishes the outputs. */
export interface OutputGroup {
  key: string;
  metric: string;
  valueType: string;
  timeBucket: number;
  count: number;
  /** Full-mode rows: every non-null entity field + the value. */
  rows: OutputRow[];
  /** Entity fields identical across all outputs (the shared context). */
  common: EntityField[];
  /** Diff-mode rows: only the entity fields that vary, + the value. */
  diffRows: Array<{ diffs: DiffCell[]; value: string; valueRaw: string }>;
}

export interface OutputRow {
  fields: EntityField[];
  value: string;
  valueRaw: string;
}

export interface EntityField {
  k: string;
  v: string;
}

export interface Segment {
  text: string;
  highlight: boolean;
}

/** Total leaf-row count across both shapes (flat per-stage items, or
 *  nested per-family items on the file-level filter probe). Drives
 *  the `in → out` counts on every stage label. */
export function countRows(p: MalSamplesPayload | null): number {
  if (!p) return 0;
  if (p.empty === true) return 0;
  if (p.items && p.items.length > 0) {
    const first = p.items[0]! as MalSampleItem & MalSamplesPayload;
    const isFlat = typeof first.name === 'string' && typeof first.value === 'number';
    if (isFlat) return p.items.length;
    let total = 0;
    for (const fam of p.items as MalSamplesPayload[]) {
      total += fam.samples ?? (fam.items?.length ?? 0);
    }
    return total;
  }
  return p.samples ?? 0;
}

/** Walk a payload (flat per-stage items, or nested per-family items on
 *  the file-level filter probe) yielding every `{name, labels, value}`
 *  leaf. Mirrors `countRows`' shape detection. */
export function* leafRows(p: MalSamplesPayload | null): Generator<FlatRow> {
  if (!p || p.empty === true || !p.items || p.items.length === 0) return;
  const first = p.items[0]! as MalSampleItem & MalSamplesPayload;
  const isFlat = typeof first.name === 'string' && typeof first.value === 'number';
  if (isFlat) {
    for (const it of p.items as MalSampleItem[]) {
      yield { name: it.name, labels: it.labels ?? {}, value: it.value };
    }
  } else {
    for (const fam of p.items as MalSamplesPayload[]) {
      if (fam.empty === true) continue;
      for (const it of (fam.items ?? []) as MalSampleItem[]) {
        if (typeof it.name !== 'string') continue;
        yield { name: it.name, labels: it.labels ?? {}, value: it.value };
      }
    }
  }
}

/** Classify keys across N field maps into common (present in ALL with
 *  one identical value) vs varying. Computed over the FULL set so the
 *  "common" claim holds even when only a capped subset of rows renders
 *  below. Generic over any label/entity field map — no field is special-
 *  cased, so the differing field surfaces whatever it is. */
export function diffLabels(maps: Array<Record<string, string>>): {
  common: EntityField[];
  varying: string[];
} {
  const stat = new Map<string, { first: string; constant: boolean; seen: number }>();
  for (const m of maps) {
    for (const k in m) {
      const v = m[k]!;
      const s = stat.get(k);
      if (!s) stat.set(k, { first: v, constant: true, seen: 1 });
      else {
        s.seen++;
        if (v !== s.first) s.constant = false;
      }
    }
  }
  const common: EntityField[] = [];
  const varying: string[] = [];
  for (const [k, s] of [...stat.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (s.seen === maps.length && s.constant) common.push({ k, v: s.first });
    else varying.push(k);
  }
  return { common, varying };
}

/** Per-row diff cells for a varying-key set against one row's map. A key
 *  present on a sibling but missing here surfaces as `absent`. */
export function diffCells(varying: string[], m: Record<string, string>): DiffCell[] {
  return varying.map((k) => {
    const v = m[k];
    return v === undefined ? { k, v: '', absent: true } : { k, v, absent: false };
  });
}

/** Group one stage's leaves by metric name for the right-pane summary.
 *  Detail rows cap at GROUP_DETAIL_CAP; `count` stays exact. The diff's
 *  common/varying split is computed over EVERY leaf (not just the capped
 *  rows), so a label uniform across the first 50 but varying later is
 *  not mis-classified as common. Each group carries a stage-scoped
 *  `key` so its toggles stay independent across stages/records/nodes.
 *
 *  The expand/diff predicates are passed in — the engine stays Vue-free
 *  while the diff (the costly full-set scan on high-cardinality stages)
 *  is computed lazily only for the groups the caller reports expanded +
 *  in diff mode. */
export function stageGroups(
  row: MalSampleRow,
  stageIdx: number,
  ctx: {
    groupKey: (row: MalSampleRow, stageIdx: number, name: string) => string;
    isGroupExpanded: (key: string) => boolean;
    isDiffMode: (key: string, count: number) => boolean;
  },
): SampleGroup[] {
  const map = new Map<string, { group: SampleGroup; maps: Array<Record<string, string>> }>();
  for (const r of leafRows(row.samples)) {
    let e = map.get(r.name);
    if (!e) {
      e = {
        group: { key: ctx.groupKey(row, stageIdx, r.name), name: r.name, count: 0, rows: [] },
        maps: [],
      };
      map.set(r.name, e);
    }
    e.group.count++;
    if (e.group.rows.length < GROUP_DETAIL_CAP) e.group.rows.push(r);
    e.maps.push(r.labels);
  }
  const groups: SampleGroup[] = [];
  for (const { group, maps } of map.values()) {
    if (ctx.isGroupExpanded(group.key) && ctx.isDiffMode(group.key, group.count)) {
      const { common, varying } = diffLabels(maps);
      group.diff = {
        common,
        rows: group.rows.map((r) => ({ value: r.value, diffs: diffCells(varying, r.labels) })),
      };
    }
    groups.push(group);
  }
  return groups;
}

/** First few values of a sample group, comma-joined, for the summary
 *  line — e.g. `438.95, 57.0333, 0.6667`. Appends `…` when more remain. */
export function summaryValues(g: SampleGroup): string {
  const shown = g.rows.slice(0, SUMMARY_VALUE_CAP).map((r) => formatSampleValue(r.value));
  if (g.count > shown.length) shown.push('…');
  return shown.join(', ');
}

/** Parse OAP's `MeterEntity#toString()` shape `Name(k=v, k=v, ...)`
 *  into kv pairs. Fields are flat — no commas inside values for the
 *  shipped scope set — so a naive split is fine. */
export function parseEntity(s: string): EntityField[] {
  const m = s.match(/^[^(]+\((.*)\)$/);
  if (!m) return [];
  return m[1]!.split(', ').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq < 0) return { k: pair, v: '' };
    return { k: pair.slice(0, eq), v: pair.slice(eq + 1) };
  });
}

export function entityFields(s: string, includeNulls: boolean): EntityField[] {
  const all = parseEntity(s);
  return includeNulls ? all : all.filter((f) => f.v !== 'null');
}

/** Non-null entity fields of one output, as a flat record, for diffing. */
function entityRecord(entity: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of entityFields(entity, false)) out[f.k] = f.v;
  return out;
}

/** Format the output payload's `value` for inline display. Three
 *  wire shapes per `MalOutputPayload.value`:
 *
 *  - number → plain numeric (Sum / Avg / scalar holders).
 *  - string → non-finite double sentinel (`NaN`, `Infinity`,
 *    `-Infinity`); render verbatim so a div-by-zero is visible.
 *  - object → labeled / histogram-percentile DataTable; rendered as
 *    `key=value · key=value …`.
 *
 *  When the value is multi-line (object), the caller can opt to drop
 *  it into a kv block for readability — but for the meter card a
 *  single line keeps the layout tight, and operators with many keys
 *  see the full set in the right-pane samples table on the previous
 *  step (each labeled key has already been rendered there as its own
 *  row with full label tuples). */
export function formatOutputValue(v: number | string | Record<string, number>): string {
  if (typeof v === 'number') return formatSampleValue(v);
  if (typeof v === 'string') return v;
  const entries = Object.entries(v);
  if (entries.length === 0) return '{}';
  return entries.map(([k, n]) => `${k}=${formatSampleValue(n)}`).join(' · ');
}

/** Untrimmed output value for the cell `title` — `formatOutputValue`
 *  rounds long floats for display, so the precise number stays reachable
 *  on hover. */
export function outputValueRaw(v: number | string | Record<string, number>): string {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  return Object.entries(v)
    .map(([k, n]) => `${k}=${n}`)
    .join(' · ');
}

/** Collapse a run of `output` samples (same metric / function) into one
 *  diff-aware group. The entity is diffed field-by-field via the same
 *  generic helper the sample groups use — whatever differs surfaces
 *  (endpointName here, but any field for other scopes), with each
 *  output's value kept in its own column. */
export function buildOutputGroup(key: string, outputs: MalOutputPayload[]): OutputGroup {
  const first = outputs[0]!;
  const maps = outputs.map((o) => entityRecord(o.entity));
  const { common, varying } = diffLabels(maps);
  const valueOf = (o: MalOutputPayload): string =>
    o.value === undefined ? '—' : formatOutputValue(o.value);
  const rawOf = (o: MalOutputPayload): string =>
    o.value === undefined ? '' : outputValueRaw(o.value);
  // Render at most GROUP_DETAIL_CAP rows (with a "+ N more" footer),
  // mirroring sample groups — `common`/`varying` above is already over
  // the full set, so the cap only bounds the rendered detail.
  const shown = outputs.slice(0, GROUP_DETAIL_CAP);
  return {
    key,
    metric: first.metric,
    valueType: first.valueType,
    timeBucket: first.timeBucket,
    count: outputs.length,
    rows: shown.map((o) => ({
      fields: entityFields(o.entity, false),
      value: valueOf(o),
      valueRaw: rawOf(o),
    })),
    common,
    diffRows: shown.map((o, i) => ({
      diffs: diffCells(varying, maps[i]!),
      value: valueOf(o),
      valueRaw: rawOf(o),
    })),
  };
}

/** First few output values, comma-joined, for the summary line. */
export function outputSummaryValues(g: OutputGroup): string {
  const shown = g.rows.slice(0, SUMMARY_VALUE_CAP).map((r) => r.value);
  if (g.count > shown.length) shown.push('…');
  return shown.join(', ');
}

export function labelLines(labels: Record<string, string>): string[] {
  const entries = Object.entries(labels);
  if (entries.length === 0) return [];
  return entries.map(([k, v]) => `${k}=${v}`);
}

export function inCountStr(row: MalSampleRow): string {
  if (row.before === null) return '—';
  if (row.before.output) return '1';
  return String(countRows(row.before.samples));
}

export function outCountStr(row: MalSampleRow): string {
  if (row.output) return '1';
  return String(countRows(row.samples));
}

export function isDrop(row: MalSampleRow): boolean {
  if (row.output) return false;
  if (row.before === null) return false;
  if (row.before.output) return false;
  return countRows(row.samples) < countRows(row.before.samples);
}

/** Split a rule field into highlight / plain segments around every
 *  exact occurrence of the selected step's `sourceText`. Drives the
 *  inline `<mark>` collaborative highlight inside `metric / filter /
 *  exp / suffix` — clicking a step makes the matching expression light
 *  up in the rule definition above the chain. */
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

export function nodeKey(n: NodeSlice): string {
  return n.nodeId ?? n.peer ?? '?';
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms3 = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms3}`;
}

/** Compose the metric name from rule metadata when available. The
 *  recorder fills `metricPrefix` + `name` for MAL — the live key is
 *  `<prefix>_<name>`. Falls back to `ruleName` if either is missing. */
export function metricLabel(rec: SessionRecord): string {
  const r = rec.rule;
  if (r.metricPrefix && r.name) return `${r.metricPrefix}_${r.name}`;
  return r.name ?? r.ruleName;
}
