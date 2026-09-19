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
<!--
  The TraceQL tab, laid out and dressed as the native Traces tab: the
  conditions card beside the distribution, the list below, and one renderer
  whichever store answers.

  Two ways in, not three. A trace id is not a separate mode here because it is
  already a valid query in this language — Tempo's own editor takes a bare id
  in the same box — so typing one and pressing Run opens that trace.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { TraceListRow, TraceQLDatasource } from '@skywalking-horizon-ui/api-client';
import { useTimeRangeStore } from '@/controls/timeRange';
import TraceDistribution from '@/render/widgets/TraceDistribution.vue';
import TraceListPanel from '@/render/widgets/TraceListPanel.vue';
import TypeaheadSelect from '@/components/primitives/TypeaheadSelect.vue';
import ChipInput from '@/components/primitives/ChipInput.vue';
import { TIME_RANGE_PRESETS } from '@/layer/logs/useLogTimeRange';
import { MAX_RECORD_RANGE_DAYS, resolveRecordRange } from '@/utils/recordTimeRange';
import TraceQLTraceDetail from './TraceQLTraceDetail.vue';
import TraceQLEditor from './TraceQLEditor.vue';
import TraceQLSchemaPanel from './TraceQLSchemaPanel.vue';
import TraceQLWindowFields from './TraceQLWindowFields.vue';
import { buildTraceQL, lintTraceQL, serviceInExpression, type BuilderRows } from './traceqlLint';
import { TRACEQL_POPOUT_QUERY } from './traceqlDetailShared';
import { TRACEQL_STATUS_VALUES } from '@/monaco/traceql-grammar';
import {
  useTraceQLOptions,
  useTraceQLSearch,
  useTraceQLStatusResolver,
  useTraceQLSources,
  useTraceQLTraceIds,
  NO_TIME_RANGE,
  type TraceIdSubmission,
  TRACE_ID_LOOKUP_MAX,
  type TraceQLSubmission,
} from './useTraceQL';

const { t } = useI18n({ useScope: 'global' });
const route = useRoute();
const router = useRouter();
const time = useTimeRangeStore();

const layerKey = computed(() => String(route.params.layerKey ?? ''));
/** The row decides the store — each store has its own row. */
const ds = computed<TraceQLDatasource>(() =>
  /traceql-zipkin-trace/.test(route.path) ? 'zipkin' : 'native',
);

const { statusOf } = useTraceQLSources();
const status = computed(() => statusOf(ds.value));

type Mode = 'builder' | 'traceql' | 'traceId';
const mode = ref<Mode>('builder');
const limit = ref(30);
const rows = ref<BuilderRows>({ tags: [] });
const expression = ref('');

/** What Run was pressed with. Null until then: nothing queries on mount. */
const submitted = ref<TraceQLSubmission | null>(null);
let runs = 0;

const isTraceIdMode = computed(() => mode.value === 'traceId');
const generated = computed(() => buildTraceQL(rows.value));
const editorText = computed({
  get: () => (mode.value === 'traceql' ? expression.value : generated.value),
  set: (v: string) => {
    expression.value = v;
  },
});

/** A bare id, the way Tempo's own editor accepts one. */
const typedTraceId = computed(() => {
  const text = editorText.value.trim();
  return mode.value === 'traceql' && text && !text.startsWith('{') && !/\s/.test(text) ? text : null;
});
const issues = computed(() => (typedTraceId.value ? [] : lintTraceQL(editorText.value, ds.value)));


/**
 * This tab owns its time range, as the native Traces tab does.
 *
 * The topbar's range drives dashboards; a triage screen that followed it would
 * have an auto-refresh tick widen an operator's search mid-read. The topbar's
 * current window is only the STARTING value.
 */
const windowMinutes = ref<number>(
  TIME_RANGE_PRESETS.find((p) => p.minutes * 60_000 >= time.range.endMs - time.range.startMs)?.minutes ?? 30,
);
/** The picker's "Custom…" choice. -1 cannot collide with a preset's minutes. */
const CUSTOM_RANGE = -1;
const isCustomRange = computed(() => windowMinutes.value === CUSTOM_RANGE);
/** `datetime-local` reads "YYYY-MM-DDTHH:MM" in the browser's zone. Seeded
 *  with the last hour so switching to Custom shows a usable pair rather than
 *  two empty fields. */
function toLocalDtValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const customStart = ref(toLocalDtValue(Date.now() - 60 * 60_000));
const customEnd = ref(toLocalDtValue(Date.now()));
/** The window as the picker currently reads it. Anchored when it is USED —
 *  `Date.now()` is not reactive, so a computed would freeze at first read and
 *  hand every later Run the same stale window. A custom range is absolute, so
 *  it is the one window that does NOT move between runs. */
