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
  Admin / Layer dashboards. List every loaded layer template, pick one
  on the left, edit its per-scope widget set on the right. Saves write
  the JSON file back via POST /api/admin/layer-templates/:key so the
  BFF refreshes its in-memory cache.

  Widget editor presents the new span-based fields (12-col flow
  layout): operator picks a column span, optional row span, MQE
  expressions, type, title, unit, and an optional visibility predicate.
  Legacy x/y/w/h are NOT shown — they're kept on the wire for
  back-compat with older JSONs but operators don't edit them.
-->
<script setup lang="ts">
import { computed, reactive, ref, onMounted, watch } from 'vue';
import type { AdminLayerTemplate } from '@/api/client';
import type { DashboardScope, DashboardWidget } from '@skywalking-horizon-ui/api-client';
import { bffClient } from '@/api/client';

const SCOPES: DashboardScope[] = ['service', 'instance', 'endpoint', 'trace', 'profiling'];

const templates = ref<AdminLayerTemplate[]>([]);
const isLoading = ref(true);
const error = ref<string | null>(null);
const selectedKey = ref<string>('');
const activeScope = ref<DashboardScope>('service');
const isSaving = ref(false);
const saveMsg = ref<string | null>(null);

/** Working copy — reactively edited. Diffs against `templates` to drive
 *  the Save / Reset state. */
const draft = reactive<{ template: AdminLayerTemplate | null }>({ template: null });

async function loadAll(): Promise<void> {
  isLoading.value = true;
  error.value = null;
  try {
    const res = await bffClient.adminLayerTemplates();
    templates.value = res.templates;
    if (res.templates.length > 0 && !selectedKey.value) {
      selectedKey.value = res.templates[0].key;
    }
    syncDraft();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    isLoading.value = false;
  }
}

function syncDraft(): void {
  const tpl = templates.value.find((t) => t.key === selectedKey.value);
  draft.template = tpl ? JSON.parse(JSON.stringify(tpl)) : null;
  saveMsg.value = null;
}

watch(selectedKey, syncDraft);
onMounted(loadAll);

const dirty = computed(() => {
  const original = templates.value.find((t) => t.key === selectedKey.value);
  if (!original || !draft.template) return false;
  return JSON.stringify(original) !== JSON.stringify(draft.template);
});

function widgetsFor(scope: DashboardScope): DashboardWidget[] {
  const tpl = draft.template;
  if (!tpl) return [];
  // Read from `dashboards.<scope>`, falling back to legacy `widgets`
  // for the service scope so the existing JSONs keep their content
  // until we explicitly migrate them.
  const d = (tpl as unknown as { dashboards?: Record<string, DashboardWidget[]> }).dashboards;
  if (d?.[scope]) return d[scope];
  if (scope === 'service' && tpl.widgets) return tpl.widgets;
  return [];
}

function setWidgetsFor(scope: DashboardScope, widgets: DashboardWidget[]): void {
  const tpl = draft.template;
  if (!tpl) return;
  const dashboards =
    (tpl as unknown as { dashboards?: Record<string, DashboardWidget[]> }).dashboards ?? {};
  dashboards[scope] = widgets;
  (tpl as unknown as { dashboards?: Record<string, DashboardWidget[]> }).dashboards = dashboards;
  // Drop the legacy `widgets` once we've split — keeps the JSON clean.
  if (scope === 'service' && tpl.widgets) {
    (tpl as unknown as { widgets?: DashboardWidget[] }).widgets = undefined;
  }
}

function addWidget(): void {
  const widgets = [...widgetsFor(activeScope.value)];
  const idx = widgets.length;
  widgets.push({
    id: `widget_${idx + 1}`,
    title: `Widget ${idx + 1}`,
    type: 'card',
    expressions: [''],
    span: 4,
    rowSpan: 1,
  });
  setWidgetsFor(activeScope.value, widgets);
}

function deleteWidget(i: number): void {
  const widgets = [...widgetsFor(activeScope.value)];
  widgets.splice(i, 1);
  setWidgetsFor(activeScope.value, widgets);
}

