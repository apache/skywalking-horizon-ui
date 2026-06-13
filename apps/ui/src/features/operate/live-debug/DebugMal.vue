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
import { useI18n } from 'vue-i18n';
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
import {
  formatSampleValue,
  isMalOutputPayload,
  isMalSamplesPayload,
  shortHash,
} from './payload.js';
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

const { t } = useI18n();
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
  /** Set only on the synthetic anchor row that stands in for a run of
   *  ≥2 `output` samples in one record — collapses the repeated meter
   *  cards into one diff-aware summary (same metric / function, one
   *  materialised entity each). */
  outputGroup?: OutputGroup | null;
}

interface MalRecordView {
  rec: SessionRecord;
  recordIdx: number;
  rows: MalSampleRow[];
  /** Rows as rendered: the non-output chain followed by either the lone
   *  output row (rendered as a full meter card) or one anchor row
   *  carrying the merged `outputGroup`. */
  displayRows: MalSampleRow[];
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
/** Per-sample-group view state. A "group" is the set of samples sharing
 *  a metric name within one stage; collapsed by default so a stage that
 *  emits hundreds of rows shows a one-line summary first. When a
 *  multi-sample group is expanded it lands in diff mode by default
 *  (the shared labels collapse, only the differing ones show);
 *  `fullLabelGroups` tracks the groups where the operator opted back
 *  out to the full per-sample label list. Both are keyed by
 *  `groupKey(...)` and reset on historical load (TDZ guard — see the
 *  block comment above). */
const expandedGroups = ref<Set<string>>(new Set());
const fullLabelGroups = ref<Set<string>>(new Set());

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
  expandedGroups.value = new Set();
  fullLabelGroups.value = new Set();
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
      // A MAL record's chain ends with one `output` sample per
      // materialised entity. When more than one fires they repeat the
      // same meter card with only the entity differing — collapse that
      // run into a single anchor carrying an `outputGroup` so the right
      // pane summarises them the same way input sample groups do.
      const outputRows = rows.filter((r) => r.output !== null);
      let displayRows = rows;
      if (outputRows.length > 1) {
        const chainRows = rows.filter((r) => r.output === null);
        const anchor: MalSampleRow = {
          ...outputRows[0]!,
          outputGroup: buildOutputGroup(
            `${nKey}#${ri}#outputs`,
            outputRows.map((r) => r.output!),
          ),
        };
        displayRows = [...chainRows, anchor];
      }
      return { rec, recordIdx: ri, rows, displayRows };
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

// Per-group rendering caps. A stage can emit hundreds of samples; the
// collapsed summary stays cheap, while an expanded group renders at
// most GROUP_DETAIL_CAP detail rows (with a "+ N more" note). The
// summary line previews the first SUMMARY_VALUE_CAP values inline.
const GROUP_DETAIL_CAP = 50;
const SUMMARY_VALUE_CAP = 8;

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

/** One metric-name group within a stage's payload: every leaf row that
 *  shares `name`. `count` is the exact total; `rows` caps at
 *  GROUP_DETAIL_CAP for rendering; `diff` is precomputed only when the
 *  group has >1 sample (the only case the diff toggle is offered). */
interface SampleGroup {
  /** Stage-scoped expand/diff toggle key — see `groupKey`. */
  key: string;
  name: string;
  count: number;
  rows: FlatRow[];
  diff?: GroupDiff;
}

interface DiffCell {
  k: string;
  v: string;
  /** Key present on a sibling sample but missing from this one. */
  absent: boolean;
}

interface GroupDiff {
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
interface OutputGroup {
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

interface OutputRow {
  fields: EntityField[];
  value: string;
  valueRaw: string;
}

/** Walk a payload (flat per-stage items, or nested per-family items on
 *  the file-level filter probe) yielding every `{name, labels, value}`
 *  leaf. Mirrors `countRows`' shape detection. */
function* leafRows(p: MalSamplesPayload | null): Generator<FlatRow> {
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
function diffLabels(maps: Array<Record<string, string>>): {
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
function diffCells(varying: string[], m: Record<string, string>): DiffCell[] {
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
 *  `key` so its toggles stay independent across stages/records/nodes. */
function stageGroups(row: MalSampleRow, stageIdx: number): SampleGroup[] {
  const map = new Map<string, { group: SampleGroup; maps: Array<Record<string, string>> }>();
  for (const r of leafRows(row.samples)) {
    let e = map.get(r.name);
    if (!e) {
      e = {
        group: { key: groupKey(row, stageIdx, r.name), name: r.name, count: 0, rows: [] },
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
    // The diff only renders for an expanded group in diff mode, and the
    // full-set scan is the costly part on high-cardinality stages — so
    // compute it lazily here, skipping collapsed / opted-out groups
    // (the call re-runs reactively when a toggle flips those refs).
    if (isGroupExpanded(group.key) && isDiffMode(group.key, group.count)) {
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
function summaryValues(g: SampleGroup): string {
  const shown = g.rows.slice(0, SUMMARY_VALUE_CAP).map((r) => formatSampleValue(r.value));
  if (g.count > shown.length) shown.push('…');
  return shown.join(', ');
}

/** Non-null entity fields of one output, as a flat record, for diffing. */
function entityRecord(entity: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of entityFields(entity, false)) out[f.k] = f.v;
  return out;
}

/** Collapse a run of `output` samples (same metric / function) into one
 *  diff-aware group. The entity is diffed field-by-field via the same
 *  generic helper the sample groups use — whatever differs surfaces
 *  (endpointName here, but any field for other scopes), with each
 *  output's value kept in its own column. */
function buildOutputGroup(key: string, outputs: MalOutputPayload[]): OutputGroup {
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
function outputSummaryValues(g: OutputGroup): string {
  const shown = g.rows.slice(0, SUMMARY_VALUE_CAP).map((r) => r.value);
  if (g.count > shown.length) shown.push('…');
  return shown.join(', ');
}

// ── Per-group expand / diff state ───────────────────────────────────
// `expandedGroups` / `fullLabelGroups` are declared above `loadHistorical`
// (TDZ guard). Keyed by stage + metric name (or `…#outputs`) so each
// group toggles independently and state survives re-renders across polls.

function groupKey(row: MalSampleRow, stageIdx: number, name: string): string {
  return `${row.nodeKey}#${row.recordIdx}#${stageIdx}#${name}`;
}

function isGroupExpanded(key: string): boolean {
  return expandedGroups.value.has(key);
}

function toggleGroup(key: string): void {
  const next = new Set(expandedGroups.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedGroups.value = next;
}

/** Diff is the default view for any multi-member group — a sample group
 *  with >1 sample or an output group with >1 entity; the operator opts
 *  out into the full per-member list via the toggle. */
function isDiffMode(key: string, count: number): boolean {
  return count > 1 && !fullLabelGroups.value.has(key);
}

function toggleGroupDiff(key: string): void {
  const next = new Set(fullLabelGroups.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  fullLabelGroups.value = next;
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
  if (typeof v === 'number') return formatSampleValue(v);
  if (typeof v === 'string') return v;
  const entries = Object.entries(v);
  if (entries.length === 0) return '{}';
  return entries.map(([k, n]) => `${k}=${formatSampleValue(n)}`).join(' · ');
}

/** Untrimmed output value for the cell `title` — `formatOutputValue`
 *  rounds long floats for display, so the precise number stays reachable
 *  on hover. */
function outputValueRaw(v: number | string | Record<string, number>): string {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  return Object.entries(v)
    .map(([k, n]) => `${k}=${n}`)
    .join(' · ');
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
        <select v-model="selectedKey" class="ctl__select">
          <option value="" disabled>{{ t('select a MAL rule file…') }}</option>
          <option v-for="r in ruleOptions" :key="`${r.catalog}/${r.name}`" :value="`${r.catalog}/${r.name}`">
            {{ r.catalog }} · {{ r.name }} · {{ shortHash(r.contentHash) }}
          </option>
        </select>
      </div>
      <div class="ctl">
        <label class="ctl__lbl">{{ t('metric') }}</label>
        <select
          v-model="selectedMetric"
          class="ctl__select"
          :disabled="selectedRule === null || ruleContentQuery.isPending.value"
        >
          <option value="" disabled>
            {{ selectedRule === null
                ? t('pick a file first…')
                : ruleContentQuery.isPending.value
                  ? t('loading…')
                  : metricNames.length === 0
                    ? t('no metricsRules found in file')
                    : t('select a metric…') }}
          </option>
          <option v-for="m in metricNames" :key="m" :value="m">{{ m }}</option>
        </select>
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
        v-if="selectedRule"
        class="ctl__editlink"
        :to="{ path: '/operate/dsl/edit', query: { catalog: selectedRule.catalog, name: selectedRule.name } }"
        :title="t('open {catalog} · {name} in the editor', { catalog: selectedRule.catalog, name: selectedRule.name })"
      >{{ t('open in editor →') }}</router-link>
    </template>

    <template #banner>
      <div v-if="historicalEntry" class="mal__histbanner">
        <span class="mal__histbicon">⟲</span>
        <i18n-t
          keypath="Viewing saved capture from {time} · {catalog} · {name} · {rule}"
          tag="span"
          scope="global"
        >
          <template #time><strong>{{ formatTime(historicalEntry.savedAt) }}</strong></template>
          <template #catalog>{{ historicalEntry.catalog }}</template>
          <template #name>{{ historicalEntry.name }}</template>
          <template #rule>{{ historicalEntry.ruleName }}</template>
        </i18n-t>
        <button type="button" class="mal__histback" @click="clearHistorical">{{ t('back to live') }}</button>
      </div>
    </template>

    <template #subhead>
      <div v-if="totalRecordCount > 0" class="mal__subhead">
        <span class="mal__subheadct">{{ t('{n} records · {folded} folded', { n: totalRecordCount, folded: foldedRecords.size }) }}</span>
        <div class="mal__subheadbtns">
          <button
            type="button"
            class="mal__subheadbtn"
            :disabled="allFolded"
            @click="foldAllRecords"
          >{{ t('fold all') }}</button>
          <button
            type="button"
            class="mal__subheadbtn"
            :disabled="foldedRecords.size === 0"
            @click="expandAllRecords"
          >{{ t('expand all') }}</button>
        </div>
      </div>
    </template>

    <template #idle-hint>
      <i18n-t
        keypath="Pick a rule and hit start. Each captured execution renders as a record card; rows inside walk the chain {chain} with {before} / {exp} / {after} for every step. Click a row to inspect its captured DSL on the source pane (toggle “show source” in the capture header)."
        tag="span"
        scope="global"
      >
        <template #chain><code>input → filter → function → output</code></template>
        <template #before><em>before</em></template>
        <template #exp><em>exp</em></template>
        <template #after><em>after</em></template>
      </i18n-t>
    </template>

    <template #node-body="{ node }">
      <div v-if="node.recordViews.length === 0" class="mal__empty">
        {{ t('no MAL records from this node') }}
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
            <span class="mal__recmeta">{{ t('{n} steps', { n: rv.rows.length }) }}</span>
          </header>
          <template v-if="!isRecordFolded(nodeKey(node), rv.recordIdx)">
          <dl class="mal__rmeta">
            <div class="mal__rmpair">
              <dt>{{ t('metric') }}</dt>
              <dd><code>{{ metricLabel(rv.rec) }}</code></dd>
            </div>
            <div v-if="rv.rec.rule.filter" class="mal__rmpair">
              <dt>{{ t('filter') }}</dt>
              <dd><code><template
                v-for="(seg, i) in highlightSegments(rv.rec.rule.filter, selectedFragment)"
                :key="i"
              ><mark
                v-if="seg.highlight"
                class="mal__hl"
              >{{ seg.text }}</mark><template v-else>{{ seg.text }}</template></template></code></dd>
            </div>
            <div v-if="rv.rec.rule.exp" class="mal__rmpair">
              <dt>{{ t('exp') }}</dt>
              <dd><code><template
                v-for="(seg, i) in highlightSegments(rv.rec.rule.exp, selectedFragment)"
                :key="i"
              ><mark
                v-if="seg.highlight"
                class="mal__hl"
              >{{ seg.text }}</mark><template v-else>{{ seg.text }}</template></template></code></dd>
            </div>
            <div v-if="rv.rec.rule.expSuffix" class="mal__rmpair">
              <dt>{{ t('suffix') }}</dt>
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
            <template v-for="(row, idx) in rv.displayRows" :key="`${rv.recordIdx}-${idx}`">
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
                  <span :class="{ 'mal__warn': isDrop(row) }">{{ row.outputGroup ? row.outputGroup.count : outCountStr(row) }}</span>
                  <span
                    v-if="!row.sample.continueOn"
                    class="mal__stopflag"
                    :title="t('chain stopped here')"
                  >{{ t('stopped') }}</span>
                </div>
              </div>
              <div class="mal__rail">
                <div class="mal__railline" :class="{ 'mal__railline--last': idx === rv.displayRows.length - 1 }"></div>
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
                <template v-if="row.outputGroup">
                  <!-- A run of ≥2 output entities for one metric. The
                       meter header (metric / function / timeBucket) is
                       shared; the collapsible block summarises the N
                       entities and, on expand, diffs them field-by-field
                       — whichever entity field differs surfaces (not just
                       endpointName), each output keeping its own value. -->
                  <div class="mal__meter">
                    <div><span class="mal__mlbl">{{ t('metric') }}</span><span class="mal__mval">{{ row.outputGroup.metric }}</span></div>
                    <div><span class="mal__mlbl">{{ t('function') }}</span><span class="mal__mval">{{ row.outputGroup.valueType }}</span></div>
                    <div><span class="mal__mlbl">timeBucket</span><span class="mal__mval">{{ row.outputGroup.timeBucket }}</span></div>
                  </div>
                  <div class="mal__groups">
                    <div class="mal__group">
                      <button
                        type="button"
                        class="mal__grouphead"
                        :class="{ 'mal__grouphead--open': isGroupExpanded(row.outputGroup.key) }"
                        @click="toggleGroup(row.outputGroup.key)"
                      >
                        <span class="mal__groupcaret">{{ isGroupExpanded(row.outputGroup.key) ? '▾' : '▸' }}</span>
                        <code class="mal__groupname">{{ t('{n} outputs', { n: row.outputGroup.count }) }}</code>
                        <span class="mal__groupvals"><span class="mal__groupvalsk">{{ t('values') }}=</span>{{ outputSummaryValues(row.outputGroup) }}</span>
                      </button>

                      <div v-if="isGroupExpanded(row.outputGroup.key)" class="mal__groupbody">
                        <table class="mal__gtable">
                          <colgroup>
                            <col class="mal__gcollabels" />
                            <col class="mal__gcolval" />
                          </colgroup>
                          <thead>
                            <tr>
                              <th class="mal__gthlabels">
                                <span>{{ t('entity') }}</span>
                                <button
                                  type="button"
                                  class="mal__difftog"
                                  :class="{ 'mal__difftog--active': isDiffMode(row.outputGroup.key, row.outputGroup.count) }"
                                  :title="t('show only differing labels')"
                                  @click="toggleGroupDiff(row.outputGroup.key)"
                                >{{ t('diff') }}</button>
                              </th>
                              <th class="mal__rtval">{{ t('value') }}</th>
                            </tr>
                          </thead>
                          <tbody>
                            <template v-if="isDiffMode(row.outputGroup.key, row.outputGroup.count)">
                              <tr class="mal__diffcommonrow">
                                <td colspan="2">
                                  <div class="mal__diffcommonhd">{{ t('common ({n})', { n: row.outputGroup.common.length }) }}</div>
                                  <div class="mal__diffcommons">
                                    <span v-if="row.outputGroup.common.length === 0" class="mal__dim">—</span>
                                    <span v-for="c in row.outputGroup.common" :key="c.k" class="mal__diffcommon">{{ c.k }}={{ c.v }}</span>
                                  </div>
                                </td>
                              </tr>
                              <tr v-for="(dr, j) in row.outputGroup.diffRows" :key="j">
                                <td class="mal__rtlabels">
                                  <span v-if="dr.diffs.length === 0" class="mal__dim">—</span>
                                  <span v-for="d in dr.diffs" :key="d.k" class="mal__diffcell"><span class="mal__diffk">{{ d.k }}</span>=<span v-if="d.absent" class="mal__dim">∅</span><span v-else class="mal__diffv">{{ d.v }}</span></span>
                                </td>
                                <td class="mal__rtval" :title="dr.valueRaw">{{ dr.value }}</td>
                              </tr>
                            </template>
                            <template v-else>
                              <tr v-for="(o, j) in row.outputGroup.rows" :key="j">
                                <td class="mal__rtlabels">
                                  <span v-if="o.fields.length === 0" class="mal__dim">—</span>
                                  <div v-for="f in o.fields" :key="f.k" class="mal__rtlabel">{{ f.k }}={{ f.v }}</div>
                                </td>
                                <td class="mal__rtval" :title="o.valueRaw">{{ o.value }}</td>
                              </tr>
                            </template>
                            <tr v-if="row.outputGroup.count > row.outputGroup.rows.length">
                              <td colspan="2" class="mal__rtmore">
                                {{ t('+ {n} more rows', { n: row.outputGroup.count - row.outputGroup.rows.length }) }}
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </template>
                <template v-else-if="row.output">
                  <!-- Single output payload renders verbatim — every field
                       present on the wire shows up; nothing is
                       inferred from upstream stages. The materialised
                       `value` is optional on the wire (only newer OAP
                       builds serialise it) and renders only when the
                       recorder included it. -->
                  <div class="mal__meter">
                    <div><span class="mal__mlbl">{{ t('metric') }}</span><span class="mal__mval">{{ row.output.metric }}</span></div>
                    <div><span class="mal__mlbl">{{ t('function') }}</span><span class="mal__mval">{{ row.output.valueType }}</span></div>
                    <div v-if="row.output.value !== undefined">
                      <span class="mal__mlbl">{{ t('value') }}</span>
                      <span
                        class="mal__mval mal__mvalnum"
                        :title="outputValueRaw(row.output.value)"
                      >{{ formatOutputValue(row.output.value) }}</span>
                    </div>
                    <div><span class="mal__mlbl">timeBucket</span><span class="mal__mval">{{ row.output.timeBucket }}</span></div>
                  </div>
                  <div class="mal__entity">
                    <header class="mal__entityh">
                      <span class="mal__mlbl">{{ t('entity') }}</span>
                      <button
                        type="button"
                        class="mal__entitytog"
                        @click="toggleEntity(row)"
                      >
                        {{ isEntityExpanded(row) ? t('compact') : t('show all') }}
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
                        {{ t('+ {n} null fields hidden', { n: entityFields(row.output.entity, true).length - entityFields(row.output.entity, false).length }) }}
                      </div>
                    </div>
                  </div>
                </template>
                <template v-else-if="row.samples?.empty === true">
                  <div class="mal__rtempty">{{ t('empty family · 0 rows') }}</div>
                </template>
                <template v-else>
                  <div v-if="countRows(row.samples) === 0" class="mal__rtempty">{{ t('no rows in payload') }}</div>
                  <div v-else class="mal__groups">
                    <!-- One collapsible block per metric name. Collapsed
                         (default) is a one-line summary so a stage that
                         fans out to hundreds of samples doesn't dump its
                         full label set on screen. Expand reveals the
                         per-sample labels; for multi-sample groups the
                         `diff` toggle (beside the LABELS header) hides the
                         shared labels and highlights only what differs. -->
                    <div v-for="g in stageGroups(row, idx)" :key="g.name" class="mal__group">
                      <button
                        type="button"
                        class="mal__grouphead"
                        :class="{ 'mal__grouphead--open': isGroupExpanded(g.key) }"
                        @click="toggleGroup(g.key)"
                      >
                        <span class="mal__groupcaret">{{ isGroupExpanded(g.key) ? '▾' : '▸' }}</span>
                        <code class="mal__groupname">{{ g.name }}</code>
                        <span class="mal__groupct">{{ t('{n} samples', { n: g.count }) }}</span>
                        <span class="mal__groupvals"><span class="mal__groupvalsk">{{ t('values') }}=</span>{{ summaryValues(g) }}</span>
                      </button>

                      <div v-if="isGroupExpanded(g.key)" class="mal__groupbody">
                        <table class="mal__gtable">
                          <colgroup>
                            <col class="mal__gcollabels" />
                            <col class="mal__gcolval" />
                          </colgroup>
                          <thead>
                            <tr>
                              <th class="mal__gthlabels">
                                <span>{{ t('labels') }}</span>
                                <button
                                  v-if="g.count > 1"
                                  type="button"
                                  class="mal__difftog"
                                  :class="{ 'mal__difftog--active': isDiffMode(g.key, g.count) }"
                                  :title="t('show only differing labels')"
                                  @click="toggleGroupDiff(g.key)"
                                >{{ t('diff') }}</button>
                              </th>
                              <th class="mal__rtval">{{ t('value') }}</th>
                            </tr>
                          </thead>
                          <tbody>
                            <template v-if="g.diff && isDiffMode(g.key, g.count)">
                              <tr class="mal__diffcommonrow">
                                <td colspan="2">
                                  <div class="mal__diffcommonhd">{{ t('common ({n})', { n: g.diff.common.length }) }}</div>
                                  <div class="mal__diffcommons">
                                    <span v-if="g.diff.common.length === 0" class="mal__dim">—</span>
                                    <span v-for="c in g.diff.common" :key="c.k" class="mal__diffcommon">{{ c.k }}={{ c.v }}</span>
                                  </div>
                                </td>
                              </tr>
                              <tr v-for="(dr, j) in g.diff.rows" :key="j">
                                <td class="mal__rtlabels">
                                  <span v-if="dr.diffs.length === 0" class="mal__dim">—</span>
                                  <span v-for="d in dr.diffs" :key="d.k" class="mal__diffcell"><span class="mal__diffk">{{ d.k }}</span>=<span v-if="d.absent" class="mal__dim">∅</span><span v-else class="mal__diffv">{{ d.v }}</span></span>
                                </td>
                                <td class="mal__rtval" :title="String(dr.value)">{{ formatSampleValue(dr.value) }}</td>
                              </tr>
                            </template>
                            <template v-else>
                              <tr v-for="(it, j) in g.rows" :key="j">
                                <td class="mal__rtlabels">
                                  <span v-if="labelLines(it.labels).length === 0" class="mal__dim">—</span>
                                  <div v-for="line in labelLines(it.labels)" :key="line" class="mal__rtlabel">{{ line }}</div>
                                </td>
                                <td class="mal__rtval" :title="String(it.value)">{{ formatSampleValue(it.value) }}</td>
                              </tr>
                            </template>
                            <tr v-if="g.count > g.rows.length">
                              <td colspan="2" class="mal__rtmore">
                                {{ t('+ {n} more rows', { n: g.count - g.rows.length }) }}
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
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
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
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
  font-size: var(--sw-fs-base);
}

.ctl__input {
  width: 90px;
}

.ctl__editlink {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
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
  font-size: var(--sw-fs-sm);
  color: var(--rr-ink2);
}

.mal__histbicon {
  color: var(--rr-warn, #d6a96d);
  font-size: var(--sw-fs-md);
}

.mal__histback {
  margin-left: auto;
  background: transparent;
  border: 1px solid var(--rr-border);
  color: var(--rr-ink2);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  padding: 3px 10px;
  cursor: pointer;
}

.mal__histback:hover {
  color: var(--rr-heading);
  border-color: var(--rr-ink2);
}

.mal__empty {
  padding: 14px;
  font-size: var(--sw-fs-base);
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
  font-size: var(--sw-fs-sm);
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
  font-size: var(--sw-fs-base);
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
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
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
  font-size: var(--sw-fs-sm);
  font-weight: var(--sw-fw-semibold);
}

.mal__rectime {
  font-family: var(--rr-font-mono);
  color: var(--rr-ink2);
  font-size: var(--sw-fs-sm);
}

.mal__recmeta {
  margin-left: auto;
  font-family: var(--rr-font-mono);
  color: var(--rr-dim);
  font-size: var(--sw-fs-sm);
}

.mal__rmeta {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 4px 12px;
  margin: 0;
  padding: 8px 12px;
  border-bottom: 1px solid var(--rr-border);
  font-size: var(--sw-fs-sm);
}

.mal__rmpair {
  display: contents;
}

.mal__rmpair dt {
  color: var(--sw-fg-3);
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
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
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
}

.mal__stagelbl--selected .mal__stagekind {
  color: var(--rr-accent, var(--rr-active));
}

.mal__stagelabel {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
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
  font-size: var(--sw-fs-sm);
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
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
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

/* ── Per-metric sample groups (right pane) ──────────────────────── */

.mal__groups {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mal__group {
  border: 1px solid var(--rr-border);
  background: var(--rr-bg);
}

.mal__grouphead {
  display: flex;
  align-items: baseline;
  gap: 10px;
  width: 100%;
  padding: 6px 8px;
  background: transparent;
  border: none;
  border-left: 2px solid transparent;
  color: var(--rr-ink);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-base);
  text-align: left;
  cursor: pointer;
}

.mal__grouphead:hover {
  background: var(--rr-bg2);
}

.mal__grouphead--open {
  background: var(--rr-bg2);
  border-left-color: var(--rr-accent, var(--rr-active));
}

.mal__groupcaret {
  flex: none;
  width: 12px;
  color: var(--rr-dim);
  font-size: var(--sw-fs-sm);
}

.mal__groupname {
  flex: none;
  color: var(--rr-heading);
  font-family: var(--rr-font-mono);
  background: transparent;
  padding: 0;
  word-break: break-all;
}

.mal__groupct {
  flex: none;
  color: var(--rr-dim);
  font-size: var(--sw-fs-sm);
  white-space: nowrap;
}

/* Values preview takes the remaining width and ellipsises — the summary
   line never wraps or pushes the card wider. */
.mal__groupvals {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--rr-accent, var(--rr-active));
  font-size: var(--sw-fs-sm);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mal__groupvalsk {
  color: var(--sw-fg-3);
}

.mal__groupbody {
  border-top: 1px solid var(--rr-border);
}

.mal__gtable {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-base);
  background: var(--rr-bg);
  /* Fixed layout binds the colgroup widths; the value column is sized
     and wraps so a long float can never push the table past the pane. */
  table-layout: fixed;
}

.mal__gcollabels {
  width: auto;
}

.mal__gcolval {
  width: 96px;
}

.mal__gtable thead tr {
  background: var(--rr-bg2);
}

.mal__gtable th {
  text-align: left;
  padding: 4px 8px;
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
  border-bottom: 1px solid var(--rr-border);
}

.mal__gthlabels {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Out-specify `.mal__gtable th { text-align: left }` so the value
   header lines up over its right-aligned numeric column. */
.mal__gtable th.mal__rtval {
  text-align: right;
}

.mal__gtable td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--rr-border);
  vertical-align: top;
}

.mal__gtable tbody tr:last-child td {
  border-bottom: none;
}

.mal__difftog {
  background: transparent;
  border: 1px solid var(--rr-border);
  color: var(--rr-ink2);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  padding: 1px 7px;
  cursor: pointer;
}

.mal__difftog:hover {
  color: var(--rr-heading);
  border-color: var(--rr-ink2);
}

.mal__difftog--active {
  background: var(--rr-accent, var(--rr-active));
  border-color: var(--rr-accent, var(--rr-active));
  color: var(--rr-bg);
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
  text-align: right;
  color: var(--rr-accent, var(--rr-active));
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

/* ── Diff mode (differing labels only) ──────────────────────────── */

.mal__diffcommonrow td {
  background: var(--rr-bg2);
}

.mal__diffcommonhd {
  color: var(--sw-fg-3);
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  margin-bottom: 4px;
}

.mal__diffcommons {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
}

.mal__diffcommon {
  color: var(--rr-dim);
  word-break: break-all;
}

.mal__diffcell {
  margin-right: 10px;
  color: var(--rr-ink2);
  white-space: nowrap;
}

.mal__diffk {
  color: var(--sw-fg-3);
}

.mal__diffv {
  color: var(--rr-heading);
  background: color-mix(in oklab, var(--rr-accent, var(--rr-active)) 20%, transparent);
  padding: 0 3px;
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
  font-size: var(--sw-fs-sm);
}

.mal__meter > div {
  display: contents;
}

.mal__mlbl {
  color: var(--sw-fg-3);
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
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
  font-weight: var(--sw-fw-semibold);
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
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
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
  font-size: var(--sw-fs-base);
}

.mal__entitykv {
  display: contents;
}

.mal__entityk {
  color: var(--sw-fg-3);
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
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
  font-size: var(--sw-fs-xs);
  font-style: italic;
}
</style>