function currentWindow(): { startMs: number; endMs: number } | null {
  if (isCustomRange.value) {
    const r = resolveRecordRange(customStart.value, customEnd.value);
    // A half-filled or inverted pair resolves to NOTHING. Substituting another
    // window would answer a question the operator did not ask, and an absence
    // read off the wrong hour is worse than no answer at all.
    return typeof r === 'string' ? null : r;
  }
  const endMs = Date.now();
  return { startMs: endMs - windowMinutes.value * 60_000, endMs };
}
/** The complaint that stops a run, as an i18n key, or null when it resolves. */
const rangeError = computed<string | null>(() => {
  if (!isCustomRange.value) return null;
  const r = resolveRecordRange(customStart.value, customEnd.value);
  return typeof r === 'string' ? r : null;
});
/** For the option lookups, which follow the picker rather than a run. They fall
 *  back to the last hour while a custom range is half-typed: a picker that
 *  empties mid-edit is not an honest answer, it is a missing one. */
const window = computed(() => {
  void windowMinutes.value;
  const w = currentWindow();
  if (w) return w;
  const endMs = Date.now();
  return { startMs: endMs - 60 * 60_000, endMs };
});
const search = useTraceQLSearch({ ds, submitted });
const serviceModel = computed({
  get: () => rows.value.service ?? '',
  set: (v: string) => {
    rows.value.service = v;
    // A span name resolves against the service, so it cannot outlive it.
    rows.value.spanName = '';
  },
});
// Span names resolve against a SERVICE. In TraceQL mode that is whichever
// service the EXPRESSION names — the builder's picker is not what the operator
// is typing, and following it completes `name=` with another service's spans.
// A typed name SETTLES first: every keystroke of `agent::rating` is otherwise a
// real backend search for a service nobody has finished naming.
const optionsService = ref('');
let serviceSettleTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => (mode.value === 'traceql' ? (serviceInExpression(expression.value) ?? '') : serviceModel.value),
  (v, prev) => {
    if (serviceSettleTimer) clearTimeout(serviceSettleTimer);
    // A pick from the builder is a finished choice; only typing has to settle.
    if (prev === undefined || mode.value !== 'traceql') {
      optionsService.value = v;
      return;
    }
    serviceSettleTimer = setTimeout(() => { optionsService.value = v; }, 400);
  },
  { immediate: true },
);
onBeforeUnmount(() => { if (serviceSettleTimer) clearTimeout(serviceSettleTimer); });
const options = useTraceQLOptions(ds, layerKey, window, optionsService);
// The empty option is what CLEARS the condition: a typeahead only emits values
// it was given, so without it a picked service can never be widened again.
const serviceOptions = computed(() => [
  { value: '', label: t('All services') },
  ...options.serviceOptions.value.map((s) => ({ value: s, label: s })),
]);
const spanNameOptions = computed(() => [
  { value: '', label: t('Any span name') },
  ...options.spanNameOptions.value.map((s) => ({ value: s, label: s })),
]);
const spanNameModel = computed({
  get: () => rows.value.spanName ?? '',
  set: (v: string) => { rows.value.spanName = v; },
});

const schemaOpen = ref(false);
/** What the editor knows about this store — its tags, its services, its span
 *  names, and a way to ask for one tag's values. */
const schema = computed(() => ({
  ds: ds.value,
  tagKeys: options.tagKeys.value,
  services: options.serviceOptions.value,
  spanNames: options.spanNameOptions.value,
  valuesFor: options.valuesFor,
  requestValues: (tag: string) => void options.loadTagValues(tag),
}));
function insertIntoExpression(text: string): void {
  mode.value = 'traceql';
  // Spaced around the operator, as a query is read rather than as it is
  // minimally spelled. `duration` is ordered, so it gets an inequality.
  const snippet = text === 'duration' ? 'duration >' : `${text} = ""`;
  const current = expression.value.trim();
  if (!current) expression.value = `{${snippet}}`;
  else if (current.endsWith('}')) expression.value = `${current.slice(0, -1)} && ${snippet}}`;
  else expression.value = `${current} ${snippet}`;
}
const issueMessage = (id: string): string => issueText[id] ?? id;

const traceIds = ref<string[]>([]);
const submittedIds = ref<TraceIdSubmission | null>(null);
const byId = useTraceQLTraceIds(ds, submittedIds);

