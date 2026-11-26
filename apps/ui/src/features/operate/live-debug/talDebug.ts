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
 * What the TAL tab shows of a session, derived from its records: the frames
 * (one per span the rule ran on), the counts of what was
 * captured, and, for one run, the values its steps leave on each line of the
 * rule file.
 */

import type {
  NodeSlice,
  SessionRecord,
  SessionResponse,
  TalOutput,
  TalRecordKind,
  TalRun,
  TalSpanEntry,
  TalStep,
} from '@skywalking-horizon-ui/api-client';
import { nodeKey, nodeLabel } from './nodeIdentity.js';

/** One frame: a span of a record and the rule's run on it. */
export interface TalFrame {
  key: string;
  nodeKey: string;
  nodeLabel: string;
  /** 1-based position of the record on its node, in capture order. */
  recordIndex: number;
  record: SessionRecord;
  kind: TalRecordKind;
  spanIndex: number;
  entry: TalSpanEntry | null;
  run: TalRun | null;
}

/** A record of the frames list, with its frames: a native segment lists
 *  every span, an OTLP record its one span. */
export interface TalRecordView {
  key: string;
  nodeKey: string;
  nodeLabel: string;
  recordIndex: number;
  record: SessionRecord;
  kind: TalRecordKind;
  frames: TalFrame[];
}

export interface TalNodeCount {
  nodeKey: string;
  nodeLabel: string;
  status: NodeSlice['status'];
  records: number;
  captured: boolean;
}

export interface TalCaptureCounts {
  records: number;
  segments: number;
  /** Spans the native segments carry, and how many the rule ran on. */
  segmentSpans: number;
  segmentSpansRun: number;
  otlpSpans: number;
  /** Runs that ended with `continueOn: false`: aborted, or the rule failed. */
  stopped: number;
  failures: number;
  oversized: number;
  outputs: Record<string, number>;
  nodes: TalNodeCount[];
}


function recordKind(record: SessionRecord): TalRecordKind {
  return record.context?.kind ?? 'span';
}

/** The session's records, each with its frames, node by node in capture order. */
export function talRecordViews(session: SessionResponse | null): TalRecordView[] {
  if (!session) return [];
  const out: TalRecordView[] = [];
  for (const node of session.nodes) {
    const ofNode = { nodeKey: nodeKey(node), nodeLabel: nodeLabel(node) };
    node.records.forEach((record, i) => {
      const recordIndex = i + 1;
      const key = `${ofNode.nodeKey}#${recordIndex}`;
      const kind = recordKind(record);
      const spans = record.spans ?? [];
      const frames: TalFrame[] = spans.map((entry, spanIndex) => ({
        key: `${key}#${spanIndex}`,
        ...ofNode,
        recordIndex,
        record,
        kind,
        spanIndex,
        entry,
        run: entry.run ?? null,
      }));
      out.push({ key, ...ofNode, recordIndex, record, kind, frames });
    });
  }
  out.sort((a, b) => (a.record.captureTime ?? '').localeCompare(b.record.captureTime ?? ''));
  return out;
}

/** What the session captured, for the summary bar. */
export function talCaptureCounts(session: SessionResponse | null): TalCaptureCounts {
  const counts: TalCaptureCounts = {
    records: 0,
    segments: 0,
    segmentSpans: 0,
    segmentSpansRun: 0,
    otlpSpans: 0,
    stopped: 0,
    failures: 0,
    oversized: 0,
    outputs: {},
    nodes: [],
  };
  if (!session) return counts;
  for (const node of session.nodes) {
    counts.nodes.push({
      nodeKey: nodeKey(node),
      nodeLabel: nodeLabel(node),
      status: node.status,
      records: node.records.length,
      captured: node.captured === true,
    });
    for (const record of node.records) {
      counts.records += 1;
      if (record.oversizedBytes !== undefined) {
        counts.oversized += 1;
        continue;
      }
      const kind = recordKind(record);
      const spans = record.spans ?? [];
      if (kind === 'segment') {
        counts.segments += 1;
        counts.segmentSpans += spans.length;
      } else {
        counts.otlpSpans += 1;
      }
      for (const entry of spans) {
        const run = entry.run;
        if (!run) continue;
        if (kind === 'segment') counts.segmentSpansRun += 1;
        if (!run.continueOn) counts.stopped += 1;
        if (run.steps.some((s) => s.kind === 'failure')) counts.failures += 1;
        for (const output of run.outputs) {
          counts.outputs[output.kind] = (counts.outputs[output.kind] ?? 0) + 1;
        }
      }
    }
  }
  return counts;
}

