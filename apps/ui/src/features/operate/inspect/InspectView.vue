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
 * Inspect — SWIP-14. Browse OAP's metric catalog, pick the entity
 * that holds values, plot the MQE series. All data comes from the
 * BFF's `/api/inspect/*` endpoints; this page used to be a static
 * mock and now talks to the real OAP.
 *
 * Wiring:
 *   - `GET /api/inspect/catalog`     — full /inspect/metrics + Studio
 *                                      attribution (source + file).
 *   - `GET /api/inspect/entities`    — per-widget entity enumeration.
 *   - `POST /api/inspect/exec`       — fires `execExpression` and
 *                                      returns the ExpressionResult.
 *
 * Refresh: the header button invalidates every `['inspect', …]`
 * vue-query key AND passes `refresh=true` to the catalog endpoint so
 * the BFF rebuilds its attribution cache.
 */
import { computed, reactive, ref, watch, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import InspectMetricChart from './InspectMetricChart.vue';
import {
  INSPECT_STEPS,
  type EntitiesResponse,
  type EntityRow,
  type ExpressionResult,
  type InspectScope,
  type InspectStep,
  type MqeEntity,
} from '@skywalking-horizon-ui/api-client';
import { bff, describeApiError, type InspectCatalogEntry, type InspectServerTimeResponse } from '@/api/client';
import Btn from '@/components/primitives/Btn.vue';
import Pill from '@/components/primitives/Pill.vue';
import AdminFeatureWarning from '@/shell/AdminFeatureWarning.vue';

const { t } = useI18n({ useScope: 'global' });

// ─── Types local to the page ────────────────────────────────────────

type Source = 'OAL' | 'MAL·OTEL' | 'MAL·Telegraf' | 'LAL→MAL' | 'unknown';
type ChartKind = 'line' | 'bar' | 'area';

interface FileNode {
  source: Source;
  file: string;
  scopes: InspectScope[];
  metricCount: number;
}

interface Widget {
  id: string;
  metric: InspectCatalogEntry;
  /** Entities resolved by `/api/inspect/entities`. May be empty
   *  before the editor has ever been opened. */
  resolvedEntities: EntityRow[];
  /** Operator-added custom entities (form-built). */
  customEntities: EntityRow[];
  /** ids of entities to plot. Default = top-1 resolved. */
  selectedIds: Set<string>;
  /** Whether resolvedEntities has been fetched yet for the current
   *  range (used to decide between "load on open" and "use cached"). */
  resolvedFetched: boolean;
  /** Loading state for /api/inspect/exec for this widget. */
  loading: boolean;
  /** Error string from the last exec call, if any. */
  error: string | null;
  /** Latest MQE result (drives the chart). */
  result: ExpressionResult | null;
  chart: ChartKind;
}

interface EntityFormFields {
  serviceName: string;
  serviceInstanceName: string;
  endpointName: string;
  destServiceName: string;
  destServiceInstanceName: string;
  destEndpointName: string;
  normal: boolean;
  destNormal: boolean;
}

// ─── Toolbar / range state ─────────────────────────────────────────
//
// Dates are stored as `Date` objects in browser-local wall time. The
// input boxes display them with `formatLocal(date, step)` (e.g.
// `2026-05-11 0830`). When we send to OAP via the BFF, we shift by
// the server TZ offset and format with `formatForServer(...)` so OAP
// reads the same wall-clock-in-its-TZ.

const boardCap = ref<number>(10);
const inspectorTopN = ref<number>(10);
const density = ref<1 | 3 | 5>(3);
const DENSITY_OPTIONS: (1 | 3 | 5)[] = [1, 3, 5];

interface Preset {
  label: string;
  step: InspectStep;
  /** How far back from `now` the start is, in millis. */
  back: number;
}
const PRESETS: Preset[] = [
  { label: 'last 10m', step: 'MINUTE', back: 10 * 60_000 },
  { label: 'last 5h', step: 'HOUR', back: 5 * 3_600_000 },
  { label: 'last 2d', step: 'DAY', back: 2 * 86_400_000 },
];
/** Preset labels are stable identifiers (used for localStorage persistence
 *  and `activePreset` comparison). Render them through this helper so the
 *  button text translates while the underlying key stays English. */
function presetLabel(label: string): string {
  return t(label);
}

const step = ref<InspectStep>('MINUTE');
const start = ref<Date>(new Date(Date.now() - PRESETS[0]!.back));
const end = ref<Date>(new Date());
/** Which preset is "current". `null` once the operator manually edits. */
const activePreset = ref<string | null>(PRESETS[0]!.label);

function applyPreset(p: Preset): void {
  step.value = p.step;
  end.value = new Date();
  start.value = new Date(end.value.getTime() - p.back);
  activePreset.value = p.label;
  /* Eager-sync the input strings. The `watch([start,end,step])`
   * below also syncs them, but that watch runs on the next tick —
   * any synchronous reader of `rangeValid` between now and the watch
   * sees stale strings, which is exactly what bit hydration when the
   * saved preset's step differed from the initial 'MINUTE'. */
  startStr.value = formatLocal(start.value, step.value);
  endStr.value = formatLocal(end.value, step.value);
}

/** Server-TZ offset in minutes east of UTC. Pulled once on mount,
 *  refreshed when the operator hits the page-level refresh button.
 *  Falls back to the browser's offset if OAP is unreachable. */
const serverTimeQuery = useQuery({
  queryKey: ['inspect', 'server-time'],
  queryFn: () => bff.inspect.serverTime(),
  staleTime: 5 * 60_000,
  refetchOnWindowFocus: false,
});
const serverOffsetMinutes = computed(
  () => serverTimeQuery.data.value?.offsetMinutes ?? -new Date().getTimezoneOffset(),
);
const serverTimeInfo = computed<InspectServerTimeResponse | null>(() => serverTimeQuery.data.value ?? null);

/** Zero-pad an integer to two digits. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Format a Date in browser-local wall time for the given step. This
 *  is what the date input shows to the operator. */
function formatLocal(d: Date, s: InspectStep): string {
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  if (s === 'DAY') return `${y}-${m}-${day}`;
  const hh = pad2(d.getHours());
  if (s === 'HOUR') return `${y}-${m}-${day} ${hh}`;
  return `${y}-${m}-${day} ${hh}${pad2(d.getMinutes())}`;
}

/** Parse the input box's string back into a Date in browser-local
 *  wall time. Returns null on malformed input — the input box turns
 *  red and the toolbar disables fan-out. */
function parseLocal(str: string, s: InspectStep): Date | null {
  if (s === 'DAY') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  if (s === 'HOUR') {
    const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2})$/.exec(str);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]));
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2})(\d{2})$/.exec(str);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
}

/** Format a Date for the OAP MQE / inspect call. OAP reads dates in
 *  *its own* timezone; we shift the Date so its local wall-clock
 *  reads as the server's wall-clock, then format with the step's
 *  template. Identical to skywalking-booster-ui's `getLocalTime` +
 *  `dateFormatStep` pattern. */
function formatForServer(d: Date, s: InspectStep, offsetMinutes: number): string {
  const utcMillis = d.getTime() + d.getTimezoneOffset() * 60_000;
  const serverWall = new Date(utcMillis + offsetMinutes * 60_000);
  return formatLocal(serverWall, s);
}

// Two-way bound input strings — display in browser-local TZ.
const startStr = ref<string>(formatLocal(start.value, step.value));
const endStr = ref<string>(formatLocal(end.value, step.value));

watch([start, end, step], () => {
  startStr.value = formatLocal(start.value, step.value);
  endStr.value = formatLocal(end.value, step.value);
});

function onStartInput(): void {
  const parsed = parseLocal(startStr.value, step.value);
  if (parsed) {
    start.value = parsed;
    activePreset.value = null;
  }
}
function onEndInput(): void {
  const parsed = parseLocal(endStr.value, step.value);
  if (parsed) {
    end.value = parsed;
    activePreset.value = null;
  }
}

const startValid = computed(() => parseLocal(startStr.value, step.value) !== null);
const endValid = computed(() => parseLocal(endStr.value, step.value) !== null);
const rangeValid = computed(() => startValid.value && endValid.value);

/** Strings actually sent to OAP, in server TZ. */
const startForServer = computed(() => formatForServer(start.value, step.value, serverOffsetMinutes.value));
const endForServer = computed(() => formatForServer(end.value, step.value, serverOffsetMinutes.value));

/* OAP's `DurationUtils.MAX_TIME_RANGE` rejects any duration whose
 * bucket count exceeds 500 — see
 * `oap-server/server-core/.../query/DurationUtils.java:35`. We mirror
 * the cap client-side so widgets don't fire a query OAP will 500 on. */
const INSPECT_MAX_BUCKETS = 500;