/** A trace picked from the list — shown INLINE beside it, as the native tab
 *  does. The overlay below is a different thing: a trace arrived at by URL,
 *  where there is no list for a card to sit beside. */
const openTraceId = ref<string | null>(null);
const urlTraceId = computed(() => {
  const raw = route.query[TRACEQL_POPOUT_QUERY];
  return typeof raw === 'string' && raw ? raw : null;
});
/** Clears only ITS key: wiping the whole query took the datasource and every
 *  other page parameter with it. */
function closeUrlTrace(): void {
  const query = { ...route.query };
  delete query[TRACEQL_POPOUT_QUERY];
  void router.replace({ query });
}
const railOpen = ref(true);
// Picking dots / brushing a box narrows the LIST to those traces; no query
// fires. The inline detail still opens from a list row, so a pick and a
// selection stay separate gestures.
const pickedTraceIds = ref<Set<string>>(new Set());
const pickedKeys = computed(() => [...pickedTraceIds.value]);
const isPicking = computed(() => pickedTraceIds.value.size > 0);
function togglePick(rowKey: string): void {
  const next = new Set(pickedTraceIds.value);
  if (next.has(rowKey)) next.delete(rowKey);
  else next.add(rowKey);
  pickedTraceIds.value = next;
}
function onScatterBrush(keys: string[]): void {
  const next = new Set(pickedTraceIds.value);
  for (const k of keys) next.add(k);
  pickedTraceIds.value = next;
}
function resetPick(): void {
  pickedTraceIds.value = new Set();
}

/** Statuses learned from a detail read, keyed by trace id. The search response
 *  has no failure marker, so a row is unknown until something authoritative
 *  says otherwise — and a detail is authoritative, because every OTLP span
 *  carries its own status. Cleared with the rest of the results. */
const knownStatus = ref<Map<string, boolean>>(new Map());
function recordStatus(v: { traceId: string; isError: boolean }): void {
  if (knownStatus.value.get(v.traceId) === v.isError) return;
  knownStatus.value = new Map(knownStatus.value).set(v.traceId, v.isError);
}
/** Rows the search could not classify are read, one trace at a time, once the
 *  list has landed — `recordStatus` receives each answer as it arrives. The
 *  window is the one the RUN captured, not the picker's current reading. */
const ranWindow = computed(() => submitted.value?.window ?? null);
const statusResolver = useTraceQLStatusResolver(ds, ranWindow, recordStatus);
// The search answers first and the statuses follow, because a list that waited
// for them would be slower than the question the operator actually asked.
watch(
  () => search.rows.value,
  (list) => {
    if (mode.value === 'traceId') return;
    void statusResolver.resolve(list);
  },
);

/** Apply what we have learned to the rows the list renders. */
function withKnownStatus(rows: TraceListRow[]): TraceListRow[] {
  if (knownStatus.value.size === 0) return rows;
  return rows.map((r) => {
    const known = knownStatus.value.get(r.key);
    return known === undefined ? r : { ...r, isError: known, errorUnknown: false };
  });
}
/**
 * Whether to SAY the source is down.
 *
 * The availability probe is cached for minutes and is only advisory: a query
 * that just succeeded is newer evidence than a probe that failed before the
 * source recovered, and must win. A failing query says so on its own.
 */
const sourceDown = computed(() => {
  if (!status.value || !status.value.configured) return false;
  if (hasRun.value && search.reachable.value && !search.error.value) return false;
  return !status.value.reachable;
});
const resultRows = computed(() =>
  withKnownStatus(mode.value === 'traceId' ? byId.rows.value : search.rows.value),
);
/** What the list shows: every row, or the picked ones while a pick is on. The
 *  distribution always draws them all — it is where the pick is made. */
const visibleRows = computed(() =>
  isPicking.value ? resultRows.value.filter((r) => pickedTraceIds.value.has(r.key)) : resultRows.value,
);
const resultMax = computed(() =>
  mode.value === 'traceId' ? resultRows.value.reduce((m, r) => Math.max(m, r.duration), 0) : search.maxDuration.value,
);
// A SUBMITTED lookup is a run: keying this on `answered` let the results area
// ask for a click on Run while the lookup it started was still in flight.
const hasRun = computed(() => (mode.value === 'traceId' ? submittedIds.value !== null : submitted.value !== null));
const busy = computed(() => (mode.value === 'traceId' ? byId.isFetching.value : search.isFetching.value));

// Cascade-clear: the store and the layer both invalidate everything on screen.
// The window does not, because a run CAPTURES it — an auto-refresh tick must
// not wipe a result set an operator is reading.
watch([ds, layerKey], () => {
  submitted.value = null;
  submittedIds.value = null;
  knownStatus.value = new Map();
  statusResolver.stop();
  openTraceId.value = null;
  rows.value = { tags: [] };
  expression.value = '';
});