/** The line a step or an output names: in the rule file when the node read
 *  it, else in the rule's DSL, which `dslOffset` moves into the file. */
export function lineOf(item: TalStep | TalOutput, dslOffset: number | null): number | null {
  if (typeof item.sourceLine === 'number' && item.sourceLine > 0) return item.sourceLine;
  if (typeof item.dslLine === 'number' && item.dslLine > 0) {
    return dslOffset === null ? item.dslLine : item.dslLine + dslOffset;
  }
  return null;
}

/** Steps whose statement opens a body: its own lines end at the `{` that opens it. */
const OPENS_BODY = new Set(['if', 'foreach', 'rateLimit', 'build', 'block']);

/** A line's code without its strings, single or double quoted as TAL takes both, and its trailing comment, for
 *  counting brackets. */
function codeOf(text: string): string {
  return text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""').replace(/\/\/.*$/, '');
}

/**
 * The lines a step's statement stands on, from its first: those a wrapped
 * statement continues on, until its parentheses close (an `if` or a block
 * through the `{` that opens its body); and for `metrics {}` and `source {}`,
 * whose clauses are no statements and take no steps of their own, the whole
 * body to its closing brace.
 */
export function stepLines(step: TalStep, line: number, textOf: (line: number) => string | undefined): number[] {
  const out = [line];
  if (step.kind === 'metrics' || step.kind === 'source') {
    let depth = 0;
    let opened = false;
    for (let n = line; n < line + 200; n++) {
      const text = textOf(n);
      if (text === undefined) break;
      for (const ch of codeOf(text)) {
        if (ch === '{') {
          depth++;
          opened = true;
        } else if (ch === '}') depth--;
      }
      if (n > line) out.push(n);
      if (opened && depth <= 0) break;
    }
    return out;
  }
  let parens = 0;
  for (let n = line; n < line + 50; n++) {
    const text = textOf(n);
    if (text === undefined) break;
    const code = codeOf(text).trim();
    for (const ch of code) {
      if (ch === '(') parens++;
      else if (ch === ')') parens--;
    }
    if (n > line) out.push(n);
    const ends = OPENS_BODY.has(step.kind) ? /[{}]$/.test(code) : !/(?:&&|\|\||[+,(=])$/.test(code);
    if (parens <= 0 && ends) break;
  }
  return out;
}

/** Where the record's DSL starts in the file, as the number of lines before
 *  it: the line of the first `dsl: |` block whose lines match the DSL's. */
export function dslOffsetIn(fileLines: readonly string[], dsl: string, ruleLine = 0): number | null {
  const dslLines = dsl.replace(/\n$/, '').split('\n');
  const first = dslLines[0]?.trim();
  if (!first) return null;
  // The rule's own block, at or after its line: two rules of a file may share a DSL.
  for (let i = Math.max(0, ruleLine - 1); i < fileLines.length; i++) {
    if (fileLines[i]!.trim() !== first) continue;
    let all = true;
    for (let j = 1; j < dslLines.length && all; j++) {
      all = (fileLines[i + j] ?? '').trim() === dslLines[j]!.trim();
    }
    if (all) return i;
  }
  return null;
}

/** Whether the file holds the record's DSL at the offset, as the number of
 *  lines before it: where OAP numbered the steps' file lines from. */
export function dslAt(fileLines: readonly string[], dsl: string, offset: number): boolean {
  const dslLines = dsl.replace(/\n$/, '').split('\n');
  return offset >= 0 && dslLines.every((line, j) => (fileLines[offset + j] ?? '').trim() === line.trim());
}

/** Past this a value reads cut, `…`-ended: the line that opens it shows it whole. */
const INLINE_MAX = 200;

/** A value as it reads inline at the end of a line: one line. */
export function shortValue(value: unknown): string {
  let text: string;
  if (value === null) text = 'null';
  else if (typeof value === 'string') text = JSON.stringify(value);
  else if (typeof value === 'object') text = JSON.stringify(value);
  else text = String(value);
  return text.length > INLINE_MAX ? `${text.slice(0, INLINE_MAX - 1)}…` : text;
}

/** A value as the view shows it: a list of `{key, value}` pairs — a native
 *  span's tags, an OTLP span's attributes — reads as a map, with an OTLP
 *  `AnyValue` (`{stringValue: …}`) unwrapped. A key that repeats keeps every
 *  value, as a list. */
export function displayValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(isKeyValue)) {
      const byKey = new Map<string, unknown[]>();
      for (const kv of value as { key: string; value: unknown }[]) {
        const values = byKey.get(kv.key) ?? [];
        values.push(anyValue(kv.value));
        byKey.set(kv.key, values);
      }
      return Object.fromEntries([...byKey].map(([k, vs]) => [k, vs.length === 1 ? vs[0] : vs]));
    }
    return value.map(displayValue);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, displayValue(v)]));
  }
  return value;
}