function bucketsBetween(s: Date, e: Date, st: InspectStep): number {
  const ms = e.getTime() - s.getTime();
  if (ms <= 0) return 0;
  const per = st === 'DAY' ? 86_400_000 : st === 'HOUR' ? 3_600_000 : 60_000;
  return Math.ceil(ms / per) + 1;
}

const bucketCount = computed(() => bucketsBetween(start.value, end.value, step.value));
const bucketOverflow = computed(() => bucketCount.value > INSPECT_MAX_BUCKETS);

/** Format `min` as a `+HH:MM` / `-HH:MM` string for display. */
function signedMins(min: number): string {
  const sign = min < 0 ? '-' : '+';
  const abs = Math.abs(min);
  return `UTC${sign}${pad2(Math.trunc(abs / 60))}:${pad2(abs % 60)}`;
}

// ─── Catalog query ─────────────────────────────────────────────────

const queryClient = useQueryClient();
const catalogQuery = useQuery({
  queryKey: ['inspect', 'catalog'],
  queryFn: () => bff.inspect.catalog(),
  staleTime: 30_000,
  refetchOnWindowFocus: false,
});

const catalog = computed<InspectCatalogEntry[]>(() => catalogQuery.data.value?.metrics ?? []);

/** When the catalog endpoint comes back 404 we surface a one-line
 *  banner with the exact action: `SW_INSPECT=default` on OAP. */
const inspectNotEnabled = computed(() => {
  const err = catalogQuery.error.value as { status?: number; body?: { error?: string } } | null;
  if (!err) return false;
  if (typeof err === 'object' && 'status' in err && err.status === 404) {
    const b = err.body;
    if (typeof b === 'object' && b !== null && (b as { error?: string }).error === 'inspect_not_enabled') {
      return true;
    }
  }
  return false;
});

// ─── Filter state for the drawer ───────────────────────────────────

const drawerOpen = ref(false);
const drawerSelection = ref<Set<string>>(new Set());
const drawerQuery = ref('');
const drawerSourceFilter = ref<Set<Source>>(new Set<Source>(['OAL', 'MAL·OTEL', 'MAL·Telegraf', 'LAL→MAL', 'unknown']));
const drawerActiveFile = ref<string | null>(null);
const drawerScopeNarrow = ref<InspectScope | null>(null);

const drawerRegex = computed(() => {
  if (!drawerQuery.value) return null;
  try {
    return new RegExp(drawerQuery.value, 'i');
  } catch {
    return null;
  }
});

const drawerFiles = computed<FileNode[]>(() => {
  const map = new Map<string, FileNode>();
  for (const m of catalog.value) {
    const src = m.attribution.source as Source;
    if (!drawerSourceFilter.value.has(src)) continue;
    /* Group key uses `source::file`. Metrics with `file === null`
     * (orphans / 'unknown' source) get bucketed under a synthetic
     * "(unattributed)" file so the operator can still find them. */
    const fileKey = m.attribution.file ?? '(unattributed)';
    const key = `${src}::${fileKey}`;
    let node = map.get(key);
    if (!node) {
      node = { source: src, file: fileKey, scopes: [], metricCount: 0 };
      map.set(key, node);
    }
    if (!node.scopes.includes(m.scope)) node.scopes.push(m.scope);
    node.metricCount += 1;
  }
  return [...map.values()].sort((a, b) => {
    if (a.source !== b.source) return a.source.localeCompare(b.source);
    return a.file.localeCompare(b.file);
  });
});

const drawerGroupedFiles = computed<Record<Source, FileNode[]>>(() => {
  const groups: Record<Source, FileNode[]> = {
    OAL: [],
    'MAL·OTEL': [],
    'MAL·Telegraf': [],
    'LAL→MAL': [],
    unknown: [],
  };
  for (const f of drawerFiles.value) groups[f.source].push(f);
  return groups;
});

const activeFileNode = computed<FileNode | null>(() =>
  drawerFiles.value.find((f) => `${f.source}::${f.file}` === drawerActiveFile.value) ?? null,
);

const drawerMetrics = computed<InspectCatalogEntry[]>(() => {
  if (!drawerActiveFile.value) return [];
  const list = catalog.value.filter((m) => {
    const src = m.attribution.source as Source;
    const fileKey = m.attribution.file ?? '(unattributed)';
    if (`${src}::${fileKey}` !== drawerActiveFile.value) return false;
    if (drawerScopeNarrow.value && m.scope !== drawerScopeNarrow.value) return false;
    if (drawerRegex.value && !drawerRegex.value.test(m.name)) return false;
    return true;
  });
  // Operator scanning a long list expects alphabetical order — the
  // catalog wire order is registration order, which is ~random to
  // the human eye.
  return list.slice().sort((a, b) => a.name.localeCompare(b.name));
});

function isMqeQueryable(t: string): boolean {
  return t === 'REGULAR_VALUE' || t === 'LABELED_VALUE';
}

function openDrawer() {
  drawerSelection.value = new Set();
  drawerQuery.value = '';
  drawerScopeNarrow.value = null;
  if (!drawerActiveFile.value || !drawerFiles.value.some((f) => `${f.source}::${f.file}` === drawerActiveFile.value)) {
    const first = drawerFiles.value[0];
    drawerActiveFile.value = first ? `${first.source}::${first.file}` : null;
  }
  drawerOpen.value = true;
}
function toggleDrawerSource(s: Source) {
  const next = new Set(drawerSourceFilter.value);
  if (next.has(s)) next.delete(s);
  else next.add(s);
  drawerSourceFilter.value = next;
  if (drawerActiveFile.value && !drawerFiles.value.some((f) => `${f.source}::${f.file}` === drawerActiveFile.value)) {
    const first = drawerFiles.value[0];
    drawerActiveFile.value = first ? `${first.source}::${first.file}` : null;
  }
}
function selectFile(node: FileNode) {
  drawerActiveFile.value = `${node.source}::${node.file}`;
  drawerScopeNarrow.value = null;
}
function toggleDrawerPick(name: string, queryable: boolean) {
  if (!queryable) return;
  const next = new Set(drawerSelection.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  drawerSelection.value = next;
}
function selectAllVisible() {
  const next = new Set(drawerSelection.value);
  for (const m of drawerMetrics.value) {
    if (isMqeQueryable(m.type)) next.add(m.name);
  }
  drawerSelection.value = next;
}
function clearVisible() {
  const next = new Set(drawerSelection.value);
  for (const m of drawerMetrics.value) next.delete(m.name);
  drawerSelection.value = next;
}
function selectAllInFile(node: FileNode) {
  drawerActiveFile.value = `${node.source}::${node.file}`;
  drawerScopeNarrow.value = null;
  const next = new Set(drawerSelection.value);
  for (const m of catalog.value) {
    const src = m.attribution.source as Source;
    const fileKey = m.attribution.file ?? '(unattributed)';
    if (src === node.source && fileKey === node.file && isMqeQueryable(m.type)) {
      next.add(m.name);
    }
  }
  drawerSelection.value = next;
}
function commitDrawer() {
  const added: Widget[] = [];
  for (const name of drawerSelection.value) {
    if (widgets.value.length >= boardCap.value) break;
    const row = catalog.value.find((m) => m.name === name);
    if (!row) continue;
    if (widgets.value.some((w) => w.metric.name === row.name)) continue;
    const w = makeWidget(row);
    widgets.value.push(w);
    added.push(w);
  }
  drawerOpen.value = false;
  /* Eager resolve — operators expect "show me top-N" without an
   * extra click. resolveEntitiesFor sets selectedIds to the top-1
   * entity, which trips the selection watch and fires MQE. */
  for (const w of added) {
    void resolveEntitiesFor(w);
  }
}

// ─── Board / widgets ───────────────────────────────────────────────

interface MakeWidgetOpts {
  id?: string;
  customEntities?: EntityRow[];
  selectedIds?: Set<string>;
  chart?: ChartKind;
}
function makeWidget(metric: InspectCatalogEntry, opts: MakeWidgetOpts = {}): Widget {
  return reactive({
    id: opts.id ?? `${metric.name}-${Math.random().toString(36).slice(2, 7)}`,
    metric,
    resolvedEntities: [],
    customEntities: opts.customEntities ?? [],
    selectedIds: opts.selectedIds ?? new Set<string>(),
    resolvedFetched: false,
    loading: false,
    error: null,
    result: null,
    chart: opts.chart ?? 'line',
  }) as Widget;
}

// ─── Local persistence ────────────────────────────────────────────
//
// Save the board to localStorage so the operator's selection
// survives page refresh / re-entry. We persist only the structural
// bits (which metric, which selected entities, custom-built entities,
// chart kind); the resolved entity list and the MQE result re-fetch
// on restore so the data is fresh.
//
// Toolbar knobs (density, board cap, active preset) ride along.

const STORAGE_KEY = 'vs:inspect:board:v1';

interface PersistedWidget {
  id: string;
  metricName: string;
  selectedIds: string[];
  customEntities: EntityRow[];
  chart: ChartKind;
}

interface PersistedBoard {
  widgets: PersistedWidget[];
  density?: 1 | 3 | 5;
  boardCap?: number;
  inspectorTopN?: number;
  activePreset?: string | null;
}

function serializeBoard(): PersistedBoard {
  return {
    widgets: widgets.value.map((w) => ({
      id: w.id,
      metricName: w.metric.name,
      selectedIds: [...w.selectedIds],
      customEntities: w.customEntities,
      chart: w.chart,
    })),
    density: density.value,
    boardCap: boardCap.value,
    inspectorTopN: inspectorTopN.value,
    activePreset: activePreset.value,
  };
}

function saveBoard(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeBoard()));
  } catch {
    /* quota / private-browsing — swallow. */
  }
}