function moveWidget(i: number, dir: -1 | 1): void {
  const widgets = [...widgetsFor(activeScope.value)];
  const j = i + dir;
  if (j < 0 || j >= widgets.length) return;
  [widgets[i], widgets[j]] = [widgets[j], widgets[i]];
  setWidgetsFor(activeScope.value, widgets);
}

function expressionsToText(arr: string[]): string {
  return arr.join('\n');
}
function textToExpressions(s: string): string[] {
  return s
    .split('\n')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

async function save(): Promise<void> {
  if (!draft.template || isSaving.value) return;
  isSaving.value = true;
  saveMsg.value = null;
  try {
    const res = await bffClient.saveLayerTemplate(draft.template);
    // Splice the returned template back into the list so subsequent
    // dirty diffs are against the persisted state.
    const idx = templates.value.findIndex((t) => t.key === selectedKey.value);
    if (idx >= 0 && res.template) templates.value[idx] = res.template;
    syncDraft();
    saveMsg.value = 'Saved.';
    setTimeout(() => (saveMsg.value = null), 2400);
  } catch (err) {
    saveMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    isSaving.value = false;
  }
}

function reset(): void {
  syncDraft();
}

const selectedTpl = computed(() => draft.template);
const currentWidgets = computed(() => widgetsFor(activeScope.value));

/**
 * Metrics-block editor. The metrics block lives directly on the
 * draft template; mutations flow through Vue's reactive proxy so the
 * dirty diff picks them up and Save enables. We ensure the
 * `metrics.columns` array exists before binding so the template can
 * safely v-model into it.
 */
function ensureMetrics(): NonNullable<AdminLayerTemplate['metrics']> {
  if (!draft.template) throw new Error('no template selected');
  if (!draft.template.metrics) {
    (draft.template as AdminLayerTemplate).metrics = {};
  }
  return draft.template.metrics as NonNullable<AdminLayerTemplate['metrics']>;
}
const metricsModel = computed(() => {
  if (!draft.template) return null;
  // Touch ensureMetrics on read so the keys are present for v-model.
  ensureMetrics();
  return draft.template.metrics as NonNullable<AdminLayerTemplate['metrics']>;
});
const metricsColumns = computed(() => {
  if (!draft.template) return [];
  const m = ensureMetrics();
  if (!m.columns) m.columns = [];
  return m.columns;
});
function addMetricColumn(): void {
  if (!draft.template) return;
  const m = ensureMetrics();
  if (!m.columns) m.columns = [];
  m.columns.push({
    metric: `metric_${m.columns.length + 1}`,
    label: `Metric ${m.columns.length + 1}`,
    aggregation: 'avg',
  });
}
function deleteMetricColumn(i: number): void {
  if (!draft.template?.metrics?.columns) return;
  draft.template.metrics.columns.splice(i, 1);
}

/**
 * Component toggles surfaced in the admin editor. Each entry binds to
 * a key on the template's `components` block; flipping the toggle
 * shows / hides the matching sidebar entry + per-layer route.
 */
type ComponentKey = keyof AdminLayerTemplate['components'];
const COMPONENT_TOGGLES: Array<{ key: ComponentKey; label: string; hint: string }> = [
  { key: 'service', label: 'Service', hint: "The layer's primary landing — widget grid driven by dashboards.service." },
  { key: 'instances', label: 'Instances', hint: 'Per-instance dashboard (dashboards.instance widget set).' },
  { key: 'endpoints', label: 'Endpoints', hint: 'Per-endpoint dashboard (dashboards.endpoint widget set).' },
  { key: 'endpointDependency', label: 'API dependency', hint: 'Endpoint-to-endpoint dependency view (Phase 4).' },
  { key: 'topology', label: 'Topology', hint: 'Service topology graph for this layer (Phase 4).' },
  { key: 'traces', label: 'Traces', hint: 'Trace explorer scoped to this layer (Phase 5).' },
  { key: 'logs', label: 'Logs', hint: 'Log explorer scoped to this layer (Phase 5).' },
  { key: 'profiling', label: 'Profiling', hint: 'Flame graphs / sampled stacks (Phase 8).' },
];

function ensureComponents(): AdminLayerTemplate['components'] {
  if (!draft.template) throw new Error('no template selected');
  if (!draft.template.components) {
    (draft.template as AdminLayerTemplate).components = {};
  }
  return draft.template.components;
}
function toggleComponent(key: ComponentKey): void {
  const c = ensureComponents();
  c[key] = !c[key];
}
</script>

<template>
  <div class="admin-page">
    <header class="page-head">
      <div>
        <div class="kicker">Admin</div>
        <h1>Layer dashboards</h1>
        <p class="lede">
          Each layer ships with a JSON template (alias, components, metric columns, widgets).
          Pick a layer on the left, switch scopes (service / instance / endpoint / trace /
          profiling), edit widgets in place, and save back to the JSON.
        </p>
      </div>
    </header>

    <div v-if="error" class="banner err">{{ error }}</div>
    <div v-if="isLoading" class="empty">Loading templates…</div>
    <div v-else-if="templates.length === 0" class="empty">No layer templates loaded.</div>

    <div v-else class="grid">
      <aside class="sw-card layer-list">
        <div class="list-head">
          <h4>Layers</h4>
          <span class="sub">{{ templates.length }} template{{ templates.length === 1 ? '' : 's' }}</span>
        </div>
        <button
          v-for="t in templates"
          :key="t.key"
          class="layer-row"
          :class="{ active: selectedKey === t.key }"
          @click="selectedKey = t.key"
        >
          <span class="dot" :style="{ background: t.color || 'var(--sw-fg-3)' }" />
          <span class="name">{{ t.alias || t.key }}</span>
        </button>
      </aside>

      <main v-if="selectedTpl" class="detail">
        <!-- Identity strip + save controls -->
        <section class="sw-card identity-card">
          <div class="identity-row">
            <span class="dot inline" :style="{ background: selectedTpl.color || 'var(--sw-fg-3)' }" />
            <div>
              <h2>{{ selectedTpl.alias || selectedTpl.key }}</h2>
              <div class="meta">
                <code>{{ selectedTpl.key }}</code>
              </div>
            </div>
            <div class="actions">
              <span v-if="saveMsg" class="save-msg">{{ saveMsg }}</span>
              <button
                class="sw-btn"
                type="button"
                :disabled="!dirty || isSaving"
                @click="reset"
              >
                Reset
              </button>
              <button
                class="sw-btn is-primary"
                type="button"
                :disabled="!dirty || isSaving"
                @click="save"
              >
                {{ isSaving ? 'Saving…' : 'Save' }}
              </button>
            </div>
          </div>
        </section>

        <!-- Components editor: which per-layer views exist. Each
             toggle controls a sidebar entry + a route + (where the
             component is service / instance / endpoint) the matching
             dashboards.<scope> widget set. -->
        <section class="sw-card components-card">
          <div class="card-head">
            <h4>Components</h4>
            <span class="sub">which sub-views this layer exposes</span>
          </div>
          <div class="comp-grid">
            <label
              v-for="t in COMPONENT_TOGGLES"
              :key="t.key"
              class="comp-toggle"
              :class="{ on: !!selectedTpl.components?.[t.key] }"
              :title="t.hint"
            >
              <input
                type="checkbox"
                :checked="!!selectedTpl.components?.[t.key]"
                @change="toggleComponent(t.key)"
              />
              <span class="comp-label">{{ t.label }}</span>
            </label>
          </div>
        </section>

        <!-- Metrics editor (the layer's summary KPI columns + the
             orderBy / throughput / spark selectors). These drive the
             Overview KPI tile and the per-layer header summary. -->
        <section class="sw-card metrics-card">
          <div class="card-head">
            <h4>Summary metrics</h4>
            <span class="sub">columns shown on the Overview KPI tile + per-layer header</span>
            <button class="sw-btn add" type="button" @click="addMetricColumn">＋ Add column</button>
          </div>
          <div v-if="metricsModel" class="metrics-keys">
            <label>
              <span>orderBy</span>
              <select v-model="metricsModel.orderBy">
                <option :value="undefined">(first column)</option>
                <option v-for="c in metricsColumns" :key="c.metric" :value="c.metric">{{ c.metric }}</option>
              </select>
            </label>
            <label>
              <span>throughput</span>
              <select v-model="metricsModel.throughput">
                <option :value="undefined">(orderBy)</option>
                <option v-for="c in metricsColumns" :key="c.metric" :value="c.metric">{{ c.metric }}</option>
              </select>
            </label>
            <label>
              <span>spark</span>
              <select v-model="metricsModel.spark">
                <option :value="undefined">(throughput)</option>
                <option v-for="c in metricsColumns" :key="c.metric" :value="c.metric">{{ c.metric }}</option>
              </select>
            </label>
          </div>
          <div v-if="metricsColumns.length === 0" class="empty inset">
            No metric columns defined. Click "Add column" to start.
          </div>
          <table v-else class="sw-table metrics-table">
            <thead>
              <tr>
                <th>metric</th>
                <th>label</th>
                <th>unit</th>
                <th>aggregation</th>
                <th class="grow">mqe</th>
                <th>scale</th>
                <th>precision</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(c, i) in metricsColumns" :key="i">
                <td><input class="mono" v-model="c.metric" /></td>
                <td><input v-model="c.label" /></td>
                <td><input v-model="c.unit" placeholder="—" /></td>
                <td>
                  <select v-model="c.aggregation">
                    <option value="sum">sum</option>
                    <option value="avg">avg</option>
                  </select>
                </td>
                <td><input class="mono" v-model="c.mqe" placeholder="catalog default" /></td>
                <td><input type="number" step="any" v-model.number="c.scale" placeholder="1" /></td>
                <td><input type="number" min="0" max="6" v-model.number="c.precision" placeholder="auto" /></td>
                <td>
                  <button class="sw-btn danger" type="button" @click="deleteMetricColumn(i)">✕</button>
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <!-- Scope tabs -->
        <nav class="scope-tabs sw-card">
          <button
            v-for="s in SCOPES"
            :key="s"
            class="scope-tab"
            :class="{ on: activeScope === s }"
            type="button"
            @click="activeScope = s"
          >
            {{ s }}
            <span class="count">{{ widgetsFor(s).length }}</span>
          </button>
        </nav>

        <!-- Widget editor -->
        <section class="sw-card widgets-card">
          <div class="card-head">
            <h4>{{ activeScope }} widgets</h4>
            <span class="sub">12-col flow grid · uniform 180px row height · drag-free</span>
            <button class="sw-btn add" type="button" @click="addWidget">＋ Add widget</button>
          </div>

          <div v-if="currentWidgets.length === 0" class="empty inset">
            No widgets defined for this scope. Click "Add widget" to start.
          </div>

          <ul v-else class="widget-list">
            <li v-for="(w, i) in currentWidgets" :key="i" class="widget-edit">
              <div class="we-row">
                <div class="we-handle">
                  <button
                    class="sw-btn ghost small"
                    type="button"
                    :disabled="i === 0"
                    title="Move up"
                    @click="moveWidget(i, -1)"
                  >↑</button>
                  <button
                    class="sw-btn ghost small"
                    type="button"
                    :disabled="i === currentWidgets.length - 1"
                    title="Move down"
                    @click="moveWidget(i, 1)"
                  >↓</button>
                </div>
                <div class="we-fields">
                  <div class="row">
                    <label>
                      <span>id</span>
                      <input class="mono" v-model="w.id" />
                    </label>
                    <label class="grow">
                      <span>Title</span>
                      <input v-model="w.title" />
                    </label>
                    <label>
                      <span>Type</span>
                      <select v-model="w.type">
                        <option value="card">card</option>
                        <option value="line">line</option>
                      </select>
                    </label>
                    <label>
                      <span>Unit</span>
                      <input v-model="w.unit" placeholder="—" />
                    </label>
                    <label>
                      <span>Span (1–12)</span>
                      <input type="number" min="1" max="12" v-model.number="w.span" />
                    </label>
                    <label>
                      <span>Row span</span>
                      <input type="number" min="1" max="6" v-model.number="w.rowSpan" />
                    </label>
                  </div>
                  <div class="row">
                    <label class="grow wide">
                      <span>Visible when (optional)</span>
                      <input
                        class="mono"
                        v-model="w.visibleWhen"
                        placeholder="#entity.jvm   or   service_jvm_cpu has value"
                      />
                    </label>
                  </div>
                  <div class="row">
                    <label class="grow wide">
                      <span>MQE expressions (one per line)</span>
                      <textarea
                        class="mono"
                        rows="3"
                        :value="expressionsToText(w.expressions)"
                        @input="w.expressions = textToExpressions(($event.target as HTMLTextAreaElement).value)"
                      ></textarea>
                    </label>
                  </div>
                </div>
                <button class="sw-btn danger" type="button" title="Delete" @click="deleteWidget(i)">
                  ✕
                </button>
              </div>
            </li>
          </ul>
        </section>
      </main>
    </div>
  </div>
</template>

<style scoped>
.admin-page {
  padding: 20px 20px 60px;
  max-width: 1440px;
  margin: 0 auto;
}
.page-head { margin-bottom: 18px; }
.kicker {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sw-accent);
  margin-bottom: 6px;
}
.page-head h1 {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--sw-fg-0);
  margin: 0 0 8px;
}
.lede {
  font-size: 12.5px;
  color: var(--sw-fg-1);
  line-height: 1.5;
  margin: 0;
  max-width: 720px;
}
.banner.err {
  padding: 8px 12px;
  background: var(--sw-err-soft);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  color: #f87171;
  font-size: 12px;
  margin-bottom: 14px;
}
.empty {
  padding: 32px;
  text-align: center;
  color: var(--sw-fg-3);
  font-size: 12px;
}
.empty.inset {
  padding: 18px;
  font-size: 11.5px;
}
.grid {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 14px;
  align-items: start;
}
.layer-list {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-self: start;
  position: sticky;
  top: 16px;
}
.list-head {
  padding: 6px 10px 10px;
  border-bottom: 1px solid var(--sw-line);
  margin-bottom: 6px;
}
.list-head h4 {
  margin: 0;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--sw-fg-0);
}
.list-head .sub {
  font-size: 10px;
  color: var(--sw-fg-3);
}
.layer-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 5px;
  background: transparent;
  border: none;
  color: var(--sw-fg-1);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
  font: inherit;
}
.layer-row:hover { background: var(--sw-bg-2); }
.layer-row.active {
  background: var(--sw-bg-3);
  color: var(--sw-fg-0);
  box-shadow: inset 2px 0 0 var(--sw-accent);
}
.layer-row .dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  flex: 0 0 7px;
}
.layer-row .name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.detail {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.identity-card { padding: 12px 16px; }
.identity-row {
  display: flex;
  align-items: center;
  gap: 14px;
}
.identity-row h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--sw-fg-0);
}
.identity-row .meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 4px;
  font-size: 10.5px;
}
.identity-row .meta code {
  font-family: var(--sw-mono);
  background: var(--sw-bg-2);
  padding: 1px 6px;
  border-radius: 3px;
  color: var(--sw-fg-1);
}
.chip {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-2);
}
.chip.on {
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
}
.dot.inline {
  width: 12px; height: 12px;
  border-radius: 50%;
  display: inline-block;
}
.actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
.actions .sw-btn { font-size: 11.5px; }
.actions .sw-btn[disabled] { opacity: 0.4; pointer-events: none; }
.save-msg {
  font-size: 11px;
  color: var(--sw-ok);
}