function isKeyValue(x: unknown): boolean {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
  const keys = Object.keys(x);
  return keys.length === 2 && typeof (x as { key?: unknown }).key === 'string' && keys.includes('value');
}

/** An OTLP `AnyValue` is an object with one `…Value` field. */
function anyValue(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && /Value$/.test(keys[0]!)) {
      const inner = (value as Record<string, unknown>)[keys[0]!];
      const values = (inner as { values?: unknown[] } | null)?.values ?? [];
      if (keys[0] === 'arrayValue') return values.map(anyValue);
      if (keys[0] === 'kvlistValue') return displayValue(values);
      return inner;
    }
  }
  return displayValue(value);
}

/** An output's fields as the view shows them: `observation`, the value the
 *  rule handed the metric's function (`value 1`, `match ok`), reads `value`. */
export function outputDisplay(output: TalOutput): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(output)) {
    if (key === 'kind' || key === 'sourceLine' || key === 'dslLine') continue;
    fields[key === 'observation' ? 'value' : key] = value;
  }
  return displayValue(fields) as Record<string, unknown>;
}

const TIME_KEY = /(?:^|[a-z_])(?:time|Time|timestamp|Timestamp)(?:UnixNano)?$/;

/**
 * A time field as the browser's local time: an epoch in milliseconds (13
 * digits) or in nanoseconds (19 digits, the extra digits kept after the
 * milliseconds), under a key that names a time. Null for anything else, as
 * a minute bucket or a latency.
 */
export function timeText(key: string, value: unknown): string | null {
  if (!TIME_KEY.test(key)) return null;
  const digits =
    typeof value === 'number' && Number.isInteger(value) ? String(value)
      : typeof value === 'string' && /^\d+$/.test(value) ? value
        : null;
  if (digits === null || (digits.length !== 13 && digits.length !== 19)) return null;
  const d = new Date(Number(digits.slice(0, 13)));
  const two = (n: number): string => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  const clock = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  return `${date} ${clock}.${String(d.getMilliseconds()).padStart(3, '0')}${digits.slice(13)}`;
}