// A service switch is a context change, not a staged edit: the committed query
// belonged to the previous service, so its result set, the open trace and the
// pick go with it and the page returns to the Run-query prompt. Every other
// builder field only stages — it waits for Run query, as the native tab does.
watch(
  () => rows.value.service ?? '',
  (next, prev) => {
    if (next === prev || mode.value === 'traceId') return;
    submitted.value = null;
    openTraceId.value = null;
    statusResolver.stop();
    knownStatus.value = new Map();
    resetPick();
  },
);

// A lookup by id is the one query that can run without a window, and it
// DEFAULTS to none: an id identifies a trace on its own, and a window an
// operator did not choose is the usual reason a known-good id finds nothing.
// Every other mode needs a window, so leaving "No time range" on would refuse
// them — the switch carries the choice both ways, as the native tab does.
watch(mode, (m) => {
  // The list is mode-scoped, so the open trace and the pick are too: leaving
  // them would show a trace from a result set the page is no longer rendering.
  openTraceId.value = null;
  resetPick();
  if (m === 'traceId') windowMinutes.value = NO_TIME_RANGE;
  else if (windowMinutes.value === NO_TIME_RANGE) windowMinutes.value = 30;
});

function run(): void {
  // Cascade-clear: a new run invalidates the open detail, the in-page pick and
  // everything learned from the previous result set. A pick left behind would
  // filter the NEXT result set against ids it does not contain — an empty list
  // under a query that answered.
  openTraceId.value = null;
  knownStatus.value = new Map();
  statusResolver.stop();
  resetPick();
  schemaOpen.value = false;
  if (rangeError.value) return;
  if (mode.value === 'traceId') {
    runs += 1;
    submittedIds.value = {
      ids: [...traceIds.value],
      window: windowMinutes.value === NO_TIME_RANGE ? null : currentWindow(),
      nonce: runs,
    };
    return;
  }
  if (typedTraceId.value) {
    openTraceId.value = typedTraceId.value;
    return;
  }
  runs += 1;
  // The tab's own picker, not the topbar's range — this screen owns its window.
  const window = currentWindow();
  if (!window) return;
  submitted.value = { q: editorText.value, window, limit: limit.value, nonce: runs };
}

function editAsTraceQL(): void {
  expression.value = generated.value;
  mode.value = 'traceql';
}

function addTag(): void {
  rows.value.tags = [...(rows.value.tags ?? []), { key: '', value: '' }];
}
function removeTag(i: number): void {
  rows.value.tags = (rows.value.tags ?? []).filter((_, n) => n !== i);
}

/** One line per finding. They say what the SCHEMA does not have, never what
 *  the backend would do with it. */
const issueText: Record<string, string> = {
  'incomplete-spanset': t('Not a complete spanset.'),
  'empty-value': t('This condition has no value.'),
  'unscoped-attribute': t('An attribute needs a scope — span.http.method, resource.service.name, or .http.method for the unscoped form.'),
  'unknown-field': t('Not a field in this schema. The intrinsics are duration, name and status; everything else is an attribute and carries a scope.'),
  'other-store-attribute': t('This attribute belongs to the other store’s schema.'),
  'status-vocabulary': t('A status other than “ok”, “error” or “unset”.'),
};
</script>