function loadBoard(): PersistedBoard | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedBoard;
  } catch {
    return null;
  }
}

/** Reset the board: clear widgets, dispose echarts instances,
 *  wipe storage. */
function resetBoard(): void {
  widgets.value = [];
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

function onReset(): void {
  if (widgets.value.length === 0) return;
  const n = widgets.value.length;
  const msg = n === 1
    ? t('Remove {n} widget from the board and clear the saved layout?', { n })
    : t('Remove {n} widgets from the board and clear the saved layout?', { n });
  if (!window.confirm(msg)) {
    return;
  }
  resetBoard();
}

const widgets = ref<Widget[]>([]);

/** Hydrate from localStorage as soon as the catalog query lands —
 *  before that we can't resolve a metric name to its catalog entry.
 *  Runs once per session: `hydrated` flips true after the first
 *  successful pass. */
const hydrated = ref(false);

function hydrateBoardIfReady(): void {
  if (hydrated.value) return;
  if (catalog.value.length === 0) return;
  hydrated.value = true;
  const saved = loadBoard();
  if (!saved) return;
  if (typeof saved.density === 'number' && [1, 3, 5].includes(saved.density)) {
    density.value = saved.density;
  }
  if (typeof saved.boardCap === 'number' && saved.boardCap > 0) boardCap.value = saved.boardCap;
  if (typeof saved.inspectorTopN === 'number' && saved.inspectorTopN > 0) {
    inspectorTopN.value = saved.inspectorTopN;
  }
  if (typeof saved.activePreset === 'string' || saved.activePreset === null) {
    const preset = PRESETS.find((p) => p.label === saved.activePreset);
    if (preset) applyPreset(preset);
  }
  const restored: Widget[] = [];
  for (const pw of saved.widgets) {
    const row = catalog.value.find((m) => m.name === pw.metricName);
    /* Skip widgets whose metric is no longer in the catalog — happens
     * after an OAP rule remove. The operator just sees a smaller
     * board than they left, no error. */
    if (!row) continue;
    restored.push(
      makeWidget(row, {
        id: pw.id,
        selectedIds: new Set(pw.selectedIds),
        customEntities: pw.customEntities ?? [],
        chart: pw.chart ?? 'line',
      }),
    );
  }
  widgets.value = restored;
  /* Re-resolve every restored widget AND fire MQE explicitly —
   * the selection watch only trips when `selectedIds` changes, but
   * hydrated widgets come back with a non-empty selection already,
   * so the watch sits silent and the chart never fills in. */
  for (const w of restored) {
    void (async () => {
      await resolveEntitiesFor(w);
      if (w.selectedIds.size > 0) await execWidget(w);
    })();
  }
}

/* watchEffect runs synchronously once during setup AND re-runs
 * whenever its deps change. Crucial when vue-query returns a cached
 * catalog immediately: a plain `watch` with `immediate: false` would
 * never fire because `catalog.value` doesn't change from "cached" to
 * "cached" on mount, and `hydrateBoardIfReady` is a no-op while the
 * list is empty. */
watchEffect(() => {
  if (catalog.value.length > 0) hydrateBoardIfReady();
});

/* Persist on every meaningful change. The watch fires more than
 * strictly necessary (intermediate loading/result updates) but the
 * write is small and synchronous, so we save unconditionally rather
 * than diffing. */
watch(
  () => widgets.value.map((w) => ({
    id: w.id,
    name: w.metric.name,
    sel: [...w.selectedIds].sort().join('|'),
    custom: w.customEntities.length,
    chart: w.chart,
  })),
  () => {
    if (hydrated.value) saveBoard();
  },
  { deep: true },
);
watch([density, boardCap, inspectorTopN, activePreset], () => {
  if (hydrated.value) saveBoard();
});

function removeWidget(id: string) {
  widgets.value = widgets.value.filter((w) => w.id !== id);
}
function cycleChart(w: Widget) {
  const order: ChartKind[] = ['line', 'bar', 'area'];
  const next = order[(order.indexOf(w.chart) + 1) % order.length] ?? 'line';
  w.chart = next;
}

function widgetAllEntities(w: Widget): EntityRow[] {
  return [...w.resolvedEntities, ...w.customEntities];
}
function singleSelected(w: Widget): EntityRow | null {
  if (w.selectedIds.size !== 1) return null;
  const id = w.selectedIds.values().next().value as string;
  return widgetAllEntities(w).find((e) => e.entityId === id) ?? null;
}
function toggleEntity(w: Widget, e: EntityRow) {
  const next = new Set(w.selectedIds);
  if (next.has(e.entityId)) next.delete(e.entityId);
  else next.add(e.entityId);
  w.selectedIds = next;
}
function selectAll(w: Widget) {
  w.selectedIds = new Set(widgetAllEntities(w).map((e) => e.entityId));
}
function selectNone(w: Widget) {
  w.selectedIds = new Set();
}
function selectTop(w: Widget, n: number) {
  w.selectedIds = new Set(w.resolvedEntities.slice(0, n).map((e) => e.entityId));
}
function stepEntity(w: Widget, dir: 1 | -1) {
  const all = widgetAllEntities(w);
  if (all.length === 0) return;
  const current = singleSelected(w);
  const i = current ? all.findIndex((e) => e.entityId === current.entityId) : -1;
  const next = all[(i + dir + all.length) % all.length];
  if (!next) return;
  w.selectedIds = new Set([next.entityId]);
}

function decodedLabel(e: EntityRow): string {
  const d = e.decoded as Record<string, unknown>;
  const scope = e.mqeEntity.scope;
  const layer = e.layer ? ` · ${e.layer}` : '';
  if (scope === 'Service' && typeof d.serviceName === 'string') {
    return `${d.serviceName}${layer}`;
  }
  if (scope === 'ServiceInstance' && typeof d.serviceName === 'string') {
    const inst = typeof d.serviceInstanceName === 'string' ? d.serviceInstanceName : '?';
    return `${d.serviceName} / ${inst}${layer}`;
  }
  if (scope === 'Endpoint' && typeof d.serviceName === 'string') {
    const ep = typeof d.endpointName === 'string' ? d.endpointName : '?';
    return `${d.serviceName} : ${ep}${layer}`;
  }
  if (scope.endsWith('Relation') && typeof d.source === 'object' && d.source !== null) {
    const s = d.source as Record<string, unknown>;
    const t = (d.destination ?? {}) as Record<string, unknown>;
    const sName = String(s.serviceName ?? '?');
    const dName = String(t.serviceName ?? '?');
    return `${sName} → ${dName}${layer}`;
  }
  return e.entityId;
}

// ─── Per-widget entity resolution ──────────────────────────────────

async function resolveEntitiesFor(w: Widget): Promise<void> {
  if (!rangeValid.value) return;
  if (bucketOverflow.value) {
    w.error = t('range produces {n} buckets · OAP cap is {cap}. Use a smaller range or coarser step.', { n: bucketCount.value, cap: INSPECT_MAX_BUCKETS });
    return;
  }
  w.error = null;
  try {
    const res: EntitiesResponse = await bff.inspect.entities({
      metric: w.metric.name,
      start: startForServer.value,
      end: endForServer.value,
      step: step.value,
      limit: inspectorTopN.value,
    });
    w.resolvedEntities = res.rows;
    w.resolvedFetched = true;
    /* Single-entity default — first row is the most-recent per the
     * SWIP-14 sort order, so it's the most likely to have values. */
    const first = res.rows[0];
    if (first && w.selectedIds.size === 0) {
      w.selectedIds = new Set([first.entityId]);
    }
  } catch (err) {
    w.error = describeApiError(err);
  }
}

// ─── Per-widget MQE fire ───────────────────────────────────────────

/* When the selection or range changes, re-fire MQE for the widget.
 * For multi-entity selections we make one MQE call per entity and
 * stitch the series into one chart — execExpression takes a single
 * Entity input. */
async function execWidget(w: Widget): Promise<void> {
  if (!rangeValid.value || w.selectedIds.size === 0) {
    w.result = null;
    return;
  }
  if (bucketOverflow.value) {
    w.result = null;
    w.error = t('range produces {n} buckets · OAP cap is {cap}. Use a smaller range or coarser step.', { n: bucketCount.value, cap: INSPECT_MAX_BUCKETS });
    return;
  }
  w.loading = true;
  w.error = null;
  const targets = widgetAllEntities(w).filter((e) => w.selectedIds.has(e.entityId));
  try {
    const calls = targets.map((e) =>
      bff.inspect.exec({
        expression: w.metric.name,
        entity: e.mqeEntity,
        duration: { start: startForServer.value, end: endForServer.value, step: step.value },
      }).then((r) => ({ entity: e, result: r })),
    );
    const settled = await Promise.all(calls);
    /* Merge into one ExpressionResult by tagging each series with the
     * entity's decoded name as the metric label. Single-entity case
     * keeps the upstream label set intact (for LABELED_VALUE). */
    if (settled.length === 1) {
      w.result = settled[0]!.result;
    } else {
      const merged: ExpressionResult = { type: 'TIME_SERIES_VALUES', results: [], error: null };
      for (const { entity, result } of settled) {
        const tag = decodedLabel(entity);
        for (const r of result.results) {
          merged.results.push({
            metric: { labels: [...r.metric.labels, { key: 'entity', value: tag }] },
            values: r.values,
          });
        }
      }
      w.result = merged;
    }
  } catch (err) {
    w.error = describeApiError(err);
    w.result = null;
  } finally {
    w.loading = false;
  }
}

watch(
  () => widgets.value.map((w) => ({
    id: w.id,
    sel: [...w.selectedIds].sort().join('|'),
    metric: w.metric.name,
  })),
  (curr, prev) => {
    /* Fire MQE for widgets whose selected set changed. We can't watch
     * the full widget object deeply because it'd recurse on result
     * updates. */
    const prevMap = new Map((prev ?? []).map((p) => [p.id, p.sel]));
    for (const c of curr) {
      const before = prevMap.get(c.id);
      if (before !== c.sel) {
        const w = widgets.value.find((x) => x.id === c.id);
        if (w) void execWidget(w);
      }
    }
  },
  { deep: true },
);

watch([start, end, step], async () => {
  if (!rangeValid.value) return;
  /* Range change: re-resolve entities for any widget whose editor was
   * already opened (resolvedFetched), AND re-fire MQE for every
   * widget with a selection. When the new range exceeds the bucket
   * cap, resolveEntitiesFor / execWidget set the per-widget error
   * themselves; otherwise they refresh the chart. */
  for (const w of widgets.value) {
    if (w.resolvedFetched) await resolveEntitiesFor(w);
    if (w.selectedIds.size > 0) await execWidget(w);
  }
});

// ─── Entity editor popover ─────────────────────────────────────────

const editorForWidget = ref<string | null>(null);
const editorErr = ref<string>('');
const editorForm = ref<EntityFormFields>(emptyForm());

function emptyForm(): EntityFormFields {
  return {
    serviceName: '',
    serviceInstanceName: '',
    endpointName: '',
    destServiceName: '',
    destServiceInstanceName: '',
    destEndpointName: '',
    normal: true,
    destNormal: true,
  };
}

type PrimaryField = 'serviceName' | 'serviceInstanceName' | 'endpointName';
type DestField = 'destServiceName' | 'destServiceInstanceName' | 'destEndpointName';
interface ScopeFields {
  primary: PrimaryField[];
  dest: DestField[];
}
function fieldsFor(scope: InspectScope): ScopeFields {
  switch (scope) {
    case 'Service':
      return { primary: ['serviceName'], dest: [] };
    case 'ServiceInstance':
      return { primary: ['serviceName', 'serviceInstanceName'], dest: [] };
    case 'Endpoint':
      return { primary: ['serviceName', 'endpointName'], dest: [] };
    case 'ServiceRelation':
      return { primary: ['serviceName'], dest: ['destServiceName'] };
    case 'ServiceInstanceRelation':
      return { primary: ['serviceName', 'serviceInstanceName'], dest: ['destServiceName', 'destServiceInstanceName'] };
    case 'EndpointRelation':
      return { primary: ['serviceName', 'endpointName'], dest: ['destServiceName', 'destEndpointName'] };
    default:
      return { primary: ['serviceName'], dest: [] };
  }
}
const PLACEHOLDERS: Record<PrimaryField | DestField, string> = {
  serviceName: 'payment',
  serviceInstanceName: 'pod-01',
  endpointName: '/charge',
  destServiceName: 'provider',
  destServiceInstanceName: 'pod-b',
  destEndpointName: '/order',
};

async function openEditor(id: string) {
  editorForWidget.value = id;
  editorForm.value = emptyForm();
  editorErr.value = '';
  /* Resolve entities lazily on first editor open, so the page load
   * doesn't fan out 10 entity calls. */
  const w = widgets.value.find((x) => x.id === id);
  if (w && !w.resolvedFetched && rangeValid.value) {
    await resolveEntitiesFor(w);
  }
}
function closeEditor() {
  editorForWidget.value = null;
}
function copyMqeEntity(w: Widget) {
  const sel = widgetAllEntities(w).filter((e) => w.selectedIds.has(e.entityId));
  if (sel.length === 0) return;
  const payload = sel.length === 1 ? sel[0]!.mqeEntity : sel.map((e) => e.mqeEntity);
  navigator.clipboard?.writeText(JSON.stringify(payload, null, 2));
}

function addCustomEntity(w: Widget) {
  editorErr.value = '';
  const f = editorForm.value;
  const scope = w.metric.scope;
  const fs = fieldsFor(scope);
  for (const k of [...fs.primary, ...fs.dest]) {
    if (!f[k].trim()) {
      editorErr.value = t('{field} is required for scope {scope}', { field: k, scope });
      return;
    }
  }
  const mqe: MqeEntity = { scope };
  const mqeAny = mqe as unknown as Record<string, unknown>;
  for (const k of fs.primary) mqeAny[k] = f[k].trim();
  mqe.normal = f.normal;
  for (const k of fs.dest) mqeAny[k] = f[k].trim();
  if (fs.dest.length > 0) mqe.destNormal = f.destNormal;
  const entityId = `custom-${Math.random().toString(36).slice(2, 8)}`;
  const decoded: Record<string, unknown> = {};
  for (const k of fs.primary) decoded[k] = f[k].trim();
  for (const k of fs.dest) decoded[k] = f[k].trim();
  const custom: EntityRow = {
    entityId,
    decoded,
    layer: 'CUSTOM',
    mqeEntity: mqe,
  };
  w.customEntities = [...w.customEntities, custom];
  w.selectedIds = new Set([entityId]);
  editorForm.value = emptyForm();
}
function removeCustom(w: Widget, e: EntityRow) {
  w.customEntities = w.customEntities.filter((c) => c.entityId !== e.entityId);
  const next = new Set(w.selectedIds);
  next.delete(e.entityId);
  w.selectedIds = next;
}
async function rerunInspectFor(w: Widget) {
  await resolveEntitiesFor(w);
  /* `resolveEntitiesFor` only touches `selectedIds` when it was
   * empty (top-1 default). When the operator already had a
   * selection we leave it alone; firing MQE explicitly here is the
   * way to make the chart redraw even when the selectedIds Set
   * didn't change (watch is selectedIds-keyed and wouldn't trip). */
  if (w.selectedIds.size > 0) await execWidget(w);
}

// ─── Refresh ───────────────────────────────────────────────────────

async function refreshEverything() {
  /* 1. Bust BFF-side caches (attribution + server-time). These
   *    imperative calls return fresh data; vue-query state is
   *    refreshed in step 2. */
  await Promise.all([
    bff.inspect.catalog(true),
    bff.inspect.serverTime(true),
  ]);
  /* 2. Invalidate every vue-query under the `inspect` prefix —
   *    catalog / server-time all re-pull. */
  await queryClient.invalidateQueries({ queryKey: ['inspect'] });
  /* 3. Re-resolve entities AND re-fire MQE for every widget on the
   *    board, in parallel. We don't gate on `resolvedFetched` — a
   *    refresh that's interrupted mid-resolve should still get a
   *    second pass for that widget. */
  await Promise.all(
    widgets.value.map(async (w) => {
      await resolveEntitiesFor(w);
      if (w.selectedIds.size > 0) await execWidget(w);
    }),
  );
}

// ─── Display helpers ───────────────────────────────────────────────

function sourcePillTone(s: Source): 'ok' | 'warn' | 'err' | 'dim' {
  if (s === 'OAL') return 'ok';
  if (s.startsWith('MAL')) return 'warn';
  if (s === 'LAL→MAL') return 'warn';
  return 'dim';
}
function scopeShort(scope: InspectScope): string {
  switch (scope) {
    case 'ServiceInstance': return 'Instance';
    case 'ServiceRelation': return 'Svc→Svc';
    case 'ServiceInstanceRelation': return 'Instance→Instance';
    case 'EndpointRelation': return 'Endpoint→Endpoint';
    default: return scope;
  }
}
</script>

<template>
  <div class="ins">
    <AdminFeatureWarning module="inspect" feature-label="Inspect" />
    <header class="ins__header">
      <h1 class="ins__h1">{{ t('Inspect') }}</h1>
      <div class="ins__spacer" />
      <span v-if="catalogQuery.isFetching.value" class="ins__refreshing">{{ t('refreshing…') }}</span>
      <Btn @click="refreshEverything">{{ t('refresh') }}</Btn>
      <Btn
        :disabled="widgets.length === 0"
        :title="t('remove every widget on the board and clear the saved layout')"
        @click="onReset"
      >{{ t('reset') }}</Btn>
      <Btn kind="primary" :disabled="catalogQuery.isPending.value" @click="openDrawer">{{ t('+ add metric') }}</Btn>
    </header>

    <!-- INSPECT_NOT_ENABLED banner -->
    <div v-if="inspectNotEnabled" class="ins__banner ins__banner--err">
      <strong>{{ t('Inspect API not enabled on OAP.') }}</strong>
      <i18n-t keypath="Set {flag} on the admin-server, then click refresh." tag="span">
        <template #flag><code>SW_INSPECT=default</code></template>
      </i18n-t>
    </div>
    <div v-else-if="catalogQuery.isError.value" class="ins__banner ins__banner--err">
      <i18n-t keypath="Catalog load failed: {err}" tag="span" scope="global">
        <template #err>{{ describeApiError(catalogQuery.error.value) }}</template>
      </i18n-t>
      <Btn @click="catalogQuery.refetch()">{{ t('retry') }}</Btn>
    </div>

    <!-- Filters / time range / capacity -->
    <section class="ins__filters">
      <header class="ins__sectionhead">
        {{ t('range & capacity') }}
        <span class="ins__sectionhint" :title="serverTimeInfo?.error ?? ''">
          <i18n-t keypath="inputs are browser-local · sent to OAP in {tz}" tag="span" scope="global">
            <template #tz>{{
              serverTimeInfo
                ? (serverTimeInfo.source === 'oap'
                  ? t('server TZ ({tz})', { tz: signedMins(serverOffsetMinutes) })
                  : t('browser TZ (server unreachable)'))
                : t('resolving server TZ…')
            }}</template>
          </i18n-t>
          · <span :class="bucketOverflow ? 'ins__buckets--err' : 'ins__buckets'">{{ t('{n} buckets', { n: bucketCount }) }}</span>
          <span v-if="bucketOverflow" class="ins__buckets--err"> {{ t('· over OAP cap ({cap})', { cap: INSPECT_MAX_BUCKETS }) }}</span>
        </span>
      </header>
      <div class="ins__filters-body">
        <div class="ins__group">
          <span class="ins__lbl">{{ t('preset') }}</span>
          <div class="seg">
            <button
              v-for="p in PRESETS"
              :key="p.label"
              class="seg__btn"
              :class="{ 'seg__btn--on': activePreset === p.label }"
              @click="applyPreset(p)"
            >{{ presetLabel(p.label) }}</button>
          </div>
        </div>
        <div class="ins__group">
          <span class="ins__lbl">{{ t('range') }}</span>
          <input v-model="startStr" :class="{ 'ins__input--bad': !startValid }" class="ins__input ins__input--time" spellcheck="false" @change="onStartInput" @blur="onStartInput" />
          <span class="ins__sep">→</span>
          <input v-model="endStr" :class="{ 'ins__input--bad': !endValid }" class="ins__input ins__input--time" spellcheck="false" @change="onEndInput" @blur="onEndInput" />
          <select v-model="step" class="ins__select">
            <option v-for="s in INSPECT_STEPS" :key="s">{{ s }}</option>
          </select>
        </div>
        <div class="ins__group">
          <span class="ins__lbl">{{ t('board cap') }}</span>
          <input v-model.number="boardCap" type="number" min="1" max="40" class="ins__input ins__input--num" />
          <span class="ins__hint">{{ t('{n} / {cap} widgets', { n: widgets.length, cap: boardCap }) }}</span>
        </div>
        <div class="ins__group">
          <span class="ins__lbl">{{ t('inspector top-n') }}</span>
          <input v-model.number="inspectorTopN" type="number" min="1" max="300" class="ins__input ins__input--num" />
          <span class="ins__hint">{{ t('backend /inspect/entities cap is 300') }}</span>
        </div>
        <div class="ins__group">
          <span class="ins__lbl">{{ t('per row') }}</span>
          <div class="seg">
            <button
              v-for="d in DENSITY_OPTIONS"
              :key="d"
              class="seg__btn"
              :class="{ 'seg__btn--on': density === d }"
              @click="density = d"
            >{{ d }}</button>
          </div>
        </div>
      </div>
    </section>

    <!-- Board -->
    <section class="ins__board-section">
      <header class="ins__sectionhead">
        {{ t('board') }}
        <span class="ins__sectionhint">
          {{ t('5 per row · per-widget entity defaults to top-1 from /inspect/entities') }}
        </span>
      </header>

      <div v-if="widgets.length === 0" class="ins__empty">
        <i18n-t keypath="no metrics on the board — use {action} to open the catalog drawer." tag="span">
          <template #action><em>{{ t('+ add metric') }}</em></template>
        </i18n-t>
      </div>

      <div
        v-else
        class="board"
        :style="{
          gridTemplateColumns: `repeat(${density}, minmax(0, 1fr))`,
          '--chart-h': density === 1 ? '280px' : density === 3 ? '210px' : '150px',
        }"
      >
        <article v-for="w in widgets" :key="w.id" class="card">
          <header class="card__head">
            <div class="card__title" :title="w.metric.name">{{ w.metric.name }}</div>
            <div class="card__actions">
              <button class="iconbtn" :title="t('chart: {kind} (click to cycle)', { kind: w.chart })" @click="cycleChart(w)">{{ w.chart }}</button>
              <button class="iconbtn iconbtn--x" :title="t('remove from board')" @click="removeWidget(w.id)">×</button>
            </div>
            <div class="card__pills">
              <Pill :tone="sourcePillTone(w.metric.attribution.source as Source)">{{ w.metric.attribution.source }}</Pill>
              <Pill tone="ok" :title="t('entity type: {scope}', { scope: w.metric.scope })">{{ scopeShort(w.metric.scope) }}</Pill>
            </div>
          </header>

          <div class="card__entity">
            <button
              class="entity-nav"
              :title="t('previous entity')"
              :disabled="widgetAllEntities(w).length < 2"
              @click="stepEntity(w, -1)"
            >◀</button>
            <button class="entity" @click="openEditor(w.id)">
              <template v-if="singleSelected(w)">
                <span class="entity__decoded">{{ decodedLabel(singleSelected(w)!) }}</span>
                <span class="entity__idx">
                  {{ widgetAllEntities(w).findIndex((e) => e.entityId === singleSelected(w)!.entityId) + 1 }}
                  / {{ widgetAllEntities(w).length }}
                </span>
              </template>
              <template v-else-if="w.selectedIds.size > 1">
                <span class="entity__decoded">{{ t('{n} entities', { n: w.selectedIds.size }) }}</span>
                <span class="entity__idx">{{ t('multi · edit') }}</span>
              </template>
              <template v-else>
                <span class="entity__decoded entity__decoded--empty">{{ w.resolvedFetched ? t('no entity') : t('click to load') }}</span>
              </template>
            </button>
            <button
              class="entity-nav"
              :title="t('next entity')"
              :disabled="widgetAllEntities(w).length < 2"
              @click="stepEntity(w, 1)"
            >▶</button>
            <button
              class="entity-nav"
              :title="t('refresh entities + replot from this metric')"
              :disabled="w.loading"
              @click="rerunInspectFor(w)"
            >↻</button>
            <button class="link" :title="t('copy mqeEntity JSON')" @click="copyMqeEntity(w)">{{ t('copy') }}</button>

            <div v-if="editorForWidget === w.id" class="editor" @click.stop>
              <header class="editor__head">
                <i18n-t keypath="entities · {metric}" tag="span">
                  <template #metric><code>{{ w.metric.name }}</code></template>
                </i18n-t>
                <button class="link" @click="closeEditor">{{ t('close') }}</button>
              </header>

              <div class="editor__toolbar">
                <Btn @click="selectAll(w)">{{ t('all') }}</Btn>
                <Btn @click="selectNone(w)">{{ t('none') }}</Btn>
                <Btn @click="selectTop(w, 5)">{{ t('top {n}', { n: 5 }) }}</Btn>
                <Btn @click="selectTop(w, inspectorTopN)">{{ t('top {n}', { n: inspectorTopN }) }}</Btn>
                <Btn @click="rerunInspectFor(w)">{{ t('refetch') }}</Btn>
              </div>

              <div v-if="w.error" class="editor__err">{{ w.error }}</div>

              <div class="editor__sectionhead">{{ t('resolved · {n} from /inspect/entities', { n: w.resolvedEntities.length }) }}</div>
              <ul class="editor__list">
                <li v-for="e in w.resolvedEntities" :key="e.entityId">
                  <label class="editor__row">
                    <input type="checkbox" :checked="w.selectedIds.has(e.entityId)" @change="toggleEntity(w, e)" />
                    <span class="editor__decoded">{{ decodedLabel(e) }}</span>
                    <code class="editor__id">{{ e.entityId }}</code>
                  </label>
                </li>
                <li v-if="w.resolvedEntities.length === 0" class="editor__empty">
                  {{ t('/inspect/entities returned no rows in the selected range') }}
                </li>
              </ul>

              <div v-if="w.customEntities.length > 0" class="editor__sectionhead">{{ t('custom · {n} added by hand', { n: w.customEntities.length }) }}</div>
              <ul v-if="w.customEntities.length > 0" class="editor__list">
                <li v-for="e in w.customEntities" :key="e.entityId">
                  <label class="editor__row">
                    <input type="checkbox" :checked="w.selectedIds.has(e.entityId)" @change="toggleEntity(w, e)" />
                    <span class="editor__decoded">{{ decodedLabel(e) }}</span>
                    <button class="link editor__remove" @click.prevent="removeCustom(w, e)">{{ t('remove') }}</button>
                  </label>
                </li>
              </ul>

              <div class="editor__sectionhead">{{ t('add · custom entity') }}</div>
              <div class="editor__form">
                <div class="editor__formrow">
                  <span class="editor__formlabel">{{ t('scope') }}</span>
                  <Pill tone="dim">{{ w.metric.scope }}</Pill>
                  <i18n-t keypath="fixed by /inspect/metrics for {metric}" tag="span" class="editor__formhint">
                    <template #metric><code>{{ w.metric.name }}</code></template>
                  </i18n-t>
                </div>

                <template v-for="k in fieldsFor(w.metric.scope).primary" :key="`p-${k}`">
                  <div class="editor__formrow">
                    <span class="editor__formlabel">{{ k }}</span>
                    <input v-model="editorForm[k]" class="ins__input editor__input" :placeholder="PLACEHOLDERS[k]" spellcheck="false" />
                  </div>
                </template>

                <div class="editor__formrow">
                  <span class="editor__formlabel">{{ t('normal') }}</span>
                  <label class="editor__check">
                    <input v-model="editorForm.normal" type="checkbox" />
                    <span>{{ t('real · agent-instrumented (uncheck for virtual entities)') }}</span>
                  </label>
                </div>

                <template v-if="fieldsFor(w.metric.scope).dest.length > 0">
                  <div class="editor__formdivider">{{ t('→ destination') }}</div>
                  <template v-for="k in fieldsFor(w.metric.scope).dest" :key="`d-${k}`">
                    <div class="editor__formrow">
                      <span class="editor__formlabel">{{ k }}</span>
                      <input v-model="editorForm[k]" class="ins__input editor__input" :placeholder="PLACEHOLDERS[k]" spellcheck="false" />
                    </div>
                  </template>
                  <div class="editor__formrow">
                    <span class="editor__formlabel">destNormal</span>
                    <label class="editor__check">
                      <input v-model="editorForm.destNormal" type="checkbox" />
                      <span>{{ t('real · agent-instrumented') }}</span>
                    </label>
                  </div>
                </template>
              </div>
              <div v-if="editorErr" class="editor__err">{{ editorErr }}</div>
              <div class="editor__footer">
                <span class="editor__hint">{{ t('use for entities /inspect/entities did not surface.') }}</span>
                <Btn kind="primary" @click="addCustomEntity(w)">{{ t('add entity') }}</Btn>
              </div>
            </div>
          </div>

          <div class="card__chartwrap">
            <div v-if="w.loading" class="card__empty">
              <div class="card__empty-text">{{ t('loading…') }}</div>
            </div>
            <div v-else-if="w.error" class="card__empty card__empty--err">
              <div class="card__empty-text">{{ w.error }}</div>
            </div>
            <InspectMetricChart
              v-else-if="w.selectedIds.size > 0 && w.result && w.result.results.length > 0"
              :result="w.result"
              :chart="w.chart"
              :step="step"
              :metric-name="w.metric.name"
            />
            <div v-else class="card__empty">
              <div class="card__empty-icon">∅</div>
              <div class="card__empty-text">
                <template v-if="!w.resolvedFetched">{{ t('resolving entities…') }}</template>
                <template v-else-if="widgetAllEntities(w).length === 0">
                  <i18n-t keypath="no entity for {metric} in this range" tag="span">
                    <template #metric><code>{{ w.metric.name }}</code></template>
                  </i18n-t>
                  <div class="card__empty-sub">{{ t('try a wider range or a coarser step (current: {step})', { step }) }}</div>
                </template>
                <template v-else-if="w.selectedIds.size === 0">{{ t('pick an entity') }}</template>
                <template v-else>{{ t('no values in range') }}</template>
              </div>
            </div>
          </div>
        </article>
      </div>
    </section>

    <!-- Catalog drawer -->
    <transition name="drawer">
      <aside v-if="drawerOpen" class="drawer" @click.self="drawerOpen = false">
        <div class="drawer__panel">
          <header class="drawer__head">
            <div>
              <div class="drawer__kicker">{{ t('catalog · /inspect/metrics') }}</div>
              <h2 class="drawer__title">{{ t('Add metrics to the board') }}</h2>
            </div>
            <button class="iconbtn iconbtn--x" @click="drawerOpen = false">×</button>
          </header>

          <div class="drawer__sources">
            <span class="ins__lbl">{{ t('source') }}</span>
            <button
              v-for="s in (['OAL','MAL·OTEL','MAL·Telegraf','LAL→MAL','unknown'] as Source[])"
              :key="s"
              class="chip"
              :class="{ 'chip--on': drawerSourceFilter.has(s) }"
              @click="toggleDrawerSource(s)"
            >{{ s }}</button>
          </div>

          <div class="drawer__search">
            <input v-model="drawerQuery" :placeholder="t('regex over metric name')" class="ins__input" spellcheck="false" />
            <span class="drawer__count">{{ t('{n} of {total} match', { n: drawerMetrics.length, total: activeFileNode?.metricCount ?? 0 }) }}</span>
          </div>

          <div class="drawer__panes">
            <nav class="drawer__tree">
              <template v-for="src in (['OAL','MAL·OTEL','MAL·Telegraf','LAL→MAL','unknown'] as Source[])" :key="src">
                <div v-if="drawerGroupedFiles[src].length > 0" class="drawer__treeGroup">
                  <div class="drawer__treeKicker">{{ src }}</div>
                  <div
                    v-for="f in drawerGroupedFiles[src]"
                    :key="`${f.source}::${f.file}`"
                    class="drawer__file"
                    :class="{ 'drawer__file--on': drawerActiveFile === `${f.source}::${f.file}` }"
                  >
                    <button class="drawer__fileBtn" @click="selectFile(f)">
                      <span class="drawer__fileName" :title="f.file">{{ f.file }}</span>
                      <span class="drawer__fileMeta">
                        <span class="drawer__fileCount">{{ f.metricCount }}</span>
                      </span>
                    </button>
                    <button
                      class="drawer__fileAdd"
                      :title="t('select all {n} metrics in this file', { n: f.metricCount })"
                      @click.stop="selectAllInFile(f)"
                    >{{ t('+ all') }}</button>
                  </div>
                </div>
              </template>
            </nav>

            <div class="drawer__metrics">
              <header v-if="activeFileNode" class="drawer__breadcrumb">
                <span class="dim">{{ activeFileNode.source }} ·</span>
                <code>{{ activeFileNode.file }}</code>
                <template v-if="activeFileNode.scopes.length > 1">
                  <span class="dim"> {{ t('· narrow:') }}</span>
                  <button
                    class="chip chip--sm"
                    :class="{ 'chip--on': drawerScopeNarrow === null }"
                    @click="drawerScopeNarrow = null"
                  >{{ t('all') }}</button>
                  <button
                    v-for="sc in activeFileNode.scopes"
                    :key="sc"
                    class="chip chip--sm"
                    :class="{ 'chip--on': drawerScopeNarrow === sc }"
                    @click="drawerScopeNarrow = sc"
                  >{{ scopeShort(sc) }}</button>
                </template>
                <span class="drawer__bcSpacer" />
                <button class="link" :disabled="drawerMetrics.length === 0" @click="selectAllVisible">
                  {{ t('select all {n}', { n: drawerMetrics.length }) }}
                </button>
                <button class="link" @click="clearVisible">{{ t('clear') }}</button>
              </header>

              <ul class="drawer__list">
                <li
                  v-for="m in drawerMetrics"
                  :key="m.name"
                  class="drawer__row"
                  :class="{
                    'drawer__row--off': !isMqeQueryable(m.type),
                    'drawer__row--on': drawerSelection.has(m.name),
                  }"
                  @click="toggleDrawerPick(m.name, isMqeQueryable(m.type))"
                >
                  <input
                    type="checkbox"
                    :checked="drawerSelection.has(m.name)"
                    :disabled="!isMqeQueryable(m.type)"
                    @click.stop="toggleDrawerPick(m.name, isMqeQueryable(m.type))"
                  />
                  <span class="drawer__name">{{ m.name }}</span>
                  <Pill tone="dim">{{ m.type }}</Pill>
                  <Pill tone="ok">{{ scopeShort(m.scope) }}</Pill>
                  <span v-if="!isMqeQueryable(m.type)" class="drawer__why">
                    {{ t('not MQE-queryable · /inspect/entities accepts REGULAR_VALUE + LABELED_VALUE') }}
                  </span>
                </li>
                <li v-if="drawerMetrics.length === 0" class="drawer__listEmpty">
                  {{ t('no metric matches the current filters') }}
                </li>
              </ul>
            </div>
          </div>

          <footer class="drawer__foot">
            <span class="drawer__count">
              {{ t('{n} selected · {after} / {cap} after add', { n: drawerSelection.size, after: widgets.length + drawerSelection.size, cap: boardCap }) }}
            </span>
            <div class="drawer__foot-btns">
              <Btn @click="drawerOpen = false">{{ t('Cancel') }}</Btn>
              <Btn
                kind="primary"
                :disabled="drawerSelection.size === 0 || widgets.length >= boardCap"
                @click="commitDrawer"
              >
                {{ t('Add {n} to board', { n: Math.min(drawerSelection.size, Math.max(0, boardCap - widgets.length)) }) }}
              </Btn>
            </div>
          </footer>
        </div>
      </aside>
    </transition>
  </div>