/** What an output carried, beyond its kind and name, read as one gray line. */
export function outputSummary(output: TalOutput): string {
  if (output.kind === 'metrics') {
    if (output.skipped !== undefined) return `skipped: ${String(output.skipped)}`;
    const entity = (output.entity ?? {}) as Record<string, unknown>;
    const where = [entity.scope, entity.service, entity.serviceInstance, entity.endpoint].filter((v) => v).join(' ');
    return `${where} = ${shortValue(output.observation)}`;
  }
  if (output.kind === 'source') return shortValue(displayValue(output.fields));
  if (output.kind === 'pairing') {
    // The half as the span offered it: the peer a caller dialed, or the
    // service a callee is.
    const half = (output.half ?? {}) as Record<string, unknown>;
    const side = output.role === 'caller' ? `peer ${String(output.peer ?? '')}` : `service ${String(half.service ?? '')}`;
    return [side, output.offeredBy && `offered by ${String(output.offeredBy)}`].filter((v) => v).join(' · ');
  }
  return '';
}

/** One step as it reads inline: what the statement produced. */
export function stepInline(step: TalStep, outputs: readonly TalOutput[]): string {
  if (step.kind === 'if') {
    const result = step.result === true ? 'true' : 'false';
    const operands = step.operands ?? [];
    return operands.length === 0
      ? result
      : `${operands.map((o) => `${o.text} = ${shortValue(o.value)}`).join(', ')} → ${result}`;
  }
  if (step.kind === 'failure') return `✕ ${shortValue(step.value)}`;
  if (step.kind === 'abort') return 'abort';
  if (step.output !== undefined) {
    const output = outputs[step.output];
    return output ? `→ ${outputInline(output)}` : `→ output ${step.output}`;
  }
  if (step.kind === 'block') return 'entered';
  if ('value' in step && step.value !== undefined) return shortValue(step.value);
  return '';
}

/** What an output sent: the source's scope, the metric, the persist vote,
 *  the pairing half and its outcome, or the alias address it wrote. */
export function outputName(output: TalOutput): string {
  const name =
    output.kind === 'source' ? output.scope
      : output.kind === 'metrics' ? output.metric ?? output.skipped
        : output.kind === 'persist' ? output.vote
          : output.kind === 'pairing' ? `${String(output.role)} ${String(output.outcome)}`
            : output.kind === 'writeNetworkAlias' ? output.address
              : undefined;
  return name === undefined ? '' : String(name);
}

/** An output as it reads inline: its kind and what names it. */
export function outputInline(output: TalOutput): string {
  const name = outputName(output);
  return name === '' ? output.kind : `${output.kind} ${name}`;
}

/** An output with the statement that sent it: the step naming it, when the
 *  run has one, and its line. A `persist` vote has a line and no step. */
export interface TalOutputLink {
  index: number;
  output: TalOutput;
  name: string;
  line: number | null;
  step: number | null;
}

export function outputLinks(run: TalRun | null, dslOffset: number | null): TalOutputLink[] {
  if (!run) return [];
  const stepOf = new Map<number, number>();
  run.steps.forEach((s, i) => {
    if (s.output !== undefined && !stepOf.has(s.output)) stepOf.set(s.output, i);
  });
  return run.outputs.map((output, index) => {
    const step = stepOf.get(index) ?? null;
    const line = lineOf(output, dslOffset) ?? (step === null ? null : lineOf(run.steps[step]!, dslOffset));
    return { index, output, name: outputName(output), line, step };
  });
}

/** What a line shows of a run: the steps on it, in order, with the indexes
 *  into the run's steps, and the marker its gutter carries. */
export interface TalLineValues {
  steps: number[];
  text: string;
  marker: 'output' | 'abort' | 'failure' | null;
}

/** A failure outranks an abort, which outranks an output, on one line. */
const MARKER_RANK = { output: 1, abort: 2, failure: 3 } as const;

/** The values the run left on each line it executed. A line run more than
 *  once (a `foreach` body) lists each value and its count. */