<template>
  <div class="tql-tab">
    <div class="tql-top-strip">
      <header class="tql-toolbar sw-card">
        <div class="tql-toolbar-head">
          <span class="kicker">{{ ds === 'zipkin' ? t('Traces · TraceQL · Zipkin') : t('Traces · TraceQL') }}</span>
          <div class="seg" role="group" :aria-label="t('Query by')">
            <button type="button" :class="{ on: mode === 'builder' }" :aria-pressed="mode === 'builder'" @click="mode = 'builder'">
              {{ t('Builder') }}
            </button>
            <button type="button" :class="{ on: mode === 'traceql' }" :aria-pressed="mode === 'traceql'" @click="mode = 'traceql'">
              {{ t('TraceQL') }}
            </button>
            <button type="button" :class="{ on: mode === 'traceId' }" :aria-pressed="mode === 'traceId'" @click="mode = 'traceId'">
              {{ t('Trace ID') }}
            </button>
          </div>
          <span v-if="status && !status.configured" class="hint">{{ t('not configured') }}</span>
          <span v-else-if="sourceDown" class="hint err">{{ t('unreachable') }}</span>
          <span v-else-if="busy" class="hint">{{ t('refreshing…') }}</span>
          <button
            class="sw-btn primary tql-run-btn"
            type="button"
            :disabled="Boolean(rangeError) || (mode === 'traceId' && !traceIds.length)"
            @click="run"
          >
            {{ mode !== 'traceId' && typedTraceId ? t('Open trace') : t('Run query') }}
          </button>
        </div>

        <div v-if="mode === 'builder'" class="tql-conditions">
          <label class="cf">
            <span>{{ t('Service') }}</span>
            <TypeaheadSelect
              v-model="serviceModel"
              :aria-label="t('Service')"
              :options="serviceOptions"
              :placeholder="t('All')"
              class="cf-tas"
            />
          </label>
          <label class="cf" :class="{ disabled: !rows.service }">
            <span>{{ t('Span name') }} <small v-if="!rows.service" class="dim">— {{ t('pick a service') }}</small></span>
            <TypeaheadSelect
              v-model="spanNameModel"
              :aria-label="t('Span name')"
              :options="spanNameOptions"
              :placeholder="rows.service ? t('any') : t('select a service first')"
              :disabled="!rows.service"
              class="cf-tas"
            />
          </label>
          <label class="cf">
            <span>{{ t('Status') }}</span>
            <!-- The values the language defines, on both stores. What a
                 backend applies is its own business. -->
            <select v-model="rows.status" class="cf-input">
              <option value="">{{ t('All') }}</option>
              <option v-for="v in TRACEQL_STATUS_VALUES" :key="v" :value="v">{{ v }}</option>
            </select>
          </label>
          <TraceQLWindowFields
            v-model:window-minutes="windowMinutes"
            v-model:custom-start="customStart"
            v-model:custom-end="customEnd"
            v-model:limit="limit"
            :custom-range="CUSTOM_RANGE"
            :trace-id-mode="isTraceIdMode"
          />
          <!-- One labelled pair, as the native tab's duration range is. The
               values keep TraceQL's units (`100ms`, `2s`), which is what the
               expression carries — hence text inputs rather than numbers. -->
          <div class="cf" :title="t('Trace duration, with a unit — us, ms, s, m, h.')">
            <span>{{ t('Duration range') }}</span>
            <div class="cf-range">
              <input v-model="rows.minDuration" class="cf-input cf-range-num mono" type="text" :placeholder="t('min')" />
              <span class="cf-range-sep">–</span>
              <input v-model="rows.maxDuration" class="cf-input cf-range-num mono" type="text" :placeholder="t('max')" />
            </div>
          </div>
          <div class="cf cf-full tql-tag-row">
            <span>{{ t('Tags') }}</span>
            <div class="tql-taglist">
              <div v-for="(tag, i) in rows.tags ?? []" :key="i" class="tql-tag">
                <input
                  v-model="tag.key"
                  list="tql-tagkeys"
                  class="cf-input mono"
                  :placeholder="t('key')"
                  @change="options.loadTagValues(tag.key)"
                />
                <input
                  v-model="tag.value"
                  :list="`tql-tagvals-${i}`"
                  class="cf-input mono"
                  :placeholder="t('value')"
                />
                <datalist :id="`tql-tagvals-${i}`">
                  <option v-for="v in options.valuesFor(tag.key)" :key="v" :value="v" />
                </datalist>
                <button type="button" class="sw-btn small ghost" :aria-label="t('Remove')" @click="removeTag(i)">×</button>
              </div>
              <button type="button" class="sw-btn small ghost" @click="addTag">+ {{ t('Tag') }}</button>
              <datalist id="tql-tagkeys">
                <option v-for="k in options.tagKeys.value" :key="k" :value="k" />
              </datalist>
            </div>
          </div>
          <div class="cf cf-full">
            <span>{{ t('TraceQL query') }}</span>
            <div class="tql-generated">
              <code class="mono">{{ generated }}</code>
              <button type="button" class="sw-btn small ghost" @click="editAsTraceQL">{{ t('Edit as TraceQL') }}</button>
            </div>
          </div>
        </div>

        <div v-else-if="mode === 'traceId'" class="tql-conditions">
          <!-- Not inside a <label>: a label forwards a click on its text to the
               first control in it, which here is a chip's remove button. -->
          <div class="cf cf-wide">
            <span>{{ t('Trace ID(s)') }}</span>
            <ChipInput
              v-model="traceIds"
              :placeholder="t('paste a trace id, then Enter')"
              :aria-label="t('Trace ID(s)')"
            />
            <span class="cf-note">
              {{ t('This API reads one id per request, so several ids are {n} separate reads.', { n: TRACE_ID_LOOKUP_MAX }) }}
            </span>
          </div>
          <TraceQLWindowFields
            v-model:window-minutes="windowMinutes"
            v-model:custom-start="customStart"
            v-model:custom-end="customEnd"
            v-model:limit="limit"
            :custom-range="CUSTOM_RANGE"
            :trace-id-mode="isTraceIdMode"
          />
        </div>

        <div v-else class="tql-conditions">
          <div class="cf cf-full">
            <span>
              {{ t('TraceQL query') }}
              <small class="dim">— {{ t('Shift+Enter runs; a bare trace id opens that trace') }}</small>
            </span>
            <TraceQLEditor
              v-model="editorText"
              :schema="schema"
              :message-for="issueMessage"
              @run="run"
            />
          </div>
          <TraceQLWindowFields
            v-model:window-minutes="windowMinutes"
            v-model:custom-start="customStart"
            v-model:custom-end="customEnd"
            v-model:limit="limit"
            :custom-range="CUSTOM_RANGE"
            :trace-id-mode="isTraceIdMode"
          />

          <div class="cf cf-full">
            <TraceQLSchemaPanel
              v-model:open="schemaOpen"
              :ds="ds"
              :tag-keys="options.tagKeys.value"
              @insert="insertIntoExpression"
            />
          </div>
        </div>

        <!-- What the editor found in the text being written. What the BACKEND
             said about the text that was RUN belongs with the result it stands
             in for, in the list below. -->
        <div v-if="issues.length || rangeError" class="tql-notice">
          <p v-if="rangeError" class="tql-range-err">{{ t(rangeError, { d: MAX_RECORD_RANGE_DAYS }) }}</p>
          <ul v-if="issues.length" class="tql-issues">
            <li v-for="i in issues" :key="i.id">
              <code class="mono">{{ i.found }}</code>
              {{ issueText[i.id] }}
            </li>
          </ul>
        </div>
      </header>

      <section class="tql-scatter sw-card">
        <header class="tql-scatter-head">
          <span v-if="!isPicking" class="kicker">{{ t('Distribution') }}</span>
          <span v-else class="kicker pick-kicker">{{ t('{n} picked', { n: pickedTraceIds.size }) }}</span>
          <span class="legend">
            <span class="lg ok" /> {{ t('ok') }}
            <span class="lg err" /> {{ t('err') }}
          </span>
          <button
            v-if="isPicking"
            class="sw-btn small ghost reset-btn"
            type="button"
            :title="t('Clear in-page filter')"
            @click="resetPick"
          >{{ t('Reset') }}</button>
        </header>
        <TraceDistribution
          v-if="resultRows.length"
          :rows="resultRows"
          :max-duration="resultMax"
          :selected-key="openTraceId"
          :highlight-keys="pickedKeys"
          @select="togglePick($event.key)"
          @brush="onScatterBrush"
        />
        <div v-else class="tql-empty">{{ t('no traces') }}</div>
      </section>
    </div>

    <article class="tql-list-card sw-card">
      <header class="tql-list-head">
        <h4>{{ t('Traces') }}</h4>
        <span v-if="!search.reachable.value" class="err-chip">{{ t('unreachable') }}</span>
        <span v-if="resultRows.length" class="hint">{{ visibleRows.length }} {{ t('traces') }}</span>
        <span v-if="isPicking" class="hint">{{ t('picked from {n}', { n: resultRows.length }) }}</span>
        <span v-if="mode !== 'traceId' && search.capped.value" class="hint">
          {{ t('capped at {n} — narrow the query', { n: resultRows.length }) }}
        </span>
        <span v-if="statusResolver.pending.value" class="hint">
          {{ t('checking {n} statuses…', { n: statusResolver.pending.value }) }}
        </span>
        <!-- An id the source could not be ASKED about is not an id it does not
             have: an outage reported as "not found" sends the operator looking
             for a trace that may well be there. -->
        <span v-if="mode === 'traceId' && byId.skipped.value.length" class="hint err">
          {{ t('{n} not read — over the {max}-id limit', { n: byId.skipped.value.length, max: TRACE_ID_LOOKUP_MAX }) }}
        </span>
        <span v-if="mode === 'traceId' && byId.failed.value.length" class="hint err">
          {{ t('{n} not read — the source did not answer', { n: byId.failed.value.length }) }}
        </span>
        <span v-if="mode === 'traceId' && byId.missing.value.length" class="hint err">
          {{ t('{n} not found', { n: byId.missing.value.length }) }}
        </span>
      </header>

      <div v-if="status && !status.configured" class="tql-empty">
        {{ t('No TraceQL URL is configured for this source. Set oap.traceql in horizon.yaml.') }}
      </div>
      <div v-else-if="sourceDown" class="tql-empty err">
        {{ t('TraceQL is configured but not answering at {url}.', { url: status?.url ?? '' }) }}
        <code v-if="status?.error" class="mono">{{ status.error }}</code>
      </div>
      <div v-else-if="!hasRun" class="tql-empty">
        {{ t('Pick your conditions, then click Run query.') }}
      </div>
      <div v-else-if="busy" class="tql-empty">{{ t('Reading data…') }}</div>
      <div v-else-if="mode !== 'traceId' && search.error.value" class="tql-empty err">
        <span class="tql-refused-label">{{ t('The source refused this query') }}</span>
        <code class="mono">{{ search.error.value }}</code>
      </div>
      <div v-else-if="!resultRows.length" class="tql-empty">{{ t('No traces matched.') }}</div>
      <TraceListPanel
        v-else-if="!openTraceId"
        :rows="visibleRows"
        :selected-key="openTraceId"
        :max-duration="resultMax"
        @select="openTraceId = $event.key"
      />
    </article>

    <!-- A picked trace: the list folds to a rail and the detail sits beside it,
         which is how the native tab reads. -->
    <section v-if="openTraceId" class="tql-detail-split" :class="{ 'rail-collapsed': !railOpen }">
      <TraceListPanel
        foldable
        :rail-open="railOpen"
        :rows="visibleRows"
        :selected-key="openTraceId"
        :max-duration="resultMax"
        :title="t('Traces')"
        :count-hint="visibleRows.length"
        @select="openTraceId = $event.key"
        @toggle-rail="railOpen = !railOpen"
      />
      <TraceQLTraceDetail
        :ds="ds"
        :trace-id="openTraceId"
        @status="recordStatus"
        @close="openTraceId = null"
      />
    </section>

    <!-- Arrived by URL, with no list to sit beside. -->
    <div v-if="urlTraceId" class="tql-overlay" @click.self="closeUrlTrace">
      <TraceQLTraceDetail
        class="tql-overlay-card"
        :ds="ds"
        :trace-id="urlTraceId"
        @status="recordStatus"
        @close="closeUrlTrace"
      />
    </div>
  </div>