.scope-tabs {
  display: flex;
  gap: 2px;
  padding: 6px;
}
.scope-tab {
  flex: 1;
  padding: 8px 12px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--sw-fg-2);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  text-transform: capitalize;
  font: inherit;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.scope-tab:hover { background: var(--sw-bg-2); color: var(--sw-fg-1); }
.scope-tab.on {
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
  font-weight: 600;
}
.scope-tab .count {
  font-family: var(--sw-mono);
  font-size: 10px;
  color: var(--sw-fg-3);
}
.scope-tab.on .count { color: var(--sw-accent-2); }

.components-card { padding: 0; }
.components-card .card-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
}
.components-card .card-head h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--sw-fg-0);
}
.components-card .card-head .sub {
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.comp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 6px;
  padding: 12px 14px;
}
.comp-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--sw-fg-2);
  padding: 6px 10px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
}
.comp-toggle:hover {
  background: var(--sw-bg-3);
}
.comp-toggle.on {
  background: var(--sw-accent-soft);
  border-color: var(--sw-accent-line);
  color: var(--sw-accent-2);
}
.comp-toggle input {
  accent-color: var(--sw-accent);
  margin: 0;
}
.comp-label {
  font-weight: 500;
}

.metrics-card { padding: 0; }
.metrics-card .card-head .add {
  margin-left: auto;
  font-size: 11.5px;
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
  border-color: var(--sw-accent-line);
}
.metrics-keys {
  display: flex;
  gap: 14px;
  padding: 10px 16px;
  border-bottom: 1px dashed var(--sw-line);
}
.metrics-keys label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 10.5px;
  color: var(--sw-fg-3);
  min-width: 120px;
}
.metrics-keys select {
  height: 26px;
  padding: 0 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11.5px;
}
.metrics-table {
  width: 100%;
}
.metrics-table th {
  text-align: left;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
  font-weight: 500;
  padding: 8px 10px 6px;
  border-bottom: 1px solid var(--sw-line);
}
.metrics-table th.grow {
  width: 35%;
}
.metrics-table td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--sw-line);
}
.metrics-table input,
.metrics-table select {
  width: 100%;
  height: 26px;
  padding: 0 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 3px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11.5px;
}
.metrics-table input.mono {
  font-family: var(--sw-mono);
  font-size: 11px;
}
.metrics-table .sw-btn.danger {
  width: 26px;
  height: 26px;
  padding: 0;
  font-size: 11px;
  border-color: rgba(239, 68, 68, 0.3);
  color: #f87171;
}