</template>

<style scoped>
.ins {
  padding: 18px 24px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-width: 1600px;
}

.ins__header { display: flex; align-items: center; gap: 12px; }
.ins__h1 { margin: 0; font-family: var(--rr-font-ui); font-weight: var(--sw-fw-medium); font-size: var(--sw-fs-lg); color: var(--rr-heading); }
.ins__spacer { flex: 1 1 auto; }
.ins__refreshing {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-base);
  color: var(--rr-dim);
}

.ins__banner {
  padding: 10px 14px;
  border-radius: var(--rr-radius-sm);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  display: flex;
  align-items: center;
  gap: 12px;
}
.ins__banner--err {
  background: color-mix(in oklab, var(--rr-err) 14%, var(--rr-bg2));
  border: 1px solid var(--rr-err);
  color: var(--rr-ink);
}
.ins__banner code { color: var(--rr-heading); }

.ins__sectionhead {
  display: flex;
  align-items: center;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
  border-bottom: 1px solid var(--rr-border);
  padding-bottom: 4px;
  margin-bottom: 8px;
}
.ins__sectionhint {
  margin-left: 8px;
  font-family: var(--rr-font-ui);
  font-weight: var(--sw-fw-regular);
  font-size: var(--sw-fs-sm);
  color: var(--rr-dim);
  text-transform: none;
  letter-spacing: 0;
}