</template>

<style scoped>
.tql-tab { display: flex; flex-direction: column; gap: 12px; }
.tql-top-strip {
  display: grid;
  grid-template-columns: 4fr 1fr;
  gap: 12px;
  align-items: stretch;
}
.tql-top-strip .tql-scatter { min-height: var(--sw-trace-strip-h); }
@media (max-width: 1100px) { .tql-top-strip { grid-template-columns: 1fr; } }

.tql-toolbar { padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; overflow: visible; }
/* Centred rather than baseline-aligned: the switch and the button are the same
   height here, so they read as one bar. */
.tql-toolbar-head { display: flex; align-items: center; gap: 10px; }
.tql-run-btn { margin-left: auto; }
/* The native tab's Run button, to the pixel — the global `.sw-btn.primary` is
   narrower, and the two sit on the same row of the same console. */
.sw-btn.primary {
  background: var(--sw-accent);
  color: var(--sw-bg-0);
  border: none;
  height: 26px;
  padding: 0 14px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.sw-btn.primary:disabled { opacity: 0.5; cursor: not-allowed; }
.seg { display: inline-flex; border: 1px solid var(--sw-line-2); border-radius: 5px; overflow: hidden; }
.seg button {
  background: var(--sw-bg-2);
  color: var(--sw-fg-2);
  border: none;
  height: 26px;
  padding: 0 12px;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.seg button + button { border-left: 1px solid var(--sw-line-2); }
.seg button.on { background: var(--sw-accent); color: #fff; }
.kicker {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sw-accent);
  font-weight: 600;
}
.hint { font-size: 10.5px; color: var(--sw-fg-3); }
.hint.err { color: var(--sw-err); }

.tql-conditions { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px 10px; }
/* `:deep` so the window/limit fields, which live in their own component, wear
   the same condition-field styling as the ones written inline here — a scoped
   rule stops at the component boundary and left them browser-default. */
.cf, :deep(.cf) { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--sw-fg-3); font-weight: 500; min-width: 0; }
.cf.cf-wide { grid-column: span 2; }
.cf.cf-full { grid-column: 1 / -1; }
.cf.disabled > span { color: var(--sw-fg-3); opacity: 0.7; }
.cf small, :deep(.cf small) { font-weight: 400; font-size: 9.5px; margin-left: 4px; font-style: italic; }
.cf .dim { color: var(--sw-fg-3); }
.cf-input, :deep(.cf-input) {
  height: 28px;
  padding: 0 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11px;
  width: 100%;
  box-sizing: border-box;
}
.cf-input:focus, :deep(.cf-input:focus) { outline: none; border-color: var(--sw-accent-line); }
.cf-input:disabled, :deep(.cf-input:disabled) { opacity: 0.5; cursor: not-allowed; background: var(--sw-bg-1); }
.cf-tas { display: block; width: 100%; }
.cf-tas :deep(.tas__trigger) {
  width: 100%;
  max-width: none;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  font-size: 11px;
  background: var(--sw-bg-2);
  border-radius: 4px;
}
.tql-editor { height: auto; padding: 6px 8px; line-height: 1.5; resize: vertical; }
/* Three key/value pairs to a row, each pair sized to its share rather than to
   a fixed width, so a long tag key is readable instead of clipped. */
.tql-taglist { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px 10px; align-items: center; }
.tql-tag { display: flex; gap: 4px; align-items: center; min-width: 0; }
.tql-tag .cf-input { min-width: 0; flex: 1 1 auto; }
.tql-taglist > .sw-btn { justify-self: start; }
.tql-generated { display: flex; align-items: center; gap: 8px; }
.tql-generated code {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
  font-size: 11px;
  color: var(--sw-fg-1);
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-1);
  border-radius: 4px;
  padding: 5px 8px;
}
.cf-note { font-size: 9.5px; color: var(--sw-fg-3); }
.tql-notice {
  margin-top: 8px;
  padding: 7px 10px;
  border: 1px solid var(--sw-warn);
  border-radius: 5px;
  background: color-mix(in srgb, var(--sw-warn) 8%, transparent);
  /* Bounded, so a query that trips many rules scrolls its own findings rather
     than stretching the card and the distribution drawn beside it. */
  max-height: 96px;
  overflow: auto;
}
.tql-refused-label { font-weight: 600; margin-right: 8px; }
.tql-range-err { margin: 0 0 3px; font-size: 10.5px; color: var(--sw-warn); }
.tql-issues { margin: 0; padding-left: 16px; font-size: 10.5px; color: var(--sw-warn); }
.tql-issues code { color: var(--sw-fg-1); }