.widgets-card { padding: 0; }
.card-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--sw-line);
}
.card-head h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--sw-fg-0);
  text-transform: capitalize;
}
.card-head .sub {
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.card-head .add {
  margin-left: auto;
  font-size: 11.5px;
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
  border-color: var(--sw-accent-line);
}

.widget-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.widget-edit {
  border-bottom: 1px solid var(--sw-line);
}
.widget-edit:last-child { border-bottom: none; }
.we-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 16px;
}
.we-handle {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 18px;
}
.we-handle .sw-btn {
  width: 24px;
  height: 22px;
  padding: 0;
  font-size: 10px;
}
.we-fields {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.row label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 10.5px;
  color: var(--sw-fg-3);
  flex: 0 1 auto;
}
.row label.grow { flex: 1 1 auto; min-width: 140px; }
.row label.wide { flex: 1 1 100%; }
.row input,
.row select,
.row textarea {
  height: 26px;
  padding: 0 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11.5px;
}
.row textarea {
  height: auto;
  padding: 6px 8px;
  resize: vertical;
}
.row input.mono,
.row textarea.mono {
  font-family: var(--sw-mono);
  font-size: 11px;
}
.row input:focus,
.row select:focus,
.row textarea:focus {
  outline: none;
  border-color: var(--sw-accent-line);
}
.sw-btn.danger {
  width: 26px;
  height: 26px;
  padding: 0;
  font-size: 11px;
  margin-top: 18px;
  border-color: rgba(239, 68, 68, 0.3);
  color: #f87171;
}
.sw-btn.danger:hover {
  background: var(--sw-err-soft);
}
</style>