.ins__filters, .ins__board-section { display: flex; flex-direction: column; gap: 6px; }
.ins__filters-body {
  display: flex;
  flex-wrap: wrap;
  gap: 14px 28px;
  align-items: center;
  padding: 10px 12px;
  background: var(--rr-bg2);
  border: 1px solid var(--rr-border);
  border-radius: var(--rr-radius-sm);
}
.ins__group { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; }
.ins__lbl {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
}
.ins__hint { font-family: var(--rr-font-mono); font-size: var(--sw-fs-sm); color: var(--rr-dim); }
.ins__buckets { font-family: var(--rr-font-mono); color: var(--rr-ink2); }
.ins__buckets--err { font-family: var(--rr-font-mono); color: var(--rr-err); font-weight: var(--sw-fw-semibold); }
.ins__input {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  padding: 4px 8px;
  background: var(--rr-bg);
  color: var(--rr-ink);
  border: 1px solid var(--rr-border);
  border-radius: var(--rr-radius-sm);
  min-width: 220px;
}
.ins__input:focus { outline: none; border-color: var(--rr-border2); }
.ins__input--time { min-width: 150px; }
.ins__input--num { min-width: 70px; max-width: 90px; }
.ins__input--bad { border-color: var(--rr-err); }
.ins__select {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  padding: 4px 8px;
  background: var(--rr-bg);
  color: var(--rr-ink);
  border: 1px solid var(--rr-border);
  border-radius: var(--rr-radius-sm);
}
.ins__sep { color: var(--rr-dim); font-family: var(--rr-font-mono); }