.tql-scatter { padding: 6px 10px 8px; display: flex; flex-direction: column; min-height: 0; }
.tql-scatter-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 2px; flex: 0 0 auto; }
.tql-scatter-head .legend { margin-left: auto; font-size: 10.5px; color: var(--sw-fg-3); display: inline-flex; gap: 10px; align-items: center; }
.tql-scatter-head .lg { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 3px; vertical-align: middle; }
.tql-scatter-head .lg.ok { background: var(--sw-accent); }
.tql-scatter-head .lg.err { background: var(--sw-err); }
.tql-scatter :deep(.scatter-wrap) { flex: 1; min-height: 0; }

.tql-detail-split {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 12px;
  align-items: start;
}
.tql-detail-split.rail-collapsed { grid-template-columns: 64px 1fr; }
.tql-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: 40;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 40px 16px;
  overflow: auto;
}
.tql-overlay-card { width: min(1100px, 100%); }
.tql-list-card { padding: 0; display: flex; flex-direction: column; min-height: 0; max-height: calc(100vh - 80px); overflow: hidden; }
.pick-kicker { color: var(--sw-accent-2); font-weight: 700; }
.reset-btn { margin-left: 6px; }

.cf-range { display: flex; align-items: center; gap: 4px; }
.cf-range-num { flex: 1; min-width: 0; }
.cf-range-sep { color: var(--sw-fg-3); font-size: 12px; flex: 0 0 auto; }

.tql-list-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--sw-line-1);
  flex: 0 0 auto;
}
.tql-list-head h4 { margin: 0; font-size: 12px; font-weight: 600; }
.err-chip {
  font-size: 10px;
  color: var(--sw-err);
  border: 1px solid var(--sw-err);
  border-radius: 3px;
  padding: 0 5px;
}
.tql-list-card :deep(.tr-rowlist) { overflow-y: auto; min-height: 0; }
.tql-empty {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-height: 90px;
  padding: 18px 12px;
  font-size: 11.5px;
  color: var(--sw-fg-3);
  text-align: center;
}
.tql-empty.err { color: var(--sw-err); }
.tql-empty code { color: var(--sw-fg-3); font-size: 10.5px; overflow-wrap: anywhere; }
.mono { font-family: var(--sw-mono); }
</style>
