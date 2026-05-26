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
 * OAL live-debugger view. Hosted in `<DebugView>`.
 *
 * Picker is fed by `/runtime/oal/rules` (per-dispatcher); session
 * targets `(oal, source, source)` per the upstream
 * RuntimeOalRestHandler.
 *
 * Each captured execution lands as one `SessionRecord` whose
 * `samples[]` walks `input → filter → function → aggregation →
 * output`. The first two samples carry the source object's columns
 * (`type` + `fields.scope`, `entityId`, …); the trailing samples
 * carry the materialised metric (`type` + `timeBucket`, `total`,
 * `value`, …).
 */
import { computed, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import type {
  NodeSlice,
  OalMetricsPayload,
  OalRulesResponse,
  OalSourcePayload,
  SessionRecord,
  SessionResponse,
  SessionSample,
} from '@skywalking-horizon-ui/api-client';
import { bff } from '@/api/client';
import { useDebugSession } from '@/features/operate/live-debug/useDebugSession';
import { useDebugHistory, type HistoryEntry } from '@/features/operate/live-debug/useDebugHistory';
import Btn from '@/components/primitives/Btn.vue';
import Pill from '@/components/primitives/Pill.vue';
import DebugView from './DebugView.vue';
import { isOalMetricsPayload, isOalSourcePayload, sampleTone } from './payload.js';
import {
  decodeEntityId,
  decodeMetricEntityId,
  decodeMetricId,
} from './oalEntityId.js';
import {
  DEFAULT_RETENTION_MINUTES,
  MS_PER_MINUTE,
  RECORD_CAP_MAX,
} from './constants.js';

const { t } = useI18n({ useScope: 'global' });
const route = useRoute();
const dbg = useDebugSession('oal');
const history = useDebugHistory('oal');
/** OAL session install keys: `(catalog=oal, name=<file>, ruleName=<metric>)`.
 *  The picker's two refs map directly to that wire shape. The
 *  source-listing fetched from `/runtime/oal/rules` is shown
 *  read-only as a discovery aid (which sources have live holders)
 *  but the install itself is keyed on file + metric. */
const selectedFile = ref<string>('');
const selectedMetric = ref<string>('');
// SessionLimits.MAX_RECORD_CAP on the OAP side is 100 (and so is the
// default). The input is bounded the same way; lower if a single
// execution is enough or you want the captured page tighter.
const recordCap = ref<number>(RECORD_CAP_MAX);
const retentionMinutes = ref<number>(DEFAULT_RETENTION_MINUTES);

/** Deep-link from the OAL file viewer: `?file=<f>&ruleName=<metric>`
 *  pre-fills the picker so a one-click jump from a rule line lands
 *  on the right session target. */
watch(
  () => [route.query.file, route.query.ruleName] as const,
  ([f, m]) => {
    if (typeof f === 'string' && f.length > 0) selectedFile.value = f;
    if (typeof m === 'string' && m.length > 0) selectedMetric.value = m;
  },
  { immediate: true },
);

const filesQuery = useQuery({
  queryKey: ['debug-oal/files'],
  queryFn: async () => bff.dsl.oalFiles(),
});
const files = computed<string[]>(() => filesQuery.data.value?.files ?? []);

const sourcesQuery = useQuery({
  queryKey: ['debug-oal/rules'],
  queryFn: async (): Promise<OalRulesResponse> => bff.dsl.oalSources(),
});
const sources = computed(() => sourcesQuery.data.value?.sources ?? []);

const startEnabled = computed(() => {
  const s = dbg.state.value;
  return (
    selectedFile.value !== '' &&
    selectedMetric.value !== '' &&
    (s === 'idle' || s === 'captured' || s === 'stopped' || s === 'error')
  );
});

const stopEnabled = computed(
  () => dbg.state.value === 'capturing' || dbg.state.value === 'starting',
);

async function startSampling(): Promise<void> {
  if (!selectedFile.value || !selectedMetric.value) return;
  await dbg.start({
    catalog: 'oal',
    name: selectedFile.value,
    ruleName: selectedMetric.value,
    recordCap: recordCap.value,
    retentionMillis: retentionMinutes.value * MS_PER_MINUTE,
  });
}

interface OalSampleRow {
  sample: SessionSample;
  source: OalSourcePayload | null;
  metrics: OalMetricsPayload | null;
}

interface OalRecordGroup {
  index: number;
  rec: SessionRecord;
  rows: OalSampleRow[];
}

interface OalNodeView extends NodeSlice {
  groups: OalRecordGroup[];
}

// ── Historical replay ──────────────────────────────────────────────

const historicalEntry = shallowRef<HistoryEntry | null>(null);

const displaySession = computed<SessionResponse | null>(
  () => historicalEntry.value?.session ?? dbg.session.value,
);

function loadHistorical(entry: HistoryEntry): void {
  historicalEntry.value = entry;
  selectedFile.value = entry.name;
  selectedMetric.value = entry.ruleName;
  if (entry.recordCap !== undefined) recordCap.value = entry.recordCap;
  if (entry.retentionMillis !== undefined) {
    retentionMinutes.value = Math.max(1, Math.round(entry.retentionMillis / MS_PER_MINUTE));
  }
}

function clearHistorical(): void {
  historicalEntry.value = null;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function persistCapture(): void {
  if (historicalEntry.value !== null) return;
  const id = dbg.sessionId.value;
  if (!id || !selectedFile.value || !selectedMetric.value) return;
  const sess: SessionResponse = dbg.session.value ?? {
    sessionId: id,
    capturedAt: Date.now(),
    nodes: [],
  };
  history.save({
    widget: 'oal',
    catalog: 'oal',
    name: selectedFile.value,
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
    selectedMetric.value = entry.ruleName;
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

const nodeViews = computed<OalNodeView[]>(() => {
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
    const groups: OalRecordGroup[] = [];
    let idx = 0;
    for (const rec of n.records ?? []) {
      idx += 1;
      const rows: OalSampleRow[] = [];
      for (const sample of rec.samples ?? []) {
        rows.push({
          sample,
          source: isOalSourcePayload(sample.payload) ? sample.payload : null,
          metrics: isOalMetricsPayload(sample.payload) ? sample.payload : null,
        });
      }
      groups.push({ index: idx, rec, rows });
    }
    return { ...n, groups };
  });
});

function nodeKey(n: NodeSlice): string {
  return n.nodeId ?? n.peer ?? '?';
}

interface OalKv {
  k: string;
  v: string;
}

/** Walk the open `fields` bag and surface every primitive value as a
 *  separate `key=value` line so the operator sees the full identity
 *  of the captured source row — not just a curated subset. Strings
 *  stay verbatim (entityId is base64); booleans / numbers stringify;
 *  nulls and nested objects are skipped to avoid noise. */
function sourceFields(p: OalSourcePayload): OalKv[] {
  const out: OalKv[] = [];
  for (const [k, v] of Object.entries(p.fields ?? {})) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') continue;
    out.push({ k, v: String(v) });
  }
  return out;
}

/** True when the field name carries an IDManager-encoded entity id.
 *  Sources override `toJson()` by hand and emit camelCase
 *  (`entityId`); generated OAL Metrics classes use the storage
 *  column name (`entity_id`) via the codegen's `appendDebugFields`
 *  template — both spellings appear on the wire. */
function isEntityIdKey(k: string): boolean {
  return k === 'entityId' || k === 'entity_id';
}

/** Decoded annotation for a source field — only `entityId` /
 *  `entity_id` carries the composite IDManager shape; everything
 *  else returns null and the template skips the parenthetical. The
 *  OAL source class (`OalSourcePayload.type`, e.g. `Service`,
 *  `Endpoint`, `ServiceRelation`) selects the right per-scope
 *  decoder. */
function decodeAnnotation(type: string, k: string, v: string): string | null {
  if (!isEntityIdKey(k)) return null;
  return decodeEntityId(type, v);
}

/** Same idea for metric rows. Two field shapes carry IDManager-
 *  encoded values:
 *  - `id` — storage row id (`<timeBucket>_<entityId>`); we surface
 *    the time bucket plus the inferred entity.
 *  - `entityId` / `entity_id` — the standalone composite the metric
 *    joins on; the metric class name (e.g. `ServiceCpmMetrics`,
 *    `ServiceRelationServerCpmMetrics`) selects the scope so we can
 *    decode this exactly like the source-side `entityId`.
 *  Anything else returns null and renders without an annotation. */
function decodeMetricAnnotation(type: string, k: string, v: string): string | null {
  if (k === 'id') return decodeMetricId(type, v);
  if (isEntityIdKey(k)) return decodeMetricEntityId(type, v);
  return null;
}

/** Same idea for the metrics payload — `type` is rendered out of band
 *  in the row header, but every other primitive top-level field
 *  (timeBucket, total, value, plus per-metric extras like count,
 *  summation, percentiles) becomes its own labelled line. */
function metricFields(p: OalMetricsPayload): OalKv[] {
  const out: OalKv[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (k === 'type') continue;
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') continue;
    out.push({ k, v: String(v) });
  }
  return out;
}

// ── Click-to-select + collaborative highlight (mirrors MAL) ────────

const selectedRow = ref<OalSampleRow | null>(null);

function selectRow(row: OalSampleRow): void {
  selectedRow.value = selectedRow.value === row ? null : row;
}

interface Segment {
  text: string;
  highlight: boolean;
}

const selectedFragment = computed<string>(
  () => selectedRow.value?.sample.sourceText.trim() ?? '',
);

/** Split a rule field into highlight / plain segments around every
 *  exact occurrence of the selected step's `sourceText`. Drives the
 *  inline `<mark>` collaborative highlight inside the captured DSL —
 *  clicking a step lights up the matching expression in the OAL
 *  statement above the chain. */
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

// ── Per-record fold state + fold/expand all (mirrors MAL) ──────────

const foldedRecords = ref<Set<string>>(new Set());

function recordFoldKey(nKey: string, idx: number): string {
  return `${nKey}#${idx}`;
}

function isRecordFolded(nKey: string, idx: number): boolean {
  return foldedRecords.value.has(recordFoldKey(nKey, idx));
}

function toggleRecord(nKey: string, idx: number): void {
  const k = recordFoldKey(nKey, idx);
  const next = new Set(foldedRecords.value);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  foldedRecords.value = next;
}

function foldAllRecords(): void {
  const next = new Set<string>();
  for (const v of nodeViews.value) {
    const nKey = v.nodeId ?? v.peer ?? '?';
    for (const g of v.groups) next.add(recordFoldKey(nKey, g.index));
  }
  foldedRecords.value = next;
}

function expandAllRecords(): void {
  foldedRecords.value = new Set();
}

const totalRecordCount = computed<number>(() => {
  let n = 0;
  for (const v of nodeViews.value) n += v.groups.length;
  return n;
});

const allFolded = computed<boolean>(
  () => totalRecordCount.value > 0 && foldedRecords.value.size === totalRecordCount.value,
);
</script>

<template>
  <DebugView
    :dbg="dbg"
    :node-views="nodeViews"
    :view-session="historicalEntry?.session ?? null"
  >
    <template #controls>
      <div class="ctl">
        <label class="ctl__lbl">{{ t('file') }}</label>
        <select v-model="selectedFile" class="ctl__select" :disabled="filesQuery.isPending.value">
          <option value="" disabled>
            {{ filesQuery.isPending.value ? t('loading…') : t('select an .oal file…') }}
          </option>
          <option v-for="f in files" :key="f" :value="f">{{ f }}</option>
        </select>
      </div>
      <div class="ctl ctl--grow">
        <label class="ctl__lbl">{{ t('metric') }}</label>
        <input
          v-model="selectedMetric"
          type="text"
          class="ctl__input ctl__input--flex"
          :placeholder="t('e.g. service_relation_server_cpm')"
        />
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
        :to="{ path: '/operate/oal' }"
        :title="t('browse the OAL files (read-only)')"
      >{{ t('open in OAL catalog →') }}</router-link>
    </template>

    <template #banner>
      <div v-if="historicalEntry" class="oal__histbanner">
        <span class="oal__histbicon">⟲</span>
        <span>
          {{ t('viewing saved capture from') }} <strong>{{ formatTime(historicalEntry.savedAt) }}</strong>
          · {{ historicalEntry.catalog }} · {{ historicalEntry.name }} · {{ historicalEntry.ruleName }}
        </span>
        <button type="button" class="oal__histback" @click="clearHistorical">{{ t('back to live') }}</button>
      </div>
    </template>

    <template #subhead>
      <p v-if="sourcesQuery.isError.value" class="oal__error">
        {{ t('Could not load OAL sources reference list.') }}
        <button type="button" @click="sourcesQuery.refetch()">{{ t('retry') }}</button>
      </p>
      <p v-if="sources.length > 0" class="oal__hint">
        {{ t('OAP has') }}
        <strong>{{ sources.length }}</strong>
        {{ t('OAL source classes registered across {n} .oal files.', { n: files.length }) }}
        {{ t('Browse them in') }}
        <router-link to="/operate/oal" class="oal__link">{{ t('OAL catalog') }}</router-link>
        — {{ t('every') }} <code>metric = from(Source…)</code> {{ t('line has a green ▶ that deep-links here with the picker pre-filled.') }}
      </p>
      <div v-if="totalRecordCount > 0" class="oal__subhead">
        <span class="oal__subheadct">{{ t('{n} records · {folded} folded', { n: totalRecordCount, folded: foldedRecords.size }) }}</span>
        <div class="oal__subheadbtns">
          <button
            type="button"
            class="oal__subheadbtn"
            :disabled="allFolded"
            @click="foldAllRecords"
          >{{ t('fold all') }}</button>
          <button
            type="button"
            class="oal__subheadbtn"
            :disabled="foldedRecords.size === 0"
            @click="expandAllRecords"
          >{{ t('expand all') }}</button>
        </div>
      </div>
    </template>

    <template #idle-hint>
      {{ t('pick the .oal file and the metric name (the LHS of = in the rule statement) and hit start. one captured execution = one source row entering the pipeline; samples walk input → filter → function → aggregation → output.') }}
    </template>

    <template #node-body="{ node }">
      <div v-if="node.groups.length === 0" class="oal__empty">
        {{ t('no source rows captured on this node') }}
      </div>
      <div v-else class="oal__groups">
        <article
          v-for="g in node.groups"
          :key="g.index"
          class="oal__group"
          :class="{ 'oal__group--folded': isRecordFolded(nodeKey(node), g.index) }"
        >
          <header
            class="oal__grouph"
            @click="toggleRecord(nodeKey(node), g.index)"
          >
            <span class="oal__groupcaret">{{
              isRecordFolded(nodeKey(node), g.index) ? '▸' : '▾'
            }}</span>
            <span class="oal__groupid">{{ t('source row #{n}', { n: g.index }) }}</span>
            <span class="oal__groupline">{{ t('line {n}', { n: g.rec.rule.sourceLine ?? '—' }) }}</span>
            <code class="oal__rulename">{{ g.rec.rule.ruleName }}</code>
          </header>
          <template v-if="!isRecordFolded(nodeKey(node), g.index)">
            <pre v-if="g.rec.dsl" class="oal__dsl"><code><template
              v-for="(seg, si) in highlightSegments(g.rec.dsl, selectedFragment)"
              :key="si"
            ><mark
              v-if="seg.highlight"
              class="oal__hl"
            >{{ seg.text }}</mark><template v-else>{{ seg.text }}</template></template></code></pre>
            <table class="oal__waterfall">
            <thead>
              <tr>
                <th class="oal__kind">{{ t('step') }}</th>
                <th class="oal__source">{{ t('fragment') }}</th>
                <th class="oal__result">{{ t('payload') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(row, idx) in g.rows"
                :key="`${nodeKey(node)}-${g.index}-${idx}`"
                class="oal__row"
                :class="{
                  'oal__row--selected': selectedRow === row,
                  'oal__row--stopped': !row.sample.continueOn,
                }"
                @click="selectRow(row)"
              >
                <td class="oal__kind">
                  <span
                    class="oal__flow"
                    :class="{ 'oal__flow--stopped': !row.sample.continueOn }"
                    :title="row.sample.continueOn ? t('chain continues to next step') : t('chain stopped here')"
                  >{{ row.sample.continueOn ? '↓' : '⊘' }}</span>
                  <Pill :tone="sampleTone(row.sample.type)">{{ row.sample.type }}</Pill>
                </td>
                <td class="oal__source"><code>{{ row.sample.sourceText || '—' }}</code></td>
                <td class="oal__result">
                  <template v-if="row.source">
                    <div class="oal__kvline">
                      <span class="oal__lbl">{{ t('type') }}</span>
                      <span class="oal__kvval">{{ row.source.type }}</span>
                    </div>
                    <div
                      v-for="kv in sourceFields(row.source)"
                      :key="kv.k"
                      class="oal__kvline"
                    >
                      <span class="oal__lbl">{{ kv.k }}</span>
                      <span class="oal__kvval">
                        {{ kv.v }}
                        <span
                          v-if="decodeAnnotation(row.source.type, kv.k, kv.v)"
                          class="oal__decoded"
                        >({{ decodeAnnotation(row.source.type, kv.k, kv.v) }})</span>
                      </span>
                    </div>
                  </template>
                  <template v-else-if="row.metrics">
                    <div class="oal__kvline">
                      <span class="oal__lbl">{{ t('type') }}</span>
                      <span class="oal__kvval">{{ row.metrics.type }}</span>
                    </div>
                    <div
                      v-for="kv in metricFields(row.metrics)"
                      :key="kv.k"
                      class="oal__kvline"
                    >
                      <span class="oal__lbl">{{ kv.k }}</span>
                      <span class="oal__kvval">
                        {{ kv.v }}
                        <span
                          v-if="decodeMetricAnnotation(row.metrics.type, kv.k, kv.v)"
                          class="oal__decoded"
                        >({{ decodeMetricAnnotation(row.metrics.type, kv.k, kv.v) }})</span>
                      </span>
                    </div>
                  </template>
                </td>
              </tr>
            </tbody>
          </table>
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
  min-width: 280px;
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

/* OAL metric names get long (`service_instance_response_time_percentile`,
 * `endpoint_relation_resp_time_per_min` …) — let the cell grow. */
.ctl--grow {
  flex: 1 1 280px;
  min-width: 280px;
}
.ctl__input--flex {
  width: 100%;
  min-width: 280px;
}

.oal__error {
  padding: 8px 12px;
  background: var(--rr-bg2);
  border: 1px solid var(--rr-err, #f44);
  color: var(--rr-err, #f44);
  font-size: 12px;
  margin: 0;
}
.oal__hint {
  font-size: 12px;
  line-height: 1.55;
  color: var(--rr-ink2);
  margin: 0;
}
.oal__hint code {
  font-family: var(--rr-font-mono);
  color: var(--rr-ink);
}
/* Inline accent link — was unstyled and fell back to the browser default
 * link color, which clashes with the dark theme. */
.oal__link {
  color: var(--rr-accent, var(--sw-accent, #38bdf8));
  text-decoration: none;
  font-weight: 600;
}
.oal__link:hover {
  text-decoration: underline;
}

.oal__empty {
  padding: 14px;
  font-size: 12.5px;
  color: var(--rr-dim);
  font-style: italic;
}

.oal__groups {
  display: flex;
  flex-direction: column;
}

.oal__group {
  border-bottom: 1px solid var(--rr-border);
}

.oal__group:last-child {
  border-bottom: 0;
}

.oal__grouph {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  background: var(--rr-bg);
  cursor: pointer;
  user-select: none;
}

.oal__grouph:hover {
  background: var(--rr-bg2);
}

.oal__groupcaret {
  display: inline-block;
  width: 12px;
  text-align: center;
  color: var(--rr-dim);
  font-size: 11px;
}

.oal__group--folded .oal__grouph {
  border-bottom: none;
}

.oal__subhead {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 0;
}

.oal__subheadct {
  font-family: var(--rr-font-mono);
  font-size: 12px;
  color: var(--rr-dim);
  letter-spacing: 0.4px;
}

.oal__subheadbtns {
  display: flex;
  gap: 6px;
  margin-left: auto;
}

.oal__subheadbtn {
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

.oal__subheadbtn:hover:not(:disabled) {
  color: var(--rr-heading);
  border-color: var(--rr-ink2);
}

.oal__subheadbtn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.oal__groupid {
  font-family: var(--rr-font-mono);
  font-size: 11.5px;
  color: var(--rr-heading);
}

.oal__groupline {
  font-family: var(--rr-font-mono);
  font-size: 11.5px;
  color: var(--rr-dim);
}

.oal__rulename {
  margin-left: auto;
  font-family: var(--rr-font-mono);
  font-size: 11.5px;
  color: var(--rr-ink2);
}

.oal__waterfall {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.oal__waterfall th,
.oal__waterfall td {
  padding: 6px 8px;
  text-align: left;
  border-bottom: 1px solid var(--rr-border);
  vertical-align: top;
}

.oal__waterfall th {
  font-family: var(--rr-font-mono);
  font-size: 11.5px;
  letter-spacing: 1.1px;
  text-transform: uppercase;
  color: var(--rr-dim);
}

.oal__source {
  font-family: var(--rr-font-mono);
  color: var(--rr-ink);
}

.oal__source code {
  font-family: var(--rr-font-mono);
  background: var(--rr-bg);
  padding: 1px 4px;
}

.oal__kind {
  width: 150px;
  white-space: nowrap;
}

.oal__flow {
  display: inline-block;
  width: 14px;
  text-align: center;
  margin-right: 6px;
  font-family: var(--rr-font-mono);
  color: var(--rr-dim);
  font-size: 11.5px;
  vertical-align: middle;
  cursor: help;
}

.oal__flow--stopped {
  color: var(--rr-warn, #d6a96d);
  font-weight: 600;
}

.oal__row {
  cursor: pointer;
  transition: background-color 80ms;
}

.oal__row:hover {
  background: var(--rr-bg2);
}

.oal__row--selected,
.oal__row--selected:hover {
  background: var(--rr-bg3);
  outline: 1px solid var(--rr-accent, var(--rr-active));
  outline-offset: -1px;
}

.oal__row--stopped td {
  border-left: 2px solid var(--rr-warn, #d6a96d);
}

.oal__dsl {
  margin: 0;
  padding: 8px 12px;
  background: var(--rr-bg2);
  border-bottom: 1px solid var(--rr-border);
  font-family: var(--rr-font-mono);
  font-size: 11.5px;
  color: var(--rr-ink);
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
  max-height: 120px;
}

.oal__dsl code {
  font-family: var(--rr-font-mono);
  background: transparent;
  padding: 0;
}

.oal__hl {
  background: var(--rr-accent, var(--rr-active));
  color: var(--rr-bg);
  padding: 1px 2px;
}

.oal__result {
  font-family: var(--rr-font-mono);
  font-size: 12.5px;
  color: var(--rr-ink2);
}

.oal__kvline {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 8px;
  align-items: baseline;
  font-family: var(--rr-font-mono);
  font-size: 11.5px;
  line-height: 1.5;
}

.oal__lbl {
  color: var(--rr-dim);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  white-space: nowrap;
}

.oal__kvval {
  color: var(--rr-ink);
  word-break: break-all;
}

.oal__decoded {
  color: var(--rr-dim);
  font-size: 12px;
  margin-left: 4px;
}

.oal__histbanner {
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

.oal__histbicon {
  color: var(--rr-warn, #d6a96d);
  font-size: 13px;
}

.oal__histback {
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

.oal__histback:hover {
  color: var(--rr-heading);
  border-color: var(--rr-ink2);
}
</style>