export function lineValues(run: TalRun | null, dslOffset: number | null): Map<number, TalLineValues> {
  const out = new Map<number, TalLineValues>();
  if (!run) return out;
  run.steps.forEach((step, i) => {
    const line = lineOf(step, dslOffset);
    if (line === null) return;
    let entry = out.get(line);
    if (!entry) {
      entry = { steps: [], text: '', marker: null };
      out.set(line, entry);
    }
    entry.steps.push(i);
    const marker =
      step.kind === 'failure' ? 'failure' : step.kind === 'abort' ? 'abort' : step.output !== undefined ? 'output' : null;
    if (marker && (!entry.marker || MARKER_RANK[marker] > MARKER_RANK[entry.marker])) entry.marker = marker;
  });
  for (const entry of out.values()) {
    const texts = entry.steps.map((i) => stepInline(run.steps[i]!, run.outputs)).filter((s) => s !== '');
    const distinct = [...new Set(texts)];
    entry.text = distinct.length === 1 && texts.length > 1 ? `${distinct[0]} ×${texts.length}` : texts.join(', ');
  }
  return out;
}

/** A variable of a line with the value the run gave it: an operand of an
 *  `if`, or the name a `def`, an assignment, a `segmentDef` or a `foreach`
 *  sets. `start` and `end` place the name in the line's text. */
export interface TalLineVar {
  name: string;
  value: unknown;
  line: number;
  start: number;
  end: number;
  step: number;
  /** A name the rule sets, rather than an operand it reads. */
  local: boolean;
}

