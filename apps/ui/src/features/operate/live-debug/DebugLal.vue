<!--
  Licensed to the Apache Software Foundation (ASF) under one or more
  contributor license agreements.  See the NOTICE file distributed with
  this work for additional information regarding copyright ownership.
  The ASF licenses this file to You under the Apache License, Version 2.0
  (the "License"); you may not use this file except in compliance with
  the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
-->
<script setup lang="ts">
/**
 * LAL live-debugger view. Hosted in `<DebugView>`.
 *
 * Each LAL execution shows up as one `SessionRecord` whose `samples[]`
 * walks `input → function → output` stages. Sample payloads carry the
 * unified envelope `{aborted, hasParsed, input?, output?, parsedKeys}`
 * — `input` populated on the first sample (raw `LogData` /
 * `Message`), `output` populated on every sample after `bindInput`
 * (the `LogBuilder` snapshot, including the merged `tags[]` with
 * `original | lal-added | lal-override` status).
 *
 * Statement-mode capture (`granularity=statement`) appends an extra
 * record per DSL statement, with `sample.sourceLine` pointing at the
 * 1-based DSL-block line that fired.
 */
import { computed, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import type {
  BundledEntry,
  Granularity,
  LalLogBuilderOutput,
  LalLogBuilderTag,
  LalLogDataInput,
  LalSamplePayload,
  ListEnvelope,
  NodeSlice,
  SampleType,
  SessionRecord,
  SessionResponse,
  SessionSample,
} from '@skywalking-horizon-ui/api-client';
import { bff } from '@/api/client';
import { useDebugSession } from '@/features/operate/live-debug/useDebugSession';
import { useDebugHistory, type HistoryEntry } from '@/features/operate/live-debug/useDebugHistory';
import Btn from '@/components/primitives/Btn.vue';
import DebugView from './DebugView.vue';
import { isLalSamplePayload } from './payload.js';
import {
  DEFAULT_RETENTION_MINUTES,
  MS_PER_MINUTE,
  RECORD_CAP_MAX,
} from './constants.js';

const { t } = useI18n({ useScope: 'global' });
const route = useRoute();
const dbg = useDebugSession('lal');
const history = useDebugHistory('lal');
/** A LAL "rule" in the catalog is a YAML **file** — e.g.
 *  `default`, `envoy-ai-gateway`. Each file's body has a `rules:`
 *  list, and OAP keys the debug install on
 *  `(catalog=lal, name=<file>, ruleName=<inner-rule-name>)`. So
 *  the picker has two levels: the file (selectedFile) AND a rule
 *  drilled out of the file's YAML body. */
const selectedFile = ref<string>('');
const selectedRule = ref<string>('');
const granularity = ref<Granularity>('block');
// SessionLimits.MAX_RECORD_CAP on the OAP side is 100 (and so is the
// default). The input is bounded the same way; lower if a single
// execution is enough or you want the captured page tighter.
const recordCap = ref<number>(RECORD_CAP_MAX);
const retentionMinutes = ref<number>(DEFAULT_RETENTION_MINUTES);

/** Deep-link from a LAL rule card / Monaco gutter — `?file=&name=`
 *  pre-fills both. `name` is the inner ruleName; `file` is the LAL
 *  file. Older callers that only pass `?name=` get the file inferred
 *  (the inner rule and file share a name in single-rule files). */
watch(
  () => [route.query.name, route.query.file] as const,
  ([n, f]) => {
    if (typeof f === 'string' && f.length > 0) {
      selectedFile.value = f;
    } else if (typeof n === 'string' && n.length > 0) {
      // backward-compat: single-rule files where rule == file basename
      selectedFile.value = n;
    }
    if (typeof n === 'string' && n.length > 0) {
      selectedRule.value = n;
    }
  },
  { immediate: true },
);

// File picker feed: `/runtime/rule/list` (operator-pushed +
// dslManager-tracked) ∪ `/runtime/rule/bundled` (every shipped LAL
// rule file). On a fresh OAP `/list` is empty while `/bundled` has
// the catalogue, so the merge keeps the dropdown populated.
const listQuery = useQuery({
  queryKey: ['debug-lal/list'],
  queryFn: async (): Promise<ListEnvelope> => bff.dsl.catalogList('lal'),
});

const bundledQuery = useQuery({
  queryKey: ['debug-lal/bundled'],
  queryFn: async (): Promise<BundledEntry[]> => bff.dsl.catalogBundled('lal', false),
});

const fileNames = computed<string[]>(() => {
  const seen = new Set<string>();
  const env = listQuery.data.value;
  if (env) for (const r of env.rules) seen.add(r.name);
  for (const e of bundledQuery.data.value ?? []) seen.add(e.name);
  return [...seen].sort((a, b) => a.localeCompare(b));
});

/** Pull the selected LAL file's YAML so we can extract its inner
 *  `rules[].name` list. Same shape as MAL — a regex over the body
 *  is enough since the YAML structure is rigid. */
const ruleContentQuery = useQuery({
  queryKey: computed(() => ['debug-lal/content', selectedFile.value]),
  queryFn: async (): Promise<string | null> => {
    if (!selectedFile.value) return null;
    const got = await bff.dsl.getRule({ catalog: 'lal', name: selectedFile.value });
    return got?.content ?? null;
  },
  enabled: computed(() => selectedFile.value !== ''),
  staleTime: 30_000,
});

const RULE_NAME_RE = /^[ \t]*-[ \t]+name:[ \t]*([A-Za-z_][A-Za-z0-9_-]*)/gm;
const innerRuleNames = computed<string[]>(() => {
  const c = ruleContentQuery.data.value;
  if (!c) return [];
  const seen = new Set<string>();
  for (const m of c.matchAll(RULE_NAME_RE)) {
    seen.add(m[1]!);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
});

/** When the file changes, reset the rule selection if it isn't part
 *  of the new file's rule list. Keeps deep-link preselect intact. */
watch(innerRuleNames, (names) => {
  if (selectedRule.value && names.length > 0 && !names.includes(selectedRule.value)) {
    selectedRule.value = '';
  }
});

const startEnabled = computed(() => {
  const s = dbg.state.value;
  return (
    selectedFile.value !== '' &&
    selectedRule.value !== '' &&
    (s === 'idle' || s === 'captured' || s === 'stopped' || s === 'error')
  );
});

const stopEnabled = computed(
  () => dbg.state.value === 'capturing' || dbg.state.value === 'starting',
);

async function startSampling(): Promise<void> {
  if (!selectedFile.value || !selectedRule.value) return;
  await dbg.start({
    catalog: 'lal',
    name: selectedFile.value,
    ruleName: selectedRule.value,
    granularity: granularity.value,
    recordCap: recordCap.value,
    retentionMillis: retentionMinutes.value * MS_PER_MINUTE,
  });
}

interface LalCell {
  rec: SessionRecord;
  recIdx: number;
  sample: SessionSample;
  payload: LalSamplePayload | null;
}

/** A row in the per-record × per-block grid. `key` uniquely identifies
 *  the row across statement-mode (where multiple `function` samples
 *  fire per record at distinct DSL lines). */
interface LalStep {
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

interface LalRecordView {
  rec: SessionRecord;
  recIdx: number;
}

interface LalNodeView extends NodeSlice {
  records: SessionRecord[];
  recordViews: LalRecordView[];
  steps: LalStep[];
  /** stepKey → recIdx → cell. Lookup with `cellAt(view, step, recIdx)`. */
  cells: Map<string, Map<number, LalCell>>;
}

function stepKeyOf(s: SessionSample): string {
  return `${s.type}@${s.sourceLine ?? 0}`;
}

// ── Historical replay ──────────────────────────────────────────────

const historicalEntry = shallowRef<HistoryEntry | null>(null);

const displaySession = computed<SessionResponse | null>(
  () => historicalEntry.value?.session ?? dbg.session.value,
);

/* `selectedCell` is declared HERE (not at its original site further
 * below) because `loadHistorical` / `clearHistorical` reset it and
 * the `watch(historyId, …, { immediate: true })` further down runs
 * synchronously during setup. With the ref declared below those
 * functions, an `?historyId=` deep-link would throw a TDZ
 * ReferenceError and blank the page. */
const selectedCell = ref<LalCell | null>(null);

function loadHistorical(entry: HistoryEntry): void {
  historicalEntry.value = entry;
  selectedFile.value = entry.name;
  selectedRule.value = entry.ruleName;
  if (entry.granularity === 'block' || entry.granularity === 'statement') {
    granularity.value = entry.granularity;
  }
  if (entry.recordCap !== undefined) recordCap.value = entry.recordCap;
  if (entry.retentionMillis !== undefined) {
    retentionMinutes.value = Math.max(1, Math.round(entry.retentionMillis / MS_PER_MINUTE));
  }
  selectedCell.value = null;
}

function clearHistorical(): void {
  historicalEntry.value = null;
  selectedCell.value = null;
}

function persistCapture(): void {
  if (historicalEntry.value !== null) return;
  const id = dbg.sessionId.value;
  if (!id || !selectedFile.value || !selectedRule.value) return;
  const sess: SessionResponse = dbg.session.value ?? {
    sessionId: id,
    capturedAt: Date.now(),
    nodes: [],
  };
  history.save({
    widget: 'lal',
    catalog: 'lal',
    name: selectedFile.value,
    ruleName: selectedRule.value,
    granularity: granularity.value,
    recordCap: recordCap.value,
    retentionMillis: retentionMinutes.value * MS_PER_MINUTE,
    retentionDeadline: dbg.retentionDeadline.value ?? undefined,
    recordCount: sess.nodes.reduce((n, x) => n + (x.records?.length ?? 0), 0),
    nodeCount: sess.nodes.length,
    session: sess,
  });
}

watch(
  () => [dbg.sessionId.value, dbg.session.value, dbg.retentionDeadline.value] as const,
  () => persistCapture(),
);

watch(
  () => route.query.resumeSessionId,
  (id) => {
    if (typeof id !== 'string' || id === '') return;
    if (dbg.sessionId.value === id) return;
    // Cross-widget lookup (`history.all`) — routing already pinned us
    // to the right widget, so filtering again by widget would silently
    // swallow entries with a mismatched widget field.
    const entry = history.all.value.find((e) => e.session.sessionId === id);
    if (!entry) return;
    selectedFile.value = entry.name;
    selectedRule.value = entry.ruleName;
    if (entry.granularity === 'block' || entry.granularity === 'statement') {
      granularity.value = entry.granularity;
    }
    if (entry.recordCap !== undefined) recordCap.value = entry.recordCap;
    if (entry.retentionMillis !== undefined) {
      retentionMinutes.value = Math.max(1, Math.round(entry.retentionMillis / MS_PER_MINUTE));
    }
    dbg.resume(id, entry.retentionDeadline ?? null);
  },
  { immediate: true },
);

watch(
  () => route.query.historyId,
  (id) => {
    if (typeof id !== 'string' || id === '') {
      if (historicalEntry.value !== null) clearHistorical();
      return;
    }
    if (historicalEntry.value?.id === id) return;
    const entry = history.all.value.find((e) => e.id === id);
    if (entry) loadHistorical(entry);
  },
  { immediate: true },
);

const nodeViews = computed<LalNodeView[]>(() => {
  const s = displaySession.value;
  if (!s) return [];
  // Stable order by nodeKey so cards don't reshuffle between polls
  // (OAP doesn't guarantee a fixed order in session.nodes).
  const sortedNodes = s.nodes.slice().sort((a, b) => {
    const ak = a.nodeId ?? a.peer ?? '?';
    const bk = b.nodeId ?? b.peer ?? '?';
    return ak.localeCompare(bk);
  });
  return sortedNodes.map((n) => {
    const records = n.records ?? [];
    const recordViews: LalRecordView[] = records.map((rec, recIdx) => ({ rec, recIdx }));
    const steps: LalStep[] = [];
    const seen = new Set<string>();
    const cells = new Map<string, Map<number, LalCell>>();
    for (let recIdx = 0; recIdx < records.length; recIdx++) {
      const rec = records[recIdx]!;
      for (const sample of rec.samples ?? []) {
        const key = stepKeyOf(sample);
        if (!seen.has(key)) {
          seen.add(key);
          const sourceLine = sample.sourceLine ?? 0;
          const txt = sample.sourceText.trim();
          // In statement-mode every function sample carries its
          // verbatim DSL slice; surface that as the row's name so
          // operators see "tag stage: 'extractor'" instead of a
          // generic "function". Long slices are truncated; the
          // line number lives in the kicker line. In block-mode
          // there's exactly one function probe per record (post-
          // extractor LogBuilder snapshot) with no per-statement
          // slice — call that row `extractor` since that's what the
          // probe actually captured.
          const nameLabel =
            sample.type === 'function' && txt.length > 0
              ? txt.length > 60 ? `${txt.slice(0, 57)}…` : txt
              : '';
          let kindLabel: string;
          if (sample.type !== 'function') {
            kindLabel = sample.type;
          } else if (sourceLine > 0) {
            kindLabel = t('function @{line}', { line: sourceLine });
          } else {
            kindLabel = t('extractor');
          }
          steps.push({ key, type: sample.type, sourceLine, kindLabel, nameLabel });
        }
        let perRec = cells.get(key);
        if (!perRec) {
          perRec = new Map();
          cells.set(key, perRec);
        }
        perRec.set(recIdx, {
          rec,
          recIdx,
          sample,
          payload: isLalSamplePayload(sample.payload) ? sample.payload : null,
        });
      }
    }
    return { ...n, records, recordViews, steps, cells };
  });
});

function nodeKey(n: NodeSlice): string {
  return n.nodeId ?? n.peer ?? '?';
}

function cellAt(view: LalNodeView, step: LalStep, recIdx: number): LalCell | undefined {
  return view.cells.get(step.key)?.get(recIdx);
}

function logBuilderOutput(p: LalSamplePayload | null): LalLogBuilderOutput | null {
  if (!p?.output) return null;
  if (p.output.type !== 'LogBuilder') return null;
  return p.output as LalLogBuilderOutput;
}

function logDataInput(p: LalSamplePayload | null): LalLogDataInput | null {
  if (!p?.input) return null;
  if (p.input.type !== 'LogData') return null;
  return p.input as LalLogDataInput;
}

interface KvEntry {
  k: string;
  v: string;
  hl?: boolean;
}

function inputEntries(p: LalSamplePayload | null): KvEntry[] {
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
function inputTags(p: LalSamplePayload | null): { key: string; value: string }[] {
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
function carriedTags(p: LalSamplePayload | null): LalLogBuilderTag[] {
  const out = logBuilderOutput(p);
  if (!out?.tags) return [];
  return out.tags.filter((t) => t.status === 'original');
}

function addedTags(p: LalSamplePayload | null): LalLogBuilderTag[] {
  const out = logBuilderOutput(p);
  if (!out?.tags) return [];
  return out.tags.filter((t) => t.status === 'lal-added' || t.status === 'lal-override');
}

function outputEntries(p: LalSamplePayload | null): KvEntry[] {
  const out = logBuilderOutput(p);
  if (!out) return [];
  return [
    { k: 'service', v: out.service ?? '—' },
    { k: 'endpoint', v: out.endpoint ?? '—' },
    { k: 'timestamp', v: out.timestamp ? String(out.timestamp) : '—' },
  ];
}

function bodyPreview(p: LalSamplePayload | null): string {
  const inp = logDataInput(p);
  const text = inp?.body?.text;
  if (!text) return '';
  const t = text.trim();
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
}

function contentPreview(p: LalSamplePayload | null): string {
  const lb = logBuilderOutput(p);
  if (!lb?.content) return '';
  const t = lb.content.trim();
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
}

// ── Selection + source pane ───────────────────────────────────────

/** Single selected cell drives the source-pane open-state and the
 *  `<mark>` highlight inside the captured DSL. `selectedCell` itself
 *  is declared above `loadHistorical` (TDZ guard). */

function selectCell(cell: LalCell): void {
  selectedCell.value = selectedCell.value === cell ? null : cell;
}

// ── Single-record expand mode ─────────────────────────────────────

/** When set, the matrix view collapses to a single record (full width
 *  per cell — input / function@N / output stacked vertically). The
 *  matrix is dense by design (one column per record), so an operator
 *  drilling into one log line that has long content benefits from
 *  losing the column constraint. The matrix layout (sticky block-
 *  label column + captured-DSL pane) stays mounted; we just filter
 *  `displayedRecords` to a single column. The expand button on the
 *  record header toggles back to the full matrix. */
const expandedRecord = ref<{ nodeKey: string; recIdx: number } | null>(null);

function isRecordExpanded(nKey: string, recIdx: number): boolean {
  const e = expandedRecord.value;
  return e !== null && e.nodeKey === nKey && e.recIdx === recIdx;
}

function toggleExpandRecord(nKey: string, recIdx: number): void {
  if (isRecordExpanded(nKey, recIdx)) {
    expandedRecord.value = null;
  } else {
    expandedRecord.value = { nodeKey: nKey, recIdx };
  }
}

// ── Search + display limit ────────────────────────────────────────

/** Free-text filter on log content. A record matches when ANY of its
 *  samples carry text containing the substring (case-insensitive):
 *    - input LogData body.text
 *    - output LogBuilder.content
 *    - any LogBuilder tag key/value
 *  Empty query matches everything. */
const searchQuery = ref<string>('');
/** UI-side cap so a busy capture doesn't render hundreds of columns
 *  at once; operators raise this when they want the full set. */
const displayLimit = ref<number>(20);

function recordMatches(rec: SessionRecord, q: string): boolean {
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

/** Memoized per-node post-filter view. Computed once per
 *  (recordViews, search, limit) tuple so the template's many
 *  references (header row, every step row, count badges) all share
 *  the same array reference — Vue's reconciliation then keeps the
 *  sticky leftmost column DOM nodes stable across polls instead of
 *  thrashing them on every reactive tick at high record counts. */
interface DisplayedShape {
  records: LalRecordView[];
  matched: number;
  total: number;
}

const displayedByNode = computed<Map<string, DisplayedShape>>(() => {
  const q = searchQuery.value.trim();
  const limit = displayLimit.value;
  const ex = expandedRecord.value;
  const map = new Map<string, DisplayedShape>();
  for (const view of nodeViews.value) {
    const nKey = nodeKey(view);
    const total = view.recordViews.length;
    // Single-record expand collapses the matrix to one column. The
    // matrix layout (sticky block-label column + captured-DSL pane)
    // is reused as-is; only the column count drops.
    if (ex !== null && ex.nodeKey === nKey) {
      const rec = view.recordViews.find((r) => r.recIdx === ex.recIdx);
      if (rec) {
        map.set(nKey, { records: [rec], matched: 1, total });
        continue;
      }
    }
    const matched =
      q === ''
        ? view.recordViews
        : view.recordViews.filter((rv) => recordMatches(rv.rec, q));
    map.set(nKey, {
      records: matched.slice(0, limit),
      matched: matched.length,
      total,
    });
  }
  return map;
});

function displayedRecords(view: LalNodeView): LalRecordView[] {
  return displayedByNode.value.get(nodeKey(view))?.records ?? [];
}

function matchedRecordCount(view: LalNodeView): number {
  return displayedByNode.value.get(nodeKey(view))?.matched ?? 0;
}

// ── Optional source panel with per-line hooks ──────────────────────

/** Toggles the verbatim DSL panel next to the matrix. On by default —
 *  the source-to-step mapping is the most useful cross-reference for
 *  statement-mode rules, so the operator sees both surfaces side by
 *  side without an extra click. The toggle button lives at the top-
 *  right of the matrix area so it stays close to what it controls. */
const sourcePanelOpen = ref<boolean>(true);

/** Captured DSL — pulled from the latest displayed record on the
 *  first node. All records in a session share the same `dsl` (the
 *  recorder snapshots the rule body once at install time and reuses
 *  it for every record), so any record's `dsl` works. */
const sourceDslLines = computed<string[]>(() => {
  for (const view of nodeViews.value) {
    const records = view.records ?? [];
    if (records.length > 0) {
      const dsl = records[records.length - 1]!.dsl;
      if (typeof dsl === 'string' && dsl.length > 0) return dsl.split(/\r?\n/);
    }
  }
  return [];
});

/** Map of 1-based DSL line → step key for STATEMENT-mode functions.
 *  Lets the source panel show a hook arrow only on lines that
 *  actually fired a function probe in this capture, and lets the
 *  click handler resolve to the right step's sticky highlight
 *  state. */
const stepKeyByLine = computed<Map<number, string>>(() => {
  const map = new Map<number, string>();
  for (const view of nodeViews.value) {
    for (const step of view.steps) {
      if (step.type === 'function' && step.sourceLine > 0) {
        map.set(step.sourceLine, step.key);
      }
    }
  }
  return map;
});

/** Block-mode hooks. In block granularity the recorder fires one
 *  function probe per record — the post-extractor LogBuilder
 *  snapshot — with `sourceLine: 0` (no specific line). The natural
 *  anchor is the `extractor {` block opening line; we detect it via
 *  regex on the DSL and pin the block-mode step's key there so the
 *  same click-to-jump interaction works. Rendered with a red arrow
 *  to distinguish from per-statement hooks. */
const blockHookByLine = computed<Map<number, string>>(() => {
  const map = new Map<number, string>();
  const blockSteps: string[] = [];
  for (const view of nodeViews.value) {
    for (const step of view.steps) {
      if (step.type === 'function' && step.sourceLine === 0) {
        blockSteps.push(step.key);
      }
    }
  }
  if (blockSteps.length === 0) return map;
  const lines = sourceDslLines.value;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*extractor\s*\{/.test(lines[i]!)) {
      // First extractor block carries the first block-mode step;
      // multiple block-mode steps would be unusual but we'd map
      // them to subsequent block openings the same way.
      const stepKey = blockSteps.shift();
      if (stepKey !== undefined) map.set(i + 1, stepKey);
      if (blockSteps.length === 0) break;
    }
  }
  return map;
});

/** Soft-highlight: when an operator clicks a line in the source
 *  panel, the corresponding step row in the matrix gets a brief
 *  outline. We track the highlighted step key and clear it after a
 *  short delay so the cue is visible without being permanent. */
const highlightedStepKey = ref<string | null>(null);
let highlightTimer: ReturnType<typeof setTimeout> | null = null;

function jumpToStep(stepKey: string): void {
  highlightedStepKey.value = stepKey;
  if (highlightTimer !== null) clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => {
    highlightedStepKey.value = null;
  }, 1500);
  // Scroll the matrix's matching step label into view inside the
  // wrapper. The element id is set on the step row's leading label
  // cell so this works for both the sticky-pinned column and free-
  // scrolled positions.
  if (typeof document === 'undefined') return;
  const el = document.querySelector<HTMLElement>(`[data-step-key="${cssEscape(stepKey)}"]`);
  if (el && typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }
}

function cssEscape(s: string): string {
  // Minimal escape — step keys are `<type>@<digits>`, no special chars
  // beyond `@` which is querySelector-safe. Keep this honest in case
  // the key shape ever broadens.
  return s.replace(/(["\\\[\]'])/g, '\\$1');
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms3 = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms3}`;
}

function recordTitle(view: LalRecordView): string {
  return t('record {n} · {time}', { n: view.recIdx + 1, time: formatTime(view.rec.startedAtMs) });
}
</script>

<template>
  <DebugView
    :dbg="dbg"
    :node-views="nodeViews"
    :view-session="historicalEntry?.session ?? null"
  >
    <template #controls>
      <div class="ctl">
        <label class="ctl__lbl">{{ t('rule file') }}</label>
        <select v-model="selectedFile" class="ctl__select">
          <option value="" disabled>{{ t('select a LAL rule file…') }}</option>
          <option v-for="n in fileNames" :key="n" :value="n">{{ n }}</option>
        </select>
      </div>
      <div class="ctl ctl--grow">
        <label class="ctl__lbl">{{ t('rule') }}</label>
        <select
          v-model="selectedRule"
          class="ctl__select"
          :disabled="selectedFile === '' || ruleContentQuery.isPending.value"
        >
          <option value="" disabled>
            {{ selectedFile === ''
                ? t('pick a file first…')
                : ruleContentQuery.isPending.value
                  ? t('loading…')
                  : innerRuleNames.length === 0
                    ? t('no rules found in file')
                    : t('select a rule…') }}
          </option>
          <option v-for="r in innerRuleNames" :key="r" :value="r">{{ r }}</option>
        </select>
      </div>
      <div class="ctl">
        <label class="ctl__lbl">{{ t('granularity') }}</label>
        <div class="lal__granularity">
          <button
            type="button"
            class="lal__granbtn"
            :class="{ 'lal__granbtn--active': granularity === 'block' }"
            @click="granularity = 'block'"
          >{{ t('block') }}</button>
          <button
            type="button"
            class="lal__granbtn"
            :class="{ 'lal__granbtn--active': granularity === 'statement' }"
            @click="granularity = 'statement'"
          >{{ t('statement') }}</button>
        </div>
      </div>
      <div class="ctl">
        <label class="ctl__lbl">recordCap</label>
        <input v-model.number="recordCap" type="number" min="1" :max="RECORD_CAP_MAX" class="ctl__input" />
      </div>
      <div class="ctl">
        <label class="ctl__lbl">{{ t('retention (min)') }}</label>
        <input v-model.number="retentionMinutes" type="number" min="1" max="60" class="ctl__input" />
      </div>
      <Btn kind="primary" :disabled="!startEnabled" @click="startSampling">{{ t('start sampling') }}</Btn>
      <Btn kind="ghost" :disabled="!stopEnabled" @click="dbg.stop()">{{ t('stop') }}</Btn>
      <router-link
        class="ctl__editlink"
        to="/operate/live-debug/history"
        :title="t('browse past captures saved locally')"
      >{{ t('history ({n}) →', { n: history.entries.value.length }) }}</router-link>
      <router-link
        v-if="selectedFile"
        class="ctl__editlink"
        :to="{ path: '/operate/dsl/edit', query: { catalog: 'lal', name: selectedFile } }"
        :title="t('open {catalog} · {name} in the editor', { catalog: 'lal', name: selectedFile })"
      >{{ t('open in editor →') }}</router-link>
    </template>

    <template #banner>
      <div v-if="historicalEntry" class="lal__histbanner">
        <span class="lal__histbicon">⟲</span>
        <span>
          {{ t('viewing saved capture from') }} <strong>{{ formatTime(historicalEntry.savedAt) }}</strong>
          · {{ historicalEntry.catalog }} · {{ historicalEntry.name }} · {{ historicalEntry.ruleName }}
        </span>
        <button type="button" class="lal__histback" @click="clearHistorical">{{ t('back to live') }}</button>
      </div>
    </template>

    <template #subhead>
      <div class="lal__subhead">
        <label class="lal__searchwrap">
          <span class="lal__searchlbl">{{ t('search') }}</span>
          <input
            v-model="searchQuery"
            type="search"
            class="lal__searchinput"
            :placeholder="t('filter records by log content / tag…')"
          />
        </label>
        <label class="lal__limitwrap">
          <span class="lal__searchlbl">{{ t('show first') }}</span>
          <input
            v-model.number="displayLimit"
            type="number"
            min="1"
            :max="RECORD_CAP_MAX"
            class="lal__limitinput"
          />
        </label>
      </div>
    </template>

    <template #idle-hint>
      {{ t('pick a LAL rule and hit start. each captured log becomes one column in the matrix; rows walk the per-record blocks') }}
      <code>input → function → output</code> {{ t('(statement granularity splits') }}
      <code>function</code> {{ t("per DSL line). click any cell to open the source pane with that record's captured DSL and the matching fragment highlighted.") }}
    </template>

    <template #node-body="{ node }">
      <div v-if="node.recordViews.length === 0" class="lal__empty">
        {{ t('no LAL records from this node') }}
      </div>

      <!-- DSL pane stays mounted across both modes (matrix view AND
           single-record expand) so the operator never loses the
           rule-body reference when drilling into a column. -->
      <div v-else class="lal__matrixblock">
        <div class="lal__matrixrow" :class="{ 'lal__matrixrow--withsrc': sourcePanelOpen && sourceDslLines.length > 0 }">
          <aside
            v-if="!sourcePanelOpen && sourceDslLines.length > 0"
            class="lal__sourcestub"
          >
            <button
              type="button"
              class="lal__srctogglebtn"
              :title="t('show captured DSL panel')"
              :aria-label="t('show captured DSL panel')"
              @click="sourcePanelOpen = true"
            ><span class="lal__srctogglechev">»</span></button>
            <span class="lal__sourcestublabel">{{ t('Captured DSL') }}</span>
          </aside>
          <aside
            v-if="sourcePanelOpen && sourceDslLines.length > 0"
            class="lal__sourcepane"
          >
            <header class="lal__sourceh">
              <button
                type="button"
                class="lal__srctogglebtn"
                :title="t('fold captured DSL panel')"
                :aria-label="t('fold captured DSL panel')"
                @click="sourcePanelOpen = false"
              ><span class="lal__srctogglechev">«</span></button>
              <span class="lal__sourcehtitle">{{ t('captured DSL · click ▶ to jump') }}</span>
            </header>
            <ol class="lal__sourcelines">
              <li
                v-for="(line, li) in sourceDslLines"
                :key="li"
                class="lal__sourceline"
                :class="{
                  'lal__sourceline--linked':
                    stepKeyByLine.get(li + 1) !== undefined ||
                    blockHookByLine.get(li + 1) !== undefined,
                }"
              >
                <span class="lal__sourcelno">{{ li + 1 }}</span>
                <button
                  v-if="stepKeyByLine.get(li + 1)"
                  type="button"
                  class="lal__sourcehook"
                  :title="t(`jump to this statement's row in the matrix`)"
                  @click="jumpToStep(stepKeyByLine.get(li + 1)!)"
                >▶</button>
                <button
                  v-else-if="blockHookByLine.get(li + 1)"
                  type="button"
                  class="lal__sourcehook lal__sourcehook--block"
                  :title="t('jump to the block-mode extractor row in the matrix')"
                  @click="jumpToStep(blockHookByLine.get(li + 1)!)"
                >▶</button>
                <span v-else class="lal__sourcehookbox" />
                <code class="lal__sourcetext">{{ line || ' ' }}</code>
              </li>
            </ol>
          </aside>

          <!-- Single matrix view; expanded mode just filters to one
               record column so the sticky block-label column AND the
               captured-DSL pane stay mounted across both modes. -->
          <div class="lal__matrixwrap">
        <div
          v-if="displayedRecords(node).length === 0"
          class="lal__nomatch"
        >
          <template v-if="searchQuery.trim() === ''">{{ t('no records on this node') }}</template>
          <template v-else>
            {{ t('no records match') }}
            <code>{{ searchQuery }}</code>
            ({{ t('{n} captured total', { n: node.recordViews.length }) }})
          </template>
        </div>
        <div
          v-else
          class="lal__matrix"
          :style="`grid-template-columns: 180px repeat(${displayedRecords(node).length}, minmax(200px, 1fr));`"
        >
          <!-- header row: blank label cell + record headers -->
          <div class="lal__hdrlbl">
            {{ t('block ▾ / record →') }}
            <div class="lal__hdrlblct">
              {{ t('showing') }} {{ displayedRecords(node).length }}
              {{ t('of') }} {{ matchedRecordCount(node) }}
              <span v-if="matchedRecordCount(node) !== node.recordViews.length">
                · {{ t('{n} captured', { n: node.recordViews.length }) }}
              </span>
            </div>
          </div>
          <div
            v-for="rv in displayedRecords(node)"
            :key="`${nodeKey(node)}-h-${rv.recIdx}`"
            class="lal__hdrec"
            :class="{
              'lal__hdrec--pinned':
                selectedCell !== null && selectedCell.recIdx === rv.recIdx,
            }"
          >
            <div class="lal__hdrtitle">
              {{ recordTitle(rv) }}
              <button
                type="button"
                class="lal__expandbtn"
                :title="isRecordExpanded(nodeKey(node), rv.recIdx) ? t('collapse to full matrix') : t('expand this record to full width')"
                @click.stop="toggleExpandRecord(nodeKey(node), rv.recIdx)"
              >{{ isRecordExpanded(nodeKey(node), rv.recIdx) ? '↩' : '⤢' }}</button>
            </div>
          </div>

          <!-- step rows -->
          <template v-for="step in node.steps" :key="step.key">
            <div
              class="lal__steplbl"
              :class="{ 'lal__steplbl--flash': highlightedStepKey === step.key }"
              :data-step-key="step.key"
            >
              <div class="lal__stepkind">{{ step.kindLabel }}</div>
              <div v-if="step.nameLabel" class="lal__stepname">
                <code>{{ step.nameLabel }}</code>
              </div>
              <div class="lal__stepct">
                {{ t('{n} / {total} records', { n: displayedRecords(node).filter((rv) => cellAt(node, step, rv.recIdx) !== undefined).length, total: displayedRecords(node).length }) }}
              </div>
            </div>
            <div
              v-for="rv in displayedRecords(node)"
              :key="`${step.key}-${rv.recIdx}`"
              class="lal__cell"
              :class="{
                'lal__cell--selected':
                  selectedCell !== null &&
                  selectedCell.recIdx === rv.recIdx &&
                  selectedCell.sample === cellAt(node, step, rv.recIdx)?.sample,
                'lal__cell--pinned':
                  selectedCell !== null && selectedCell.recIdx === rv.recIdx,
                'lal__cell--missing': cellAt(node, step, rv.recIdx) === undefined,
              }"
              @click="(() => { const c = cellAt(node, step, rv.recIdx); if (c) selectCell(c); })()"
            >
              <template v-if="cellAt(node, step, rv.recIdx) === undefined">
                <span class="lal__cellabsent">—</span>
              </template>
              <template v-else>
                <!-- input: LogData -->
                <template v-if="step.type === 'input'">
                  <div class="lal__kvs">
                    <div v-for="kv in inputEntries(cellAt(node, step, rv.recIdx)?.payload ?? null)" :key="kv.k" class="lal__kv">
                      <span class="lal__kvk">{{ kv.k }}</span>
                      <span class="lal__kvv">{{ kv.v }}</span>
                    </div>
                  </div>
                  <div
                    v-if="inputTags(cellAt(node, step, rv.recIdx)?.payload ?? null).length > 0"
                    class="lal__tags"
                  >
                    <span
                      v-for="(tag, ti) in inputTags(cellAt(node, step, rv.recIdx)?.payload ?? null)"
                      :key="ti"
                      class="lal__tag lal__tag--orig"
                    >{{ tag.key }}={{ tag.value }}</span>
                  </div>
                  <div v-if="bodyPreview(cellAt(node, step, rv.recIdx)?.payload ?? null)" class="lal__body">
                    {{ bodyPreview(cellAt(node, step, rv.recIdx)?.payload ?? null) }}
                  </div>
                </template>

                <!-- function / output: LogBuilder snapshot -->
                <template v-else>
                  <div class="lal__kvs">
                    <div v-for="kv in outputEntries(cellAt(node, step, rv.recIdx)?.payload ?? null)" :key="kv.k" class="lal__kv">
                      <span class="lal__kvk">{{ kv.k }}</span>
                      <span class="lal__kvv">{{ kv.v }}</span>
                    </div>
                  </div>
                  <div
                    v-if="carriedTags(cellAt(node, step, rv.recIdx)?.payload ?? null).length > 0"
                    class="lal__taggroup"
                  >
                    <span class="lal__tagheader">{{ t('carried') }}</span>
                    <span
                      v-for="(tag, ti) in carriedTags(cellAt(node, step, rv.recIdx)?.payload ?? null)"
                      :key="`o-${ti}`"
                      class="lal__tag lal__tag--orig"
                    >{{ tag.key }}={{ tag.value }}</span>
                  </div>
                  <div
                    v-if="addedTags(cellAt(node, step, rv.recIdx)?.payload ?? null).length > 0"
                    class="lal__taggroup"
                  >
                    <span class="lal__tagheader">{{ t('+ added') }}</span>
                    <span
                      v-for="(tag, ti) in addedTags(cellAt(node, step, rv.recIdx)?.payload ?? null)"
                      :key="`a-${ti}`"
                      class="lal__tag"
                      :class="tag.status === 'lal-override' ? 'lal__tag--over' : 'lal__tag--add'"
                    >{{ tag.key }}={{ tag.value }}</span>
                  </div>
                  <div v-if="contentPreview(cellAt(node, step, rv.recIdx)?.payload ?? null)" class="lal__body">
                    {{ contentPreview(cellAt(node, step, rv.recIdx)?.payload ?? null) }}
                  </div>
                </template>
                <div v-if="cellAt(node, step, rv.recIdx)?.payload?.aborted" class="lal__abort">{{ t('aborted') }}</div>
              </template>
            </div>
          </template>
        </div>
        </div>
        </div>
      </div>
    </template>
  </DebugView>
</template>

<style scoped>
.ctl {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.ctl__lbl {
  font-family: var(--rr-font-mono);
  font-size: 11.5px;
  letter-spacing: 1.1px;
  text-transform: uppercase;
  color: var(--rr-dim);
}

.ctl__select {
  min-width: 240px;
}

.ctl__select,
.ctl__input {
  background: var(--rr-bg2);
  color: var(--rr-ink);
  border: 1px solid var(--rr-border);
  padding: 4px 8px;
  font-family: var(--rr-font-mono);
  font-size: 12px;
}

.ctl__input {
  width: 90px;
}

.ctl__input--wide {
  width: 200px;
}

.ctl__editlink {
  font-family: var(--rr-font-mono);
  font-size: 11px;
  color: var(--rr-ink2);
  text-decoration: none;
  padding: 2px 8px;
  border: 1px dashed var(--rr-border);
  border-radius: var(--rr-radius-sm);
  white-space: nowrap;
  align-self: end;
  margin-bottom: 1px;
}
.ctl__editlink:hover {
  color: var(--rr-accent);
  border-color: var(--rr-accent);
}

.lal__granularity {
  display: inline-flex;
  border: 1px solid var(--rr-border);
  background: var(--rr-bg2);
}

.lal__granbtn {
  background: transparent;
  border: 0;
  color: var(--rr-ink2);
  padding: 4px 10px;
  font-family: var(--rr-font-mono);
  font-size: 12px;
  cursor: pointer;
}

.lal__granbtn--active {
  background: var(--rr-bg3);
  color: var(--rr-heading);
}

.lal__granbtn:not(.lal__granbtn--active):hover {
  background: var(--rr-bg3);
}

.lal__empty {
  padding: 14px;
  font-size: 12.5px;
  color: var(--rr-dim);
  font-style: italic;
}

.lal__matrixblock {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.lal__sourcestub {
  flex: 0 0 28px;
  max-height: calc(100vh - 280px);
  border: 1px solid var(--rr-border);
  background: var(--rr-bg);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 4px 0;
  gap: 8px;
}

.lal__sourcestublabel {
  font-family: var(--rr-font-mono);
  font-size: 10px;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--rr-dim);
  writing-mode: vertical-rl;
  transform: rotate(180deg);
  margin-top: 4px;
}

.lal__matrixrow {
  display: flex;
  gap: 12px;
  align-items: stretch;
}

.lal__matrixrow .lal__matrixwrap {
  flex: 1 1 auto;
  min-width: 0;
}

.lal__matrixwrap {
  overflow: auto;
  border: 1px solid var(--rr-border);
  /* Constrain the wrapper so both axes scroll INSIDE it — without a
     bound, vertical scroll cascades to the outer .dv ancestor and
     `position: sticky; left: 0` on the leftmost block-label column
     binds to the wrong scroll context (the steplbl scrolls out with
     the rest of the matrix instead of pinning). */
  max-height: calc(100vh - 280px);
  min-height: 200px;
}

.lal__sourcepane {
  flex: 0 0 360px;
  min-width: 0;
  max-height: calc(100vh - 280px);
  overflow: auto;
  border: 1px solid var(--rr-border);
  background: var(--rr-bg);
  display: flex;
  flex-direction: column;
}

.lal__sourceh {
  position: sticky;
  top: 0;
  background: var(--rr-bg2);
  border-bottom: 1px solid var(--rr-border);
  padding: 4px 8px;
  font-family: var(--rr-font-mono);
  font-size: 10.5px;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--rr-dim);
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
}

.lal__sourcehtitle {
  flex: 1 1 auto;
  min-width: 0;
}

.lal__sourcelines {
  list-style: none;
  margin: 0;
  padding: 6px 0 12px;
  display: flex;
  flex-direction: column;
}

.lal__sourceline {
  display: grid;
  grid-template-columns: 36px 18px 1fr;
  gap: 6px;
  align-items: baseline;
  padding: 1px 10px 1px 0;
  font-family: var(--rr-font-mono);
  font-size: 12px;
  line-height: 1.5;
}

.lal__sourceline--linked:hover {
  background: var(--rr-bg2);
}

.lal__sourcelno {
  text-align: right;
  color: var(--rr-dim);
  font-size: 10.5px;
}

.lal__sourcehook {
  background: transparent;
  border: 0;
  color: var(--rr-accent, var(--rr-active));
  font-size: 11px;
  cursor: pointer;
  padding: 0;
  width: 18px;
  text-align: center;
}

.lal__sourcehook:hover {
  color: var(--rr-heading);
}

/* Block-mode hook (extractor block opening line) — distinct red so
 * it visually reads as "jump to the whole-block snapshot row" rather
 * than a per-statement hook. */
.lal__sourcehook--block {
  color: var(--rr-err, #f44);
}

.lal__sourcehook--block:hover {
  color: var(--rr-warn, #d6a96d);
}

.lal__sourcehookbox {
  display: inline-block;
  width: 18px;
}

.lal__sourcetext {
  color: var(--rr-ink);
  white-space: pre-wrap;
  word-break: break-word;
}

.lal__steplbl--flash {
  outline: 2px solid var(--rr-accent, var(--rr-active));
  outline-offset: -2px;
  transition: outline-color 0.4s ease;
}

.lal__srctogglebtn {
  background: transparent;
  border: 1px solid var(--rr-border);
  color: var(--rr-ink2);
  font-family: var(--rr-font-mono);
  font-size: 11.5px;
  line-height: 1;
  width: 26px;
  height: 22px;
  padding: 0;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.lal__srctogglechev {
  font-size: 11.5px;
  line-height: 1;
}

.lal__srctogglebtn:hover:not(:disabled) {
  color: var(--rr-heading);
  border-color: var(--rr-ink2);
}

.lal__srctogglebtn--on {
  color: var(--rr-heading);
  border-color: var(--rr-accent, var(--rr-active));
}

.lal__srctogglebtn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.lal__matrix {
  display: grid;
  font-family: var(--rr-font-mono);
  font-size: 12px;
  background: var(--rr-bg);
  min-width: 100%;
}

.lal__hdrlbl {
  position: sticky;
  top: 0;
  left: 0;
  z-index: 3;
  background: var(--rr-bg2);
  padding: 8px 10px;
  border-right: 1px solid var(--rr-border);
  border-bottom: 1px solid var(--rr-border);
  color: var(--rr-dim);
  font-size: 10px;
  letter-spacing: 1px;
  text-transform: uppercase;
}

.lal__hdrlblct {
  margin-top: 4px;
  font-family: var(--rr-font-mono);
  font-size: 10px;
  letter-spacing: 0;
  text-transform: none;
  color: var(--rr-ink2);
}

.lal__subhead {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  padding: 4px 0;
}

.lal__searchwrap,
.lal__limitwrap {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--rr-font-mono);
}

.lal__searchlbl {
  font-size: 11px;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--rr-dim);
}

.lal__searchinput,
.lal__limitinput {
  background: var(--rr-bg2);
  color: var(--rr-ink);
  border: 1px solid var(--rr-border);
  padding: 3px 8px;
  font-family: var(--rr-font-mono);
  font-size: 11.5px;
}

.lal__searchinput {
  min-width: 320px;
}

.lal__limitinput {
  width: 60px;
}

.lal__nomatch {
  padding: 24px 18px;
  font-family: var(--rr-font-mono);
  font-size: 11.5px;
  color: var(--rr-dim);
  text-align: center;
  font-style: italic;
}

.lal__nomatch code {
  font-family: var(--rr-font-mono);
  background: var(--rr-bg2);
  padding: 1px 5px;
  font-style: normal;
  color: var(--rr-ink);
}

.lal__hdrec {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 8px 10px;
  background: var(--rr-bg2);
  border-right: 1px solid var(--rr-border);
  border-bottom: 2px solid transparent;
  cursor: default;
}

.lal__hdrec--pinned {
  border-bottom-color: var(--rr-accent, var(--rr-active));
}

.lal__hdrtitle {
  color: var(--rr-heading);
  font-size: 11px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.lal__expandbtn {
  margin-left: auto;
  background: transparent;
  border: 1px solid var(--rr-border);
  color: var(--rr-dim);
  font-family: var(--rr-font-mono);
  font-size: 11px;
  width: 20px;
  height: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
}

.lal__expandbtn:hover {
  color: var(--rr-heading);
  border-color: var(--rr-ink2);
}

.lal__steplbl {
  position: sticky;
  left: 0;
  z-index: 1;
  padding: 10px 10px;
  background: var(--rr-bg);
  border-right: 1px solid var(--rr-border);
  border-bottom: 1px solid var(--rr-border);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.lal__stepkind {
  color: var(--rr-dim);
  font-size: 10.5px;
  letter-spacing: 0.6px;
  text-transform: uppercase;
}

.lal__stepname {
  font-family: var(--rr-font-mono);
  font-size: 12px;
  color: var(--rr-heading);
  word-break: break-word;
  line-height: 1.3;
}

.lal__stepname code {
  font-family: var(--rr-font-mono);
  background: transparent;
  padding: 0;
}

.lal__stepct {
  color: var(--rr-dim);
  font-size: 10px;
}

.lal__cell {
  padding: 8px 10px;
  border-right: 1px solid var(--rr-border);
  border-bottom: 1px solid var(--rr-border);
  display: flex;
  flex-direction: column;
  gap: 6px;
  cursor: pointer;
  background: transparent;
  min-width: 0;
}

.lal__cell:hover {
  background: var(--rr-bg2);
}

.lal__cell--pinned {
  background: rgba(143, 175, 199, 0.05);
}

.lal__cell--selected,
.lal__cell--selected:hover {
  background: var(--rr-bg3);
  outline: 1px solid var(--rr-accent, var(--rr-active));
  outline-offset: -1px;
}

.lal__cell--missing {
  cursor: default;
  background: var(--rr-bg);
  opacity: 0.5;
}

.lal__cellabsent {
  color: var(--rr-dim);
  font-style: italic;
  font-size: 11px;
}

.lal__kvs {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px 8px;
}

.lal__kv {
  display: contents;
}

.lal__kvk {
  color: var(--rr-dim);
  font-size: 10px;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  align-self: center;
}

.lal__kvv {
  color: var(--rr-ink);
  word-break: break-all;
  font-size: 11px;
}

.lal__body {
  background: var(--rr-bg2);
  border: 1px solid var(--rr-border);
  padding: 4px 6px;
  color: var(--rr-ink2);
  font-size: 10.5px;
  line-height: 1.4;
  word-break: break-all;
  white-space: pre-wrap;
}

.lal__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}

.lal__taggroup {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px;
}

.lal__tagheader {
  font-family: var(--rr-font-mono);
  font-size: 9.5px;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--rr-dim);
  margin-right: 4px;
  flex-shrink: 0;
}

.lal__tag {
  padding: 1px 5px;
  font-size: 10px;
  border: 1px solid var(--rr-border);
  background: var(--rr-bg);
  color: var(--rr-ink2);
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lal__tag--orig {
  color: var(--rr-ink2);
}

.lal__tag--add {
  color: var(--rr-accent, var(--rr-active));
  border-color: var(--rr-accent, var(--rr-active));
}

.lal__tag--over {
  color: var(--rr-warn, #d6a96d);
  border-color: var(--rr-warn, #d6a96d);
}

.lal__abort {
  color: var(--rr-warn, #d6a96d);
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.6px;
}

.lal__histbanner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  background: var(--rr-bg2);
  border: 1px solid var(--rr-warn, #d6a96d);
  border-left-width: 3px;
  font-family: var(--rr-font-mono);
  font-size: 11.5px;
  color: var(--rr-ink2);
}

.lal__histbicon {
  color: var(--rr-warn, #d6a96d);
  font-size: 13px;
}

.lal__histback {
  margin-left: auto;
  background: transparent;
  border: 1px solid var(--rr-border);
  color: var(--rr-ink2);
  font-family: var(--rr-font-mono);
  font-size: 11px;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  padding: 3px 10px;
  cursor: pointer;
}

.lal__histback:hover {
  color: var(--rr-heading);
  border-color: var(--rr-ink2);
}
</style>