.chip {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  padding: 3px 9px;
  background: transparent;
  color: var(--rr-ink2);
  border: 1px solid var(--rr-border);
  border-radius: 999px;
  cursor: pointer;
}
.chip--sm { padding: 2px 8px; font-size: var(--sw-fs-sm); }
.chip:hover { color: var(--rr-heading); border-color: var(--rr-border2); }
.chip--on { background: color-mix(in oklab, var(--rr-accent) 18%, transparent); border-color: var(--rr-accent); color: var(--rr-heading); }

.seg {
  display: inline-flex;
  border: 1px solid var(--rr-border);
  border-radius: var(--rr-radius-sm);
  overflow: hidden;
}
.seg__btn {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  padding: 4px 12px;
  background: var(--rr-bg);
  color: var(--rr-ink2);
  border: 0;
  border-right: 1px solid var(--rr-border);
  cursor: pointer;
}
.seg__btn:last-child { border-right: 0; }
.seg__btn:hover { color: var(--rr-heading); }
.seg__btn--on {
  background: color-mix(in oklab, var(--rr-accent) 22%, transparent);
  color: var(--rr-heading);
}


.ins__empty {
  padding: 24px;
  text-align: center;
  background: var(--rr-bg2);
  border: 1px dashed var(--rr-border);
  border-radius: var(--rr-radius-sm);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-dim);
}
.ins__empty em { font-style: normal; color: var(--rr-ink2); }

