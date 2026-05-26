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
 * MAL live-debugger view. Hosted in `<DebugView>`.
 *
 * The wire emits one `SessionRecord` per execution. Each record
 * carries `samples[]` whose entries discriminate via `type` (input |
 * filter | function | output for MAL). Non-output samples carry the
 * `SampleFamily.toJson()` shape (`samples`, `empty`, nested
 * `items[]`); output samples carry the materialised metric
 * (`metric`, `entity`, `valueType`, `value`, `timeBucket`).
 */
import { computed, ref, shallowRef, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import type {
  BundledEntry,
  Catalog,
  ListEnvelope,
  ListRow,
  MalOutputPayload,
  MalSampleRow as MalSampleItem,
  MalSamplesPayload,
  NodeSlice,
  SessionRecord,
  SessionResponse,
  SessionSample,
} from '@skywalking-horizon-ui/api-client';
import { bff } from '@/api/client';
import { useDebugSession } from '@/features/operate/live-debug/useDebugSession';
import { useDebugHistory, type HistoryEntry } from '@/features/operate/live-debug/useDebugHistory';
import Btn from '@/components/primitives/Btn.vue';
import DebugView from './DebugView.vue';
import { isMalOutputPayload, isMalSamplesPayload, shortHash } from './payload.js';
import {
  DEFAULT_RETENTION_MINUTES,
  MS_PER_MINUTE,
  RECORD_CAP_MAX,
} from './constants.js';

interface RuleOption {
  catalog: Catalog;
  name: string;
  contentHash: string;
}

const MAL_CATALOGS: Catalog[] = ['otel-rules', 'log-mal-rules', 'telegraf-rules'];

const route = useRoute();
const dbg = useDebugSession('mal');
const history = useDebugHistory('mal');
/** A MAL "rule" in the catalog is a YAML **file** (rule-set) — e.g.
 *  `vm`, `mysql-exporter`. It contains many individual metrics under
 *  `metricsRules:`. The OAP debug install keys on
 *  `(catalog=<otel-rules|...>, name=<file>, ruleName=<metric>)`, so
 *  the picker has two levels: the file (selectedKey) AND a metric
 *  drilled out of the file's YAML body. */
const selectedKey = ref<string>('');
const selectedMetric = ref<string>('');
// SessionLimits.MAX_RECORD_CAP on the OAP side is 100 (and so is the
// default). The input is bounded the same way; lower if a single
// execution is enough or you want the captured page tighter.
const recordCap = ref<number>(RECORD_CAP_MAX);
const retentionMinutes = ref<number>(DEFAULT_RETENTION_MINUTES);

/** Deep-link from a MAL rule card / catalog entry — `?catalog=&name=`
 *  pre-selects the file. Optional `?ruleName=` pre-fills the metric
 *  too (used by future fine-grained deep-links). */
watch(
  () => [route.query.catalog, route.query.name, route.query.ruleName] as const,
  ([c, n, r]) => {
    if (typeof c === 'string' && typeof n === 'string' && c.length > 0 && n.length > 0) {
      selectedKey.value = `${c}/${n}`;
    }
    if (typeof r === 'string' && r.length > 0) {
      selectedMetric.value = r;
    }
  },
  { immediate: true },
);


// Per-catalog picker feed: union of `/runtime/rule/list` (runtime +
// dslManager-tracked) and `/runtime/rule/bundled` (every shipped MAL
// rule). On a fresh OAP `/list` is empty for these catalogs so the
// merge is what makes the dropdown non-empty.
const listQueries = MAL_CATALOGS.map((catalog) =>
  useQuery({
    queryKey: ['debug-mal/list', catalog],
    queryFn: async (): Promise<ListEnvelope> => bff.dsl.catalogList(catalog),
  }),
);
const bundledQueries = MAL_CATALOGS.map((catalog) =>
  useQuery({
    queryKey: ['debug-mal/bundled', catalog],
    queryFn: async (): Promise<BundledEntry[]> => bff.dsl.catalogBundled(catalog, false),
  }),
);

const ruleOptions = computed<RuleOption[]>(() => {
  const seen = new Map<string, RuleOption>();
  for (let i = 0; i < MAL_CATALOGS.length; i++) {
    const catalog = MAL_CATALOGS[i]!;
    const env = listQueries[i]!.data.value;
    if (env) {
      for (const r of env.rules as ListRow[]) {
        seen.set(`${r.catalog}/${r.name}`, {
          catalog: r.catalog,
          name: r.name,
          contentHash: r.contentHash,
        });
      }
    }
    const bundled = bundledQueries[i]!.data.value;
    if (bundled) {
      for (const e of bundled) {
        const key = `${catalog}/${e.name}`;
        if (seen.has(key)) continue; // runtime row wins
        seen.set(key, { catalog, name: e.name, contentHash: e.contentHash });
      }
    }
  }
  return [...seen.values()].sort((a, b) =>
    `${a.catalog}/${a.name}`.localeCompare(`${b.catalog}/${b.name}`),
  );
});

const selectedRule = computed<RuleOption | null>(() => {
  if (!selectedKey.value) return null;
  return ruleOptions.value.find((r) => `${r.catalog}/${r.name}` === selectedKey.value) ?? null;
});

/** Fetch the selected MAL rule's YAML so we can parse the
 *  `metricsRules[].name` list and let the operator pick a metric to
 *  debug. Falls through to bundled-content automatically since the
 *  BFF's `/api/rule` proxy serves bundled fallback when no runtime
 *  row exists. */
const ruleContentQuery = useQuery({
  queryKey: computed(() => [
    'debug-mal/content',
    selectedRule.value?.catalog,
    selectedRule.value?.name,
  ]),
  queryFn: async (): Promise<string | null> => {
    const r = selectedRule.value;
    if (!r) return null;
    const got = await bff.dsl.getRule({ catalog: r.catalog, name: r.name });
    return got?.content ?? null;
  },
  enabled: computed(() => selectedRule.value !== null),
  staleTime: 30_000,
});

/** Extract metric names from the rule body. A MAL rule file is YAML
 *  with an optional top-level `metricPrefix:` and `metricsRules:`
 *  followed by `- name: <inner>` entries. The OAP registers each
 *  metric under the **composed** name `<prefix>_<inner>` (the bare
 *  inner name is not a debug key — installs against it 404 with
 *  `rule_not_found`). We regex-scan rather than fully parse YAML to
 *  keep the bundle dependency-free; the structure is rigid enough
 *  that a simple match is reliable. */
const METRIC_PREFIX_RE = /^metricPrefix:[ \t]*([A-Za-z_][A-Za-z0-9_]*)/m;
const METRIC_NAME_RE = /^[ \t]*-[ \t]+name:[ \t]*([A-Za-z_][A-Za-z0-9_]*)/gm;
const metricNames = computed<string[]>(() => {
  const c = ruleContentQuery.data.value;
  if (!c) return [];
  const prefixMatch = METRIC_PREFIX_RE.exec(c);
  const prefix = prefixMatch?.[1] ?? '';
  const seen = new Set<string>();
  for (const m of c.matchAll(METRIC_NAME_RE)) {
    const inner = m[1]!;
    seen.add(prefix === '' ? inner : `${prefix}_${inner}`);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
});

/** Reconcile the deep-link `?ruleName=` against the parsed metric
 *  list once the file's YAML has loaded. Deep-links from the editor's
 *  gutter ▶ and the catalog row carry the **bare** inner `name:` value
 *  (e.g. `filtered_requests`), but the MAL install key is the composed
 *  `<metricPrefix>_<inner>` (e.g. `e2e_dsldbg_filtered_requests`). If
 *  the bare form arrives, resolve it to the unique composed entry that
 *  ends in `_<bare>`; only clear when no match exists in the loaded
 *  file (i.e. truly stale link). */
watch(metricNames, (names) => {
  if (names.length === 0 || !selectedMetric.value) return;
  if (names.includes(selectedMetric.value)) return;
  const bare = selectedMetric.value;
  const suffix = `_${bare}`;
  const matches = names.filter((n) => n === bare || n.endsWith(suffix));
  if (matches.length === 1) {
    selectedMetric.value = matches[0]!;
  } else {
    selectedMetric.value = '';
  }
});

const startEnabled = computed(() => {
  const s = dbg.state.value;
  return (
    selectedRule.value !== null &&
    selectedMetric.value !== '' &&
    (s === 'idle' || s === 'captured' || s === 'stopped' || s === 'error')
  );
});

const stopEnabled = computed(
  () => dbg.state.value === 'capturing' || dbg.state.value === 'starting',
);

async function startSampling(): Promise<void> {
  const rule = selectedRule.value;
  if (!rule || !selectedMetric.value) return;
  await dbg.start({
    catalog: rule.catalog,
    name: rule.name,
    ruleName: selectedMetric.value,
    recordCap: recordCap.value,
    retentionMillis: retentionMinutes.value * MS_PER_MINUTE,
  });
}

interface MalBefore {
  samples: MalSamplesPayload | null;
  output: MalOutputPayload | null;
}

interface MalSampleRow {
  rec: SessionRecord;
  recordIdx: number;
  nodeKey: string;
  sample: SessionSample;
  samples: MalSamplesPayload | null;
  output: MalOutputPayload | null;
  /** Previous sample's payload — what this step received as input.
   *  Null on the first sample (no upstream step). */
  before: MalBefore | null;
}

interface MalRecordView {
  rec: SessionRecord;
  recordIdx: number;
  rows: MalSampleRow[];
}

interface MalNodeView extends NodeSlice {
  recordViews: MalRecordView[];
}

// ── Historical replay ──────────────────────────────────────────────

/** When set, the view renders this saved capture instead of the live
 *  session. The composable's polling state (state/error/peerAcks) is
 *  left alone — start/stop still talks to OAP. The historical banner
 *  surfaces "you're not looking at live data" with a back button. */
const historicalEntry = shallowRef<HistoryEntry | null>(null);

const displaySession = computed<SessionResponse | null>(
  () => historicalEntry.value?.session ?? dbg.session.value,
);

/* Transient view state — declared HERE (not at their original
 * definition sites further below) because `loadHistorical` resets them
 * and the `watch(historyId, …, { immediate: true })` further down runs
 * synchronously during setup. With the refs declared below
 * `loadHistorical`, an `?historyId=` deep-link would throw a TDZ
 * ReferenceError on the immediate fire — the page would blank without
 * any console error visible. The original `const` decls (selectRow /
 * isEntityExpanded / foldedRecords helpers) further down now build on
 * these. */
const selectedRow = ref<MalSampleRow | null>(null);
const expandedEntities = ref<Set<string>>(new Set());
const foldedRecords = ref<Set<string>>(new Set());

function loadHistorical(entry: HistoryEntry): void {
  historicalEntry.value = entry;
  selectedKey.value = `${entry.catalog}/${entry.name}`;
  selectedMetric.value = entry.ruleName;
  if (entry.recordCap !== undefined) recordCap.value = entry.recordCap;
  if (entry.retentionMillis !== undefined) {
    retentionMinutes.value = Math.max(1, Math.round(entry.retentionMillis / MS_PER_MINUTE));
  }
  // Reset transient view state so the historical capture lands clean.
  selectedRow.value = null;
  expandedEntities.value = new Set();
  foldedRecords.value = new Set();
}

function clearHistorical(): void {
  historicalEntry.value = null;
  selectedRow.value = null;
}

/** Deep-link from `/operate/live-debug/history` — `?historyId=<id>`
 *  loads that saved capture. Reload-safe (storage is the same browser
 *  store the history page reads). When the id is removed from the
 *  URL, the view falls back to live.
 *
 *  Look-up uses `history.all` (NOT `entries`): `entries` is filtered
 *  by the bound widget, and an entry written under a stale or
 *  mismatched `widget` field would be silently filtered out, leaving
 *  the page blank. We've already routed to the right widget by the
 *  time we land here; the id alone is the join key. */
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

/** Auto-save during capture. We watch both `sessionId` (set the
 *  moment dbg.start resolves) and `session` (replaced on each poll)
 *  so the entry shows up in history immediately — even before any
 *  poll has returned data. Subsequent polls upsert the same entry by
 *  sessionId; localStorage writes are skipped when nothing changed.
 *  Skipped entirely while replaying history. */
function persistCapture(): void {
  if (historicalEntry.value !== null) return;
  const id = dbg.sessionId.value;
  if (!id) return;
  const rule = selectedRule.value;
  if (!rule || !selectedMetric.value) return;
  // Synthesize a placeholder session when polls haven't yet returned
  // — keeps the history entry findable from the moment OAP allocates
  // the session id.
  const sess: SessionResponse = dbg.session.value ?? {
    sessionId: id,
    capturedAt: Date.now(),
    nodes: [],
  };
  history.save({
    widget: 'mal',
    catalog: rule.catalog,
    name: rule.name,
    ruleName: selectedMetric.value,
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

/** Resume an active session in this tab — `?resumeSessionId=<id>`
 *  attaches polling to an already-allocated OAP session (typical
 *  flow: operator clicked an "active" entry on /debug/history). The
 *  matching history entry supplies the rule selection + retention
 *  deadline so the controls + countdown reflect reality. */
watch(
  () => route.query.resumeSessionId,
  (id) => {
    if (typeof id !== 'string' || id === '') return;
    if (dbg.sessionId.value === id) return;
    // Cross-widget lookup for the same reason as the historyId watch:
    // routing already pinned us to the right widget, and a mismatched
    // entry.widget shouldn't silently swallow the lookup.
    const entry = history.all.value.find((e) => e.session.sessionId === id);
    if (!entry) return;
    selectedKey.value = `${entry.catalog}/${entry.name}`;
    selectedMetric.value = entry.ruleName;
    if (entry.recordCap !== undefined) recordCap.value = entry.recordCap;
    if (entry.retentionMillis !== undefined) {
      retentionMinutes.value = Math.max(1, Math.round(entry.retentionMillis / MS_PER_MINUTE));
    }
    dbg.resume(id, entry.retentionDeadline ?? null);
  },
  { immediate: true },
);

const nodeViews = computed<MalNodeView[]>(() => {
  const s = displaySession.value;
  if (!s) return [];
  // OAP's session payload isn't guaranteed to list nodes in the same
  // order across polls. Without a stable sort the per-node cards
  // visibly reshuffle every refresh — hard to track which node moved.
  // Sort by nodeKey (nodeId / peer) so each card stays in place.
  const sortedNodes = s.nodes.slice().sort((a, b) => {
    const ak = a.nodeId ?? a.peer ?? '?';
    const bk = b.nodeId ?? b.peer ?? '?';
    return ak.localeCompare(bk);
  });
  return sortedNodes.map((n) => {
    const nKey = n.nodeId ?? n.peer ?? '?';
    const recordViews: MalRecordView[] = (n.records ?? []).map((rec, ri) => {
      const rows: MalSampleRow[] = [];
      let prevSamples: MalSamplesPayload | null = null;
      let prevOutput: MalOutputPayload | null = null;
      for (const sample of rec.samples ?? []) {
        const thisSamples = isMalSamplesPayload(sample.payload) ? sample.payload : null;
        const thisOutput = isMalOutputPayload(sample.payload) ? sample.payload : null;
        rows.push({
          rec,
          recordIdx: ri,
          nodeKey: nKey,
          sample,
          samples: thisSamples,
          output: thisOutput,
          before:
            rows.length === 0 ? null : { samples: prevSamples, output: prevOutput },
        });
        prevSamples = thisSamples;
        prevOutput = thisOutput;
      }
      return { rec, recordIdx: ri, rows };
    });
    return { ...n, recordViews };
  });
});

function nodeKey(n: NodeSlice): string {
  return n.nodeId ?? n.peer ?? '?';
}

function formatTime(ms: number): string {
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
function metricLabel(rec: SessionRecord): string {
  const r = rec.rule;
  if (r.metricPrefix && r.name) return `${r.metricPrefix}_${r.name}`;
  return r.name ?? r.ruleName;
}

// ── Click-to-select for source-pane highlight ──────────────────────

/** Single-row selection: clicking a step's label marks it selected,
 *  which (a) lights up the rail dot, (b) opens the top source pane
 *  with the captured DSL, and (c) `<mark>`s the matching expression
 *  fragment inside that DSL. Click the same row again to clear.
 *  `selectedRow` itself is declared above `loadHistorical` to dodge
 *  a TDZ crash on `?historyId=` deep-links. */

function selectRow(row: MalSampleRow): void {
  selectedRow.value = selectedRow.value === row ? null : row;
}

interface FlatRow {
  name: string;
  labels: Record<string, string>;
  value: number;
}

const ROWS_CAP = 50;

/** Total leaf-row count across both shapes (flat per-stage items, or
 *  nested per-family items on the file-level filter probe). Drives
 *  the `in → out` counts on every stage label. */
function countRows(p: MalSamplesPayload | null): number {
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

/** Flatten any payload (flat or nested) to up to ROWS_CAP `{name,
 *  labels, value}` rows for the right-pane RowsTable. */
function flattenRows(p: MalSamplesPayload | null): FlatRow[] {
  if (!p || p.empty === true || !p.items || p.items.length === 0) return [];
  const out: FlatRow[] = [];
  const first = p.items[0]! as MalSampleItem & MalSamplesPayload;
  const isFlat = typeof first.name === 'string' && typeof first.value === 'number';
  if (isFlat) {
    for (const it of p.items as MalSampleItem[]) {
      if (out.length >= ROWS_CAP) break;
      out.push({ name: it.name, labels: it.labels ?? {}, value: it.value });
    }
  } else {
    for (const fam of p.items as MalSamplesPayload[]) {
      if (fam.empty === true) continue;
      for (const it of (fam.items ?? []) as MalSampleItem[]) {
        if (out.length >= ROWS_CAP) break;
        if (typeof it.name !== 'string') continue;
        out.push({ name: it.name, labels: it.labels ?? {}, value: it.value });
      }
    }
  }
  return out;
}

function labelLines(labels: Record<string, string>): string[] {
  const entries = Object.entries(labels);
  if (entries.length === 0) return [];
  return entries.map(([k, v]) => `${k}=${v}`);
}

function inCountStr(row: MalSampleRow): string {
  if (row.before === null) return '—';
  if (row.before.output) return '1';
  return String(countRows(row.before.samples));
}

function outCountStr(row: MalSampleRow): string {
  if (row.output) return '1';
  return String(countRows(row.samples));
}

function isDrop(row: MalSampleRow): boolean {
  if (row.output) return false;
  if (row.before === null) return false;
  if (row.before.output) return false;
  return countRows(row.samples) < countRows(row.before.samples);
}

interface Segment {
  text: string;
  highlight: boolean;
}

/** The selected step's expression fragment — empty when nothing is
 *  selected, so meta-strip highlights collapse to no-ops. */
const selectedFragment = computed<string>(() =>
  selectedRow.value?.sample.sourceText.trim() ?? '',
);

/** Split a rule field into highlight / plain segments around every
 *  exact occurrence of the selected step's `sourceText`. Drives the
 *  inline `<mark>` collaborative highlight inside `metric / filter /
 *  exp / suffix` — clicking a step makes the matching expression light
 *  up in the rule definition above the chain. */
function highlightSegments(text: string | undefined, fragment: string): Segment[] {
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

// ── Entity expansion (output sample) ────────────────────────────────

interface EntityField {
  k: string;
  v: string;
}

/** Parse OAP's `MeterEntity#toString()` shape `Name(k=v, k=v, ...)`
 *  into kv pairs. Fields are flat — no commas inside values for the
 *  shipped scope set — so a naive split is fine. */
function parseEntity(s: string): EntityField[] {
  const m = s.match(/^[^(]+\((.*)\)$/);
  if (!m) return [];
  return m[1]!.split(', ').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq < 0) return { k: pair, v: '' };
    return { k: pair.slice(0, eq), v: pair.slice(eq + 1) };
  });
}

function entityFields(s: string, includeNulls: boolean): EntityField[] {
  const all = parseEntity(s);
  return includeNulls ? all : all.filter((f) => f.v !== 'null');
}

// `expandedEntities` is declared above `loadHistorical` (TDZ guard).

function rowEntityKey(row: MalSampleRow): string {
  return `${row.nodeKey}:${row.recordIdx}`;
}

function isEntityExpanded(row: MalSampleRow): boolean {
  return expandedEntities.value.has(rowEntityKey(row));
}

// ── Per-record fold state + fold/expand all ────────────────────────
// `foldedRecords` is declared above `loadHistorical` (TDZ guard).

function recordFoldKey(nodeKey: string, recordIdx: number): string {
  return `${nodeKey}#${recordIdx}`;
}

function isRecordFolded(nodeKey: string, recordIdx: number): boolean {
  return foldedRecords.value.has(recordFoldKey(nodeKey, recordIdx));
}

function toggleRecord(nodeKey: string, recordIdx: number): void {
  const k = recordFoldKey(nodeKey, recordIdx);
  const next = new Set(foldedRecords.value);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  foldedRecords.value = next;
}

function foldAllRecords(): void {
  const next = new Set<string>();
  for (const n of nodeViews.value) {
    const nKey = n.nodeId ?? n.peer ?? '?';
    for (const rv of n.recordViews) {
      next.add(recordFoldKey(nKey, rv.recordIdx));
    }
  }
  foldedRecords.value = next;
}

function expandAllRecords(): void {
  foldedRecords.value = new Set();
}

const totalRecordCount = computed<number>(() => {
  let n = 0;
  for (const v of nodeViews.value) n += v.recordViews.length;
  return n;
});

const allFolded = computed<boolean>(
  () => totalRecordCount.value > 0 && foldedRecords.value.size === totalRecordCount.value,
);

function toggleEntity(row: MalSampleRow): void {
  const k = rowEntityKey(row);
  const next = new Set(expandedEntities.value);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  expandedEntities.value = next;
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
function formatOutputValue(v: number | string | Record<string, number>): string {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  const entries = Object.entries(v);
  if (entries.length === 0) return '{}';
  return entries.map(([k, n]) => `${k}=${n}`).join(' · ');
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
        <label class="ctl__lbl">rule file</label>
        <select v-model="selectedKey" class="ctl__select">
          <option value="" disabled>select a MAL rule file…</option>
          <option v-for="r in ruleOptions" :key="`${r.catalog}/${r.name}`" :value="`${r.catalog}/${r.name}`">
            {{ r.catalog }} · {{ r.name }} · {{ shortHash(r.contentHash) }}
          </option>
        </select>
      </div>
      <div class="ctl">
        <label class="ctl__lbl">metric</label>
        <select
          v-model="selectedMetric"
          class="ctl__select"
          :disabled="selectedRule === null || ruleContentQuery.isPending.value"
        >
          <option value="" disabled>
            {{ selectedRule === null
                ? 'pick a file first…'
                : ruleContentQuery.isPending.value
                  ? 'loading…'
                  : metricNames.length === 0
                    ? 'no metricsRules found in file'
                    : 'select a metric…' }}
          </option>
          <option v-for="m in metricNames" :key="m" :value="m">{{ m }}</option>
        </select>
      </div>
      <div class="ctl">
        <label class="ctl__lbl">recordCap</label>
        <input v-model.number="recordCap" type="number" min="1" :max="RECORD_CAP_MAX" class="ctl__input" />
      </div>
      <div class="ctl">
        <label class="ctl__lbl">retention (min)</label>
        <input v-model.number="retentionMinutes" type="number" min="1" max="60" class="ctl__input" />
      </div>
      <Btn kind="primary" :disabled="!startEnabled" @click="startSampling">start sampling</Btn>
      <Btn kind="ghost" :disabled="!stopEnabled" @click="dbg.stop()">stop</Btn>
      <router-link
        class="ctl__editlink"
        to="/operate/live-debug/history"
        title="browse past captures saved locally"
      >history ({{ history.entries.value.length }}) →</router-link>
      <router-link
        v-if="selectedRule"
        class="ctl__editlink"
        :to="{ path: '/operate/dsl/edit', query: { catalog: selectedRule.catalog, name: selectedRule.name } }"
        :title="`open ${selectedRule.catalog} · ${selectedRule.name} in the editor`"
      >open in editor →</router-link>
    </template>

    <template #banner>
      <div v-if="historicalEntry" class="mal__histbanner">
        <span class="mal__histbicon">⟲</span>
        <span>
          viewing saved capture from <strong>{{ formatTime(historicalEntry.savedAt) }}</strong>
          · {{ historicalEntry.catalog }} · {{ historicalEntry.name }} · {{ historicalEntry.ruleName }}
        </span>
        <button type="button" class="mal__histback" @click="clearHistorical">back to live</button>
      </div>
    </template>

    <template #subhead>
      <div v-if="totalRecordCount > 0" class="mal__subhead">
        <span class="mal__subheadct">{{ totalRecordCount }} records · {{ foldedRecords.size }} folded</span>
        <div class="mal__subheadbtns">
          <button
            type="button"
            class="mal__subheadbtn"
            :disabled="allFolded"
            @click="foldAllRecords"
          >fold all</button>
          <button
            type="button"
            class="mal__subheadbtn"
            :disabled="foldedRecords.size === 0"
            @click="expandAllRecords"
          >expand all</button>
        </div>
      </div>
    </template>

    <template #idle-hint>
      pick a rule and hit start. each captured execution renders as a
      record card; rows inside walk the chain
      <code>input → filter → function → output</code> with
      <em>before</em> / <em>exp</em> / <em>after</em> for every step.
      click a row to inspect its captured DSL on the source pane (toggle
      "show source" in the capture header).
    </template>

    <template #node-body="{ node }">
      <div v-if="node.recordViews.length === 0" class="mal__empty">
        no MAL records from this node
      </div>
      <div v-else class="mal__records">
        <article
          v-for="rv in node.recordViews"
          :key="`${nodeKey(node)}-${rv.recordIdx}`"
          class="mal__rec"
          :class="{ 'mal__rec--folded': isRecordFolded(nodeKey(node), rv.recordIdx) }"
        >
          <header
            class="mal__rech"
            @click="toggleRecord(nodeKey(node), rv.recordIdx)"
          >
            <span class="mal__reccaret">{{ isRecordFolded(nodeKey(node), rv.recordIdx) ? '▸' : '▾' }}</span>
            <span class="mal__recidx">#{{ rv.recordIdx + 1 }}</span>
            <span class="mal__rectime">{{ formatTime(rv.rec.startedAtMs) }}</span>
            <span class="mal__recmeta">{{ rv.rows.length }} steps</span>
          </header>
          <template v-if="!isRecordFolded(nodeKey(node), rv.recordIdx)">
          <dl class="mal__rmeta">
            <div class="mal__rmpair">
              <dt>metric</dt>
              <dd><code>{{ metricLabel(rv.rec) }}</code></dd>
            </div>
            <div v-if="rv.rec.rule.filter" class="mal__rmpair">
              <dt>filter</dt>
              <dd><code><template
                v-for="(seg, i) in highlightSegments(rv.rec.rule.filter, selectedFragment)"
                :key="i"
              ><mark
                v-if="seg.highlight"
                class="mal__hl"
              >{{ seg.text }}</mark><template v-else>{{ seg.text }}</template></template></code></dd>
            </div>
            <div v-if="rv.rec.rule.exp" class="mal__rmpair">
              <dt>exp</dt>
              <dd><code><template
                v-for="(seg, i) in highlightSegments(rv.rec.rule.exp, selectedFragment)"
                :key="i"
              ><mark
                v-if="seg.highlight"
                class="mal__hl"
              >{{ seg.text }}</mark><template v-else>{{ seg.text }}</template></template></code></dd>
            </div>
            <div v-if="rv.rec.rule.expSuffix" class="mal__rmpair">
              <dt>suffix</dt>
              <dd><code><template
                v-for="(seg, i) in highlightSegments(rv.rec.rule.expSuffix, selectedFragment)"
                :key="i"
              ><mark
                v-if="seg.highlight"
                class="mal__hl"
              >{{ seg.text }}</mark><template v-else>{{ seg.text }}</template></template></code></dd>
            </div>
          </dl>
          <div class="mal__stages">
            <template v-for="(row, idx) in rv.rows" :key="`${rv.recordIdx}-${idx}`">
              <div
                class="mal__stagelbl"
                :class="{
                  'mal__stagelbl--selected': selectedRow === row,
                  'mal__stagelbl--stopped': !row.sample.continueOn,
                }"
                @click="selectRow(row)"
              >
                <div class="mal__stagekind">{{ row.sample.type }}</div>
                <div class="mal__stagelabel">
                  <code>{{ row.sample.sourceText || '—' }}</code>
                </div>
                <div class="mal__stageio">
                  {{ inCountStr(row) }}
                  <span class="mal__arrow">→</span>
                  <span :class="{ 'mal__warn': isDrop(row) }">{{ outCountStr(row) }}</span>
                  <span
                    v-if="!row.sample.continueOn"
                    class="mal__stopflag"
                    title="chain stopped here"
                  >stopped</span>
                </div>
              </div>
              <div class="mal__rail">
                <div class="mal__railline" :class="{ 'mal__railline--last': idx === rv.rows.length - 1 }"></div>
                <div
                  class="mal__raildot"
                  :class="{
                    'mal__raildot--selected': selectedRow === row,
                    'mal__raildot--stopped': !row.sample.continueOn,
                    'mal__raildot--terminal': row.output !== null,
                  }"
                ></div>
              </div>
              <div class="mal__stageright" :class="{ 'mal__stageright--selected': selectedRow === row }">
                <template v-if="row.output">
                  <!-- Output payload renders verbatim — every field
                       present on the wire shows up; nothing is
                       inferred from upstream stages. The materialised
                       `value` is optional on the wire (only newer OAP
                       builds serialise it) and renders only when the
                       recorder included it. -->
                  <div class="mal__meter">
                    <div><span class="mal__mlbl">metric</span><span class="mal__mval">{{ row.output.metric }}</span></div>
                    <div><span class="mal__mlbl">function</span><span class="mal__mval">{{ row.output.valueType }}</span></div>
                    <div v-if="row.output.value !== undefined">
                      <span class="mal__mlbl">value</span>
                      <span class="mal__mval mal__mvalnum">{{ formatOutputValue(row.output.value) }}</span>
                    </div>
                    <div><span class="mal__mlbl">timeBucket</span><span class="mal__mval">{{ row.output.timeBucket }}</span></div>
                  </div>
                  <div class="mal__entity">
                    <header class="mal__entityh">
                      <span class="mal__mlbl">entity</span>
                      <button
                        type="button"
                        class="mal__entitytog"
                        @click="toggleEntity(row)"
                      >
                        {{ isEntityExpanded(row) ? 'compact' : 'show all' }}
                      </button>
                    </header>
                    <div class="mal__entitykvs">
                      <div
                        v-for="f in entityFields(row.output.entity, isEntityExpanded(row))"
                        :key="f.k"
                        class="mal__entitykv"
                      >
                        <span class="mal__entityk">{{ f.k }}</span>
                        <span
                          class="mal__entityv"
                          :class="{ 'mal__dim': f.v === 'null' }"
                        >{{ f.v }}</span>
                      </div>
                      <div
                        v-if="!isEntityExpanded(row) && entityFields(row.output.entity, true).length > entityFields(row.output.entity, false).length"
                        class="mal__entitymore"
                      >
                        + {{ entityFields(row.output.entity, true).length - entityFields(row.output.entity, false).length }} null fields hidden
                      </div>
                    </div>
                  </div>
                </template>
                <template v-else-if="row.samples?.empty === true">
                  <div class="mal__rtempty">empty family · 0 rows</div>
                </template>
                <template v-else>
                  <table class="mal__rtable">
                    <colgroup>
                      <col class="mal__rtcolname" />
                      <col class="mal__rtcollabels" />
                      <col class="mal__rtcolval" />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>name</th>
                        <th>labels</th>
                        <th class="mal__rtval">value</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(it, j) in flattenRows(row.samples)" :key="j">
                        <td class="mal__rtname">{{ it.name }}</td>
                        <td class="mal__rtlabels">
                          <span v-if="labelLines(it.labels).length === 0" class="mal__dim">—</span>
                          <div v-for="line in labelLines(it.labels)" :key="line" class="mal__rtlabel">{{ line }}</div>
                        </td>
                        <td class="mal__rtval">{{ it.value }}</td>
                      </tr>
                      <tr v-if="flattenRows(row.samples).length === 0">
                        <td colspan="3" class="mal__rtempty">no rows in payload</td>
                      </tr>
                      <tr v-if="countRows(row.samples) > flattenRows(row.samples).length">
                        <td colspan="3" class="mal__rtmore">
                          + {{ countRows(row.samples) - flattenRows(row.samples).length }} more rows
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </template>
              </div>
            </template>
          </div>
          </template>
        </article>
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
  min-width: 320px;
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

.mal__histbanner {
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

.mal__histbicon {
  color: var(--rr-warn, #d6a96d);
  font-size: 13px;
}

.mal__histback {
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

.mal__histback:hover {
  color: var(--rr-heading);
  border-color: var(--rr-ink2);
}

.mal__empty {
  padding: 14px;
  font-size: 12.5px;
  color: var(--rr-dim);
  font-style: italic;
}

.mal__records {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 8px;
}

.mal__rec {
  border: 1px solid var(--rr-border);
  background: var(--rr-bg);
}

.mal__rech {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 10px;
  background: var(--rr-bg3);
  border-bottom: 1px solid var(--rr-border);
  cursor: pointer;
  user-select: none;
}

.mal__rech:hover {
  background: var(--rr-bg2);
}

.mal__reccaret {
  display: inline-block;
  width: 12px;
  text-align: center;
  color: var(--rr-dim);
  font-size: 11px;
}

.mal__rec--folded .mal__rech {
  border-bottom: none;
}

.mal__subhead {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 0;
}

.mal__subheadct {
  font-family: var(--rr-font-mono);
  font-size: 12px;
  color: var(--rr-dim);
  letter-spacing: 0.4px;
}

.mal__subheadbtns {
  display: flex;
  gap: 6px;
  margin-left: auto;
}

.mal__subheadbtn {
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

.mal__subheadbtn:hover:not(:disabled) {
  color: var(--rr-heading);
  border-color: var(--rr-ink2);
}

.mal__subheadbtn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.mal__recidx {
  font-family: var(--rr-font-mono);
  color: var(--rr-heading);
  font-size: 11.5px;
  font-weight: 600;
}

.mal__rectime {
  font-family: var(--rr-font-mono);
  color: var(--rr-ink2);
  font-size: 11.5px;
}

.mal__recmeta {
  margin-left: auto;
  font-family: var(--rr-font-mono);
  color: var(--rr-dim);
  font-size: 11.5px;
}

.mal__rmeta {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 4px 12px;
  margin: 0;
  padding: 8px 12px;
  border-bottom: 1px solid var(--rr-border);
  font-size: 11.5px;
}

.mal__rmpair {
  display: contents;
}

.mal__rmpair dt {
  color: var(--rr-dim);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  align-self: baseline;
}

.mal__rmpair dd {
  margin: 0;
  font-family: var(--rr-font-mono);
  color: var(--rr-ink);
  min-width: 0;
}

.mal__rmpair code {
  font-family: var(--rr-font-mono);
  background: var(--rr-bg2);
  padding: 1px 5px;
  word-break: break-word;
  white-space: pre-wrap;
  display: inline;
}

.mal__stages {
  display: grid;
  grid-template-columns: 200px 32px minmax(0, 1fr);
  padding: 6px 12px 12px;
}

.mal__stagelbl {
  padding: 12px 10px 12px 10px;
  border-left: 2px solid transparent;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.mal__stagelbl:hover {
  background: var(--rr-bg2);
}

.mal__stagelbl--selected,
.mal__stagelbl--selected:hover {
  background: var(--rr-bg3);
  border-left-color: var(--rr-accent, var(--rr-active));
}

.mal__stagelbl--stopped {
  border-left-color: var(--rr-warn, #d6a96d);
}

.mal__stagekind {
  font-family: var(--rr-font-mono);
  font-size: 11px;
  letter-spacing: 1.1px;
  text-transform: uppercase;
  color: var(--rr-dim);
}

.mal__stagelbl--selected .mal__stagekind {
  color: var(--rr-accent, var(--rr-active));
}

.mal__stagelabel {
  font-family: var(--rr-font-mono);
  font-size: 11.5px;
  color: var(--rr-heading);
  word-break: break-word;
  line-height: 1.3;
}

.mal__stagelabel code {
  font-family: var(--rr-font-mono);
  background: transparent;
  padding: 0;
}

.mal__stageio {
  font-family: var(--rr-font-mono);
  font-size: 11px;
  color: var(--rr-dim);
  display: flex;
  align-items: center;
  gap: 5px;
}

.mal__arrow {
  color: var(--rr-ink2);
}

.mal__warn {
  color: var(--rr-warn, #d6a96d);
}

.mal__stopflag {
  margin-left: auto;
  padding: 1px 6px;
  border: 1px solid var(--rr-warn, #d6a96d);
  color: var(--rr-warn, #d6a96d);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  cursor: help;
}

.mal__rail {
  position: relative;
  min-height: 60px;
}

.mal__railline {
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  width: 2px;
  margin-left: -1px;
  background: var(--rr-border);
}

.mal__railline--last {
  bottom: 50%;
}

.mal__raildot {
  position: absolute;
  left: 50%;
  top: 18px;
  width: 10px;
  height: 10px;
  margin-left: -5px;
  border-radius: 50%;
  background: var(--rr-border);
  box-shadow: 0 0 0 3px var(--rr-bg);
}

.mal__raildot--terminal {
  background: var(--rr-ok, #4ec9b0);
}

.mal__raildot--selected {
  background: var(--rr-accent, var(--rr-active));
}

.mal__raildot--stopped {
  background: var(--rr-warn, #d6a96d);
}

.mal__stageright {
  padding: 10px 0 14px 14px;
  min-width: 0;
}

.mal__stageright--selected {
  background: var(--rr-bg3);
}

.mal__rtable {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--rr-font-mono);
  font-size: 12px;
  border: 1px solid var(--rr-border);
  background: var(--rr-bg);
  /* Fixed layout so colgroup widths bind consistently across every
     stage's table — keeps `name` / `labels` / `value` aligned vertically
     down the record card regardless of per-step content length. */
  table-layout: fixed;
}

.mal__rtcolname {
  width: 280px;
}

.mal__rtcolval {
  width: 90px;
}

/* labels column = remaining flex space (no width on the colgroup col). */

.mal__rtable thead tr {
  background: var(--rr-bg2);
}

.mal__rtable th {
  text-align: left;
  padding: 5px 8px;
  font-size: 10px;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  font-weight: 400;
  color: var(--rr-dim);
  border-bottom: 1px solid var(--rr-border);
}

.mal__rtable td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--rr-border);
  vertical-align: top;
}

.mal__rtable tbody tr:last-child td {
  border-bottom: none;
}

.mal__rtname {
  color: var(--rr-heading);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mal__rtlabels {
  color: var(--rr-ink2);
  word-break: break-all;
  line-height: 1.5;
}

.mal__rtlabel {
  white-space: nowrap;
}

.mal__dim {
  color: var(--rr-dim);
  font-style: italic;
}

.mal__rtval {
  text-align: left;
  color: var(--rr-accent, var(--rr-active));
  white-space: nowrap;
  width: 1%;
}

.mal__rtempty {
  padding: 10px;
  color: var(--rr-dim);
  font-style: italic;
  text-align: center;
}

.mal__rtmore {
  padding: 5px 8px;
  color: var(--rr-dim);
  font-style: italic;
  text-align: center;
}

.mal__hl {
  background: var(--rr-accent, var(--rr-active));
  color: var(--rr-bg);
  padding: 1px 2px;
}

.mal__meter {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 14px;
  padding: 10px 12px;
  border: 1px solid var(--rr-border);
  background: var(--rr-bg);
  font-family: var(--rr-font-mono);
  font-size: 11.5px;
}

.mal__meter > div {
  display: contents;
}

.mal__mlbl {
  color: var(--rr-dim);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  align-self: center;
}

.mal__mval {
  color: var(--rr-ink);
  word-break: break-all;
}

.mal__mval code {
  font-family: var(--rr-font-mono);
  background: transparent;
  padding: 0;
}

.mal__mvalnum {
  color: var(--rr-accent, var(--rr-active));
  font-weight: 600;
}


.mal__entity {
  margin-top: 8px;
  border: 1px solid var(--rr-border);
  background: var(--rr-bg);
  font-family: var(--rr-font-mono);
}

.mal__entityh {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--rr-bg2);
  border-bottom: 1px solid var(--rr-border);
}

.mal__entitytog {
  margin-left: auto;
  background: transparent;
  border: 1px solid var(--rr-border);
  color: var(--rr-ink2);
  font-family: var(--rr-font-mono);
  font-size: 10.5px;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  padding: 2px 8px;
  cursor: pointer;
}

.mal__entitytog:hover {
  color: var(--rr-heading);
  border-color: var(--rr-ink2);
}

.mal__entitykvs {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 2px 12px;
  padding: 8px 10px;
  font-size: 12px;
}

.mal__entitykv {
  display: contents;
}

.mal__entityk {
  color: var(--rr-dim);
  font-size: 10.5px;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  align-self: center;
}

.mal__entityv {
  color: var(--rr-ink);
  word-break: break-all;
}

.mal__entitymore {
  grid-column: 1 / -1;
  margin-top: 4px;
  color: var(--rr-dim);
  font-size: 10.5px;
  font-style: italic;
}
</style>