const SETS_NAME = /^(\s*(?:def|segmentDef)\s+)([A-Za-z_]\w*)\s*=/;
const ASSIGNS = /^(\s*)([A-Za-z_]\w*)\s*=(?!=)/;
const ITERATES = /^(.*?\bforeach\s*\(\s*)([A-Za-z_]\w*)\s+in\b/;

/** The name a statement sets, placed in its line. */
function namedBy(text: string): { name: string; start: number } | null {
  const m = SETS_NAME.exec(text) ?? ASSIGNS.exec(text) ?? ITERATES.exec(text);
  return m ? { name: m[2]!, start: m[1]!.length } : null;
}

/**
 * The variables the steps up to `upTo` gave values to, by the line their
 * name is on. A condition's operands sit on its lines in the order it
 * evaluated them, so an operand written twice takes its next place; a line
 * run more than once keeps the latest value.
 */
export function lineVariables(
  run: TalRun | null,
  upTo: number,
  dslOffset: number | null,
  textOf: (line: number) => string | undefined,
): Map<number, TalLineVar[]> {
  const out = new Map<number, TalLineVar[]>();
  if (!run) return out;
  const put = (v: TalLineVar): void => {
    const vars = out.get(v.line) ?? [];
    const same = vars.findIndex((x) => x.start === v.start);
    if (same >= 0) vars[same] = v;
    else vars.push(v);
    out.set(v.line, vars.sort((a, b) => a.start - b.start));
  };
  run.steps.slice(0, upTo + 1).forEach((step, i) => {
    const line = lineOf(step, dslOffset);
    if (line === null) return;
    if (step.kind === 'if') {
      const span = (step.sourceText ?? '').split('\n').length;
      let at = line;
      let from = 0;
      for (const operand of step.operands ?? []) {
        const name = operand.text.split('\n')[0]!.trim();
        for (; at < line + span; at++, from = 0) {
          const index = (textOf(at) ?? '').indexOf(name, from);
          if (index < 0) continue;
          put({ name, value: operand.value, line: at, start: index, end: index + name.length, step: i, local: false });
          from = index + name.length;
          break;
        }
      }
      return;
    }
    if (step.value === undefined || !['def', 'assign', 'segmentDef', 'foreach'].includes(step.kind)) return;
    const named = namedBy(textOf(line) ?? '');
    if (named) {
      put({
        name: named.name,
        value: step.value,
        line,
        start: named.start,
        end: named.start + named.name.length,
        step: i,
        local: true,
      });
    }
  });
  return out;
}

/** A name the rule set, with the value it holds at the current step and the
 *  statement that gave it that value. */
export interface TalLocal {
  value: unknown;
  line: number;
  step: number;
}

/** The names the rule set up to the current step, each with its value then
 *  and where it got it, in the order the run first set them. */
export function localsOf(vars: Map<number, TalLineVar[]>): Record<string, TalLocal> {
  const latest = new Map<string, TalLineVar>();
  for (const v of [...vars.values()].flat().filter((x) => x.local).sort((a, b) => a.step - b.step)) {
    latest.set(v.name, v);
  }
  return Object.fromEntries([...latest].map(([name, v]) => [name, { value: v.value, line: v.line, step: v.step }]));
}

/** Where the variables pane shows a name the rule reads: `meta.kind` and
 *  `span.operationName` as those fields, `attr("k")` as the span's
 *  attributes, a name the rule sets among its locals. */
export function paneFieldOf(name: string | null, locals: Record<string, TalLocal>): string | null {
  if (!name) return null;
  if (/^(?:meta|span)\.[\w.]+$/.test(name)) return name;
  if (/^(?:has)?[aA]ttr\(/.test(name)) return 'span.attributes';
  return name in locals ? `locals.${name}` : null;
}

/** The name the rule reads a field of the variables pane by, the other way. */
export function ruleNameOf(field: string): string | null {
  if (/^(?:meta|span)\.\w+$/.test(field)) return field;
  const local = /^locals\.(.+)$/.exec(field);
  return local ? local[1]! : null;
}

/** What a line's step produced beyond its variables, read as a labelled
 *  value: an `if`'s result, an output with its fields, a tag, a failure. */
export interface TalLineResult {
  label: string;
  value: unknown;
}

export function stepResult(step: TalStep, outputs: readonly TalOutput[]): TalLineResult | null {
  if (step.kind === 'if') return { label: 'result', value: step.result === true };
  if (step.output !== undefined) {
    const output = outputs[step.output];
    if (!output) return null;
    return { label: `→ ${outputInline(output)}`, value: outputDisplay(output) };
  }
  if (step.kind === 'abort') return { label: 'abort', value: undefined };
  if (step.kind === 'failure') return { label: 'failure', value: step.value };
  if (step.kind === 'block' || ['def', 'assign', 'segmentDef', 'foreach'].includes(step.kind)) return null;
  return step.value === undefined ? null : { label: step.kind, value: displayValue(step.value) };
}

/** The lines of the file the rule's DSL covers, first and last, inclusive. */
export function ruleRange(dsl: string, dslOffset: number | null): { first: number; last: number } | null {
  if (dslOffset === null) return null;
  const count = dsl.replace(/\n$/, '').split('\n').length;
  return { first: dslOffset + 1, last: dslOffset + count };
}

/** A span's one-line label in the frames list. */
export function spanLabel(entry: TalSpanEntry | null): string {
  const span = (entry?.span ?? {}) as Record<string, unknown>;
  const name = span.operationName ?? span.name ?? '';
  const type = span.spanType ?? kindLabel(span.kind);
  const layer = span.spanLayer && span.spanLayer !== 'Unknown' ? ` · ${String(span.spanLayer)}` : '';
  const peer = span.peer ? ` → ${String(span.peer)}` : '';
  return `${type ? `${String(type)} ` : ''}${String(name)}${layer}${peer}`.trim();
}

function kindLabel(kind: unknown): string {
  if (typeof kind !== 'string') return '';
  return kind.replace(/^SPAN_KIND_/, '').toLowerCase();
}

/** The span's id within its segment (native) or trace (OTLP). */
export function spanId(entry: TalSpanEntry | null): string {
  const span = (entry?.span ?? {}) as Record<string, unknown>;
  return span.spanId === undefined ? '' : String(span.spanId);
}