.board {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
}

.card {
  background: var(--rr-bg2);
  border: 1px solid var(--rr-border);
  border-radius: var(--rr-radius-sm);
  padding: 8px 10px;
  display: grid;
  grid-template-columns: 1fr;
  grid-template-rows: auto auto 1fr;
  row-gap: 6px;
  position: relative;
  min-width: 0;
  /* `visible`, not `hidden`: the entity editor popout is absolutely
   * positioned at `top:100%` and must escape the card to overlay
   * neighbours below. The card's own children (title, pills, chart)
   * each clip themselves, so the card doesn't need to. */
  overflow: visible;
}
.card__head {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-areas:
    'title  actions'
    'pills  pills';
  column-gap: 6px;
  row-gap: 3px;
  align-items: start;
}
.card__title {
  grid-area: title;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-base);
  color: var(--rr-heading);
  font-weight: var(--sw-fw-semibold);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.3;
  min-height: 16px;
}
.card__actions { grid-area: actions; display: flex; gap: 4px; }
.card__pills {
  grid-area: pills;
  display: flex;
  flex-wrap: nowrap;
  gap: 3px;
  overflow: hidden;
  min-height: 18px;
}
.iconbtn {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  padding: 1px 6px;
  background: transparent;
  color: var(--rr-ink2);
  border: 1px solid var(--rr-border);
  border-radius: var(--rr-radius-sm);
  cursor: pointer;
  text-transform: lowercase;
  line-height: 1.5;
}
.iconbtn:hover { color: var(--rr-heading); border-color: var(--rr-border2); }
.iconbtn--x { font-size: var(--sw-fs-sm); line-height: 1; padding: 0 6px; }

.card__entity {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: nowrap;
  min-height: 22px;
  min-width: 0;
}
.entity {
  flex: 1 1 0%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-md);
  padding: 4px 9px;
  background: var(--rr-bg);
  color: var(--rr-ink);
  border: 1px solid var(--rr-border);
  border-radius: var(--rr-radius-sm);
  cursor: pointer;
  text-align: left;
  min-width: 0;
  overflow: hidden;
}
.entity:hover { border-color: var(--rr-accent); color: var(--rr-heading); }
.entity__decoded {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  letter-spacing: 0.01em;
}
.entity__decoded--empty { color: var(--rr-dim); font-style: italic; }
.entity__idx { font-size: var(--sw-fs-sm); color: var(--rr-dim); flex-shrink: 0; }
/* Clickable = bright + accent border (high-emphasis affordance);
 * disabled = dim/gray with a faint border. The earlier styling read
 * inverted — muted ink for live arrows, which looked like the
 * disabled state. */
