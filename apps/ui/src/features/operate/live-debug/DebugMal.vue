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
  SessionResponse,
} from '@skywalking-horizon-ui/api-client';
import { bff } from '@/api/client';
import { useDebugSession } from '@/features/operate/live-debug/useDebugSession';
import { useDebugHistory, type HistoryEntry } from '@/features/operate/live-debug/useDebugHistory';
import Btn from '@/components/primitives/Btn.vue';
import DebugView from './DebugView.vue';
import { formatSampleValue, shortHash } from './payload.js';
import {
  DEFAULT_RETENTION_MINUTES,
  MS_PER_MINUTE,
  RECORD_CAP_MAX,
} from './constants.js';
import { useMalRecordViews } from './useMalRecordViews.js';
import {
  countRows,
  entityFields,
  formatOutputValue,
  formatTime,
  highlightSegments,
  inCountStr,
  isDrop,
  labelLines,
  metricLabel,
  nodeKey,
  outCountStr,
  outputSummaryValues,
  outputValueRaw,
  stageGroups as stageGroupsEngine,
  summaryValues,
  type MalSampleRow,
  type SampleGroup,
} from './malGroups.js';

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

const nodeViews = useMalRecordViews(displaySession);

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

/** Bind the reactive expand/diff toggles to the pure grouping engine —
 *  see `malGroups.stageGroups`. The wrapper closes over `groupKey` /
 *  `isGroupExpanded` / `isDiffMode` so the template stays a plain
 *  `stageGroups(row, idx)` call and the diff recomputes reactively when
 *  a toggle flips. */
function stageGroups(row: MalSampleRow, stageIdx: number): SampleGroup[] {
  return stageGroupsEngine(row, stageIdx, { groupKey, isGroupExpanded, isDiffMode });
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

/** The selected step's expression fragment — empty when nothing is
 *  selected, so meta-strip highlights collapse to no-ops. */
const selectedFragment = computed<string>(() =>
  selectedRow.value?.sample.sourceText.trim() ?? '',
);

// ── Entity expansion (output sample) ────────────────────────────────
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