.entity-nav {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-base);
  padding: 3px 8px;
  background: transparent;
  color: var(--rr-heading);
  border: 1px solid var(--rr-border2);
  border-radius: var(--rr-radius-sm);
  cursor: pointer;
  line-height: 1.4;
}
.entity-nav:hover:not(:disabled) {
  color: var(--rr-accent);
  border-color: var(--rr-accent);
}
.entity-nav:disabled {
  color: var(--rr-dim);
  border-color: var(--rr-border);
  opacity: 0.5;
  cursor: not-allowed;
}
.link {
  background: transparent;
  border: 0;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-accent);
  cursor: pointer;
  padding: 0;
}
.link:hover { text-decoration: underline; }

.card__chartwrap { min-height: var(--chart-h, 150px); position: relative; }
.card__empty {
  height: var(--chart-h, 150px);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--rr-dim);
  border: 1px dashed var(--rr-border);
  border-radius: var(--rr-radius-sm);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  text-align: center;
  padding: 8px;
}
.card__empty--err { color: var(--rr-err); border-color: var(--rr-err); }
.card__empty-icon { font-size: var(--sw-fs-xl); color: var(--rr-border2); }
.card__empty-sub { margin-top: 4px; color: var(--rr-dim); font-size: var(--sw-fs-xs); }
.card__empty code { color: var(--rr-ink); }

.editor {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  margin-top: 6px;
  background: var(--rr-panel);
  border: 1px solid var(--rr-border2);
  border-radius: var(--rr-radius-sm);
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.5);
  z-index: 10;
}
.editor__head {
  padding: 7px 10px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-ink2);
  border-bottom: 1px solid var(--rr-border);
}
.editor__toolbar { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--rr-border); }
.editor__sectionhead {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
  padding: 8px 10px 2px;
}
.editor__list { list-style: none; padding: 0; margin: 0; max-height: 180px; overflow-y: auto; }
.editor__row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  cursor: pointer;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-ink);
}
.editor__row:hover { background: var(--rr-bg2); color: var(--rr-heading); }
.editor__decoded {
  flex: 1;
  color: var(--rr-heading);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.editor__id { color: var(--rr-dim); font-size: var(--sw-fs-xs); }
.editor__remove { margin-left: auto; }
.editor__empty { padding: 8px 10px; font-size: var(--sw-fs-sm); color: var(--rr-dim); text-align: center; }
.editor__form { display: flex; flex-direction: column; gap: 6px; padding: 4px 10px 4px; }
.editor__formrow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.editor__formlabel { font-family: var(--rr-font-mono); font-size: var(--sw-fs-sm); color: var(--rr-dim); min-width: 132px; }
.editor__input { flex: 1; min-width: 160px; font-size: var(--sw-fs-sm); padding: 3px 7px; }
.editor__formhint { font-family: var(--rr-font-mono); font-size: var(--sw-fs-xs); color: var(--rr-dim); }
.editor__formdivider {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
  padding-top: 4px;
  border-top: 1px dashed var(--rr-border);
  margin-top: 2px;
}
.editor__check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-ink2);
  cursor: pointer;
}
.editor__err {
  margin: 4px 10px;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-err);
}
.editor__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px 10px;
  gap: 10px;
  flex-wrap: wrap;
}
.editor__hint { font-family: var(--rr-font-mono); font-size: var(--sw-fs-sm); color: var(--rr-dim); flex: 1; min-width: 200px; }

/* Drawer */
.drawer {
  position: fixed;
  inset: 0;
  background: rgba(8, 12, 16, 0.6);
  z-index: 50;
  display: flex;
  justify-content: flex-end;
}
.drawer__panel {
  width: 880px;
  max-width: 95vw;
  height: 100%;
  background: var(--rr-bg);
  border-left: 1px solid var(--rr-border);
  display: flex;
  flex-direction: column;
}
.drawer__head {
  padding: 14px 18px;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  border-bottom: 1px solid var(--rr-border);
}
.drawer__kicker {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
}
.drawer__title {
  margin: 4px 0 0;
  font-family: var(--rr-font-ui);
  font-weight: var(--sw-fw-medium);
  font-size: var(--sw-fs-md);
  color: var(--rr-heading);
}
.drawer__sources { padding: 10px 18px 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.drawer__search { padding: 10px 18px; display: flex; gap: 12px; align-items: center; }
.drawer__search .ins__input { flex: 1; }
.drawer__count { font-family: var(--rr-font-mono); font-size: var(--sw-fs-base); color: var(--rr-dim); }
.drawer__panes {
  display: grid;
  grid-template-columns: 280px 1fr;
  flex: 1;
  min-height: 0;
  border-top: 1px solid var(--rr-border);
}
.drawer__tree { overflow-y: auto; border-right: 1px solid var(--rr-border); padding: 6px 0; }
.drawer__treeGroup { padding: 6px 0 10px; }
.drawer__treeKicker {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
  padding: 4px 14px;
}
.drawer__file { display: flex; align-items: stretch; border-left: 2px solid transparent; }
.drawer__file:hover { background: var(--rr-bg2); }
.drawer__file--on { background: var(--rr-bg2); border-left-color: var(--rr-accent); }
.drawer__file--on .drawer__fileBtn { color: var(--rr-heading); }
.drawer__fileBtn {
  flex: 1;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 6px 12px;
  background: transparent;
  border: 0;
  cursor: pointer;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-base);
  color: var(--rr-ink2);
  text-align: left;
  min-width: 0;
}
.drawer__fileBtn:hover { color: var(--rr-heading); }
.drawer__fileName { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.drawer__fileMeta { display: flex; align-items: center; gap: 6px; }
.drawer__fileCount { font-size: var(--sw-fs-sm); color: var(--rr-dim); min-width: 18px; text-align: right; }
.drawer__fileAdd {
  background: transparent;
  border: 0;
  padding: 0 12px 0 4px;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  color: var(--rr-dim);
  cursor: pointer;
  flex-shrink: 0;
}
.drawer__fileAdd:hover { color: var(--rr-accent); }

.drawer__metrics { display: flex; flex-direction: column; min-height: 0; }
.drawer__breadcrumb {
  padding: 8px 14px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-base);
  color: var(--rr-ink2);
  border-bottom: 1px solid var(--rr-border);
}
.drawer__breadcrumb code { color: var(--rr-heading); }
.dim { color: var(--rr-dim); }
.drawer__bcSpacer { flex: 1 1 auto; }

.drawer__list { list-style: none; padding: 0; margin: 0; flex: 1; overflow-y: auto; }
/* The global Pill primitive renders at 13.5 px — fine for cluster-status
 * tables but feels chunky in the dense drawer / file-tree rows. Shrink
 * pills appearing inside the drawer panes to match the local font
 * scale (~11.5 px), no effect on Pills elsewhere in the app. */
.drawer__list :deep(.pill),
.drawer__tree :deep(.pill) {
  font-size: var(--sw-fs-sm);
  padding: 1px 6px;
  letter-spacing: 0.3px;
}
.drawer__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--rr-bg2);
  cursor: pointer;
}
.drawer__row:hover { background: var(--rr-bg2); }
.drawer__row--on { background: color-mix(in oklab, var(--rr-accent) 12%, transparent); }
.drawer__row--off { cursor: not-allowed; opacity: 0.55; }
.drawer__name { font-family: var(--rr-font-mono); font-size: var(--sw-fs-sm); color: var(--rr-heading); flex: 1; min-width: 200px; }
.drawer__why { flex-basis: 100%; padding-left: 26px; font-family: var(--rr-font-mono); font-size: var(--sw-fs-sm); color: var(--rr-dim); }
.drawer__listEmpty { padding: 20px; text-align: center; font-family: var(--rr-font-mono); font-size: var(--sw-fs-base); color: var(--rr-dim); }
.drawer__foot {
  padding: 12px 18px;
  border-top: 1px solid var(--rr-border);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.drawer__foot-btns { display: flex; gap: 8px; }

.drawer-enter-from .drawer__panel, .drawer-leave-to .drawer__panel { transform: translateX(100%); }
.drawer-enter-active .drawer__panel, .drawer-leave-active .drawer__panel { transition: transform 180ms ease; }
.drawer-enter-from, .drawer-leave-to { background: rgba(8, 12, 16, 0); }
.drawer-enter-active, .drawer-leave-active { transition: background 180ms ease; }
</style>
