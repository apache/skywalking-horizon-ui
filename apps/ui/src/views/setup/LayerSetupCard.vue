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
import { computed, ref } from 'vue';
import type { AggregationKind, LayerDef } from '@skywalking-horizon-ui/api-client';
import Icon from '@/components/icons/Icon.vue';
import { METRICS, metricsForLayer } from '@/composables/metricCatalog';
import { useSetupStore, defaultLandingFor } from '@/stores/setup';

/** Mirror of the setup-store's defaultAggregationFor — kept inline so the
 *  setup UI seeds new columns with the same defaults the store uses. */
function defaultAgg(metricKey: string): AggregationKind {
  const k = metricKey.toLowerCase();
  if (
    k === 'cpm' ||
    k.endsWith('.msg-rate') ||
    k.endsWith('.qps') ||
    k.endsWith('.pv') ||
    k.endsWith('.invocations') ||
    k.endsWith('.tokens') ||
    k.endsWith('.req') ||
    k.endsWith('.slow-queries') ||
    k.endsWith('.js-err') ||
    k.endsWith('.cold-start') ||
    k.endsWith('.restart')
  ) {
    return 'sum';
  }
  return 'avg';
}

const props = defineProps<{ layer: LayerDef; expanded?: boolean }>();
const emit = defineEmits<{ (e: 'toggle'): void }>();

const store = useSetupStore();
const cfg = computed(() => store.ensure(props.layer.key, { slots: props.layer.slots, caps: props.layer.caps }));

const open = ref(props.expanded ?? false);
function toggle(): void {
  open.value = !open.value;
  emit('toggle');
}

function resetThisLayer(): void {
  store.reset(props.layer.key, { slots: props.layer.slots, caps: props.layer.caps });
}

// Every form-field input on this card calls onEdit so the store knows the
// user (not just a default-population) touched the config.
function onEdit(): void {
  store.markDirty();
}

const summary = computed<string>(() => {
  const c = cfg.value;
  const cols = c.landing.columns.map((x) => x.metric).join(', ');
  const base = `Top ${c.landing.topN} by ${c.landing.orderBy} · ${cols}${
    c.landing.spark ? ` · sparkline ${c.landing.spark.metric}` : ''
  } · priority ${c.landing.priority}`;
  if (!props.layer.active) {
    return `${base} · no service reporting yet`;
  }
  return base;
});

// Cap rows the operator can toggle. The per-layer page always opens on
// Services — there's no `overview` cap; the global Overview already
// composes layers automatically.
const capRows: Array<{ key: keyof typeof cfg.value.caps; label: string }> = [
  { key: 'serviceMap', label: 'Service map' },
  { key: 'endpointDependency', label: 'API dependency' },
  { key: 'instanceTopology', label: 'Instance map' },
  { key: 'processTopology', label: 'Process map' },
  { key: 'dashboards', label: 'Dashboards' },
  { key: 'traces', label: 'Traces' },
  { key: 'logs', label: 'Logs' },
  { key: 'profiling', label: 'Profiling' },
  { key: 'events', label: 'Events' },
];

// Pulled from the shared metric catalog so labels/units/tips stay
// consistent across the Overview cards and the setup UI.
const availableColumns = Object.values(METRICS).map((m) => ({
  metric: m.key,
  label: m.label,
  longLabel: m.longLabel,
  unit: m.unit,
  tip: m.tip,
}));
// Chip groups: layer-relevant metrics first, the rest collapsed below.
const groupedColumns = computed(() => {
  const { recommended, other } = metricsForLayer(props.layer.key);
  const toOpt = (m: typeof recommended[number]) => ({
    metric: m.key,
    label: m.label,
    longLabel: m.longLabel,
    unit: m.unit,
    tip: m.tip,
  });
  return {
    recommended: recommended.map(toOpt),
    other: other.map(toOpt),
  };
});
const showAllChips = ref(false);
function isColumnSelected(metric: string): boolean {
  return cfg.value.landing.columns.some((c) => c.metric === metric);
}
function toggleColumn(metric: string, label: string, unit?: string): void {
  const cols = cfg.value.landing.columns;
  const idx = cols.findIndex((c) => c.metric === metric);
  if (idx >= 0) {
    cols.splice(idx, 1);
  } else if (cols.length < 5) {
    cols.push({
      metric,
      label,
      ...(unit ? { unit } : {}),
      aggregation: defaultAgg(metric),
    });
  }
  onEdit();
}

const showAdvanced = ref(false);
function toggleThroughput(): void {
  if (cfg.value.landing.throughput) {
    cfg.value.landing.throughput = undefined;
  } else {
    const m = cfg.value.landing.orderBy;
    cfg.value.landing.throughput = {
      metric: m,
      aggregation: defaultAgg(m),
    };
  }
  onEdit();
}

function clampTopN(n: number): void {
  const v = Math.max(5, Math.min(8, Math.round(n || 5)));
  cfg.value.landing.topN = v;
  onEdit();
}

const headerColor = computed(() => props.layer.color);
const isDefaultLanding = computed(() => {
  const d = defaultLandingFor(props.layer.key);
  return (
    cfg.value.landing.priority === d.priority &&
    cfg.value.landing.topN === d.topN &&
    cfg.value.landing.orderBy === d.orderBy &&
    cfg.value.landing.columns.length === d.columns.length
  );
});
</script>

<template>
  <div class="sw-card layer-card" :class="{ 'is-open': open, 'is-inactive': !layer.active }">
    <div class="head" @click="toggle">
      <span class="dot" :style="{ background: headerColor }" />
      <span class="name">{{ cfg.displayName || layer.name }}</span>
      <span v-if="layer.active" class="sw-badge ok dot-mark">{{ layer.serviceCount >= 0 ? `${layer.serviceCount} services` : 'active' }}</span>
      <span v-else class="sw-badge">no data</span>
      <span class="sw-badge info" style="margin-left: auto" title="Priority on the Overview">
        ↑ {{ cfg.landing.priority }}
      </span>
      <span v-if="!isDefaultLanding" class="sw-badge">customized</span>
      <span class="caret" :class="{ open }"><Icon name="caret" :size="12" /></span>
    </div>
    <div class="summary">{{ summary }}</div>

    <div v-if="open" class="body">
      <section>
        <h4>Term aliases</h4>
        <div class="field-grid">
          <label>
            <span>Display name</span>
            <input v-model="cfg.displayName" :placeholder="layer.name" @input="onEdit" />
          </label>
          <label v-if="layer.slots.services !== undefined">
            <span>Services</span>
            <input v-model="cfg.slots.services" :placeholder="layer.slots.services" @input="onEdit" />
          </label>
          <label v-if="layer.slots.instances !== undefined">
            <span>Instances</span>
            <input v-model="cfg.slots.instances" :placeholder="layer.slots.instances" @input="onEdit" />
          </label>
          <label v-if="layer.slots.endpoints !== undefined">
            <span>Endpoints</span>
            <input v-model="cfg.slots.endpoints" :placeholder="layer.slots.endpoints" @input="onEdit" />
          </label>
          <label v-if="cfg.caps.endpointDependency">
            <span>Endpoint dependency</span>
            <input v-model="cfg.slots.endpointDependency" :placeholder="layer.slots.endpointDependency ?? `${cfg.slots.endpoints ?? 'Endpoint'} dependency`" @input="onEdit" />
          </label>
        </div>
      </section>

      <section>
        <h4>Features</h4>
        <div class="caps-grid">
          <label v-for="row in capRows" :key="row.key" class="cap-toggle">
            <input type="checkbox" v-model="cfg.caps[row.key]" @change="onEdit" />
            <span>{{ row.label }}</span>
          </label>
        </div>
      </section>

      <section>
        <h4>Landing card</h4>
        <div class="field-grid landing">
          <label>
            <span>Priority (lower = higher on page)</span>
            <input type="number" v-model.number="cfg.landing.priority" min="0" max="99" @input="onEdit" />
          </label>
          <label>
            <span>Top N (5–8)</span>
            <input type="number" :value="cfg.landing.topN" min="5" max="8" @input="(e) => clampTopN(Number((e.target as HTMLInputElement).value))" />
          </label>
          <label>
            <span>Order by</span>
            <select v-model="cfg.landing.orderBy" @change="onEdit">
              <option v-for="c in availableColumns" :key="c.metric" :value="c.metric" :title="c.tip">
                {{ c.longLabel }}
              </option>
            </select>
          </label>
          <label>
            <span>Sparkline</span>
            <select :value="cfg.landing.spark?.metric ?? ''" @change="(e) => { const v = (e.target as HTMLSelectElement).value; cfg.landing.spark = v ? { metric: v, height: 28 } : undefined; onEdit(); }">
              <option value="">none</option>
              <option v-for="c in availableColumns" :key="c.metric" :value="c.metric" :title="c.tip">
                {{ c.longLabel }}
              </option>
            </select>
          </label>
          <label>
            <span>Style</span>
            <select v-model="cfg.landing.style" @change="onEdit">
              <option value="table">Table</option>
              <option value="bar">Bar</option>
              <option value="mini-topology">Mini topology</option>
            </select>
          </label>
        </div>
        <div class="cols-row">
          <span class="cols-label">Columns (max 5)</span>
          <div class="cols-chips">
            <button
              v-for="c in groupedColumns.recommended"
              :key="c.metric"
              class="chip"
              :class="{ on: isColumnSelected(c.metric) }"
              type="button"
              :title="`${c.longLabel}\n\n${c.tip}`"
              @click="toggleColumn(c.metric, c.label, c.unit)"
            >
              {{ c.label }}<span v-if="c.unit" class="unit">{{ c.unit }}</span>
            </button>
            <button
              v-if="!showAllChips && groupedColumns.other.length > 0"
              class="chip more"
              type="button"
              :title="`Show ${groupedColumns.other.length} more metric${groupedColumns.other.length === 1 ? '' : 's'}`"
              @click="showAllChips = true"
            >
              + {{ groupedColumns.other.length }} more
            </button>
            <template v-if="showAllChips">
              <span class="group-sep">other</span>
              <button
                v-for="c in groupedColumns.other"
                :key="c.metric"
                class="chip"
                :class="{ on: isColumnSelected(c.metric) }"
                type="button"
                :title="`${c.longLabel}\n\n${c.tip}`"
                @click="toggleColumn(c.metric, c.label, c.unit)"
              >
                {{ c.label }}<span v-if="c.unit" class="unit">{{ c.unit }}</span>
              </button>
            </template>
          </div>
        </div>
      </section>

      <section v-if="cfg.landing.columns.length > 0">
        <div class="row-with-toggle">
          <h4>Column details</h4>
          <button class="sw-btn ghost small" type="button" @click="showAdvanced = !showAdvanced">
            {{ showAdvanced ? 'Hide advanced' : 'Show advanced (MQE, scale, precision)' }}
          </button>
        </div>
        <table class="col-editor">
          <thead>
            <tr>
              <th>Metric</th>
              <th>Label</th>
              <th>Unit</th>
              <th>Aggregate</th>
              <template v-if="showAdvanced">
                <th>MQE override</th>
                <th>Scale</th>
                <th>Precision</th>
              </template>
            </tr>
          </thead>
          <tbody>
            <tr v-for="col in cfg.landing.columns" :key="col.metric">
              <td class="metric-key">{{ col.metric }}</td>
              <td><input class="ctl" v-model="col.label" @input="onEdit" /></td>
              <td><input class="ctl narrow" v-model="col.unit" placeholder="—" @input="onEdit" /></td>
              <td>
                <select class="ctl narrow" v-model="col.aggregation" @change="onEdit">
                  <option value="avg">avg</option>
                  <option value="sum">sum</option>
                </select>
              </td>
              <template v-if="showAdvanced">
                <td>
                  <input
                    class="ctl mono"
                    v-model="col.mqe"
                    placeholder="catalog default"
                    title="Paste a custom MQE expression to override the built-in mapping (e.g. avg(service_sla)/100)."
                    @input="onEdit"
                  />
                </td>
                <td>
                  <input
                    class="ctl narrow"
                    type="number"
                    step="any"
                    v-model.number="col.scale"
                    placeholder="1"
                    title="Multiplier applied to the raw MQE value. Use 0.01 to convert SkyWalking SLA (9923 → 99.23)."
                    @input="onEdit"
                  />
                </td>
                <td>
                  <input
                    class="ctl narrow"
                    type="number"
                    min="0"
                    max="6"
                    v-model.number="col.precision"
                    placeholder="auto"
                    title="Decimal places to round to before display."
                    @input="onEdit"
                  />
                </td>
              </template>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <div class="row-with-toggle">
          <h4>Throughput KPI</h4>
          <button class="sw-btn ghost small" type="button" @click="toggleThroughput">
            {{ cfg.landing.throughput ? 'Remove' : 'Add' }}
          </button>
        </div>
        <p class="hint subtle">
          The headline metric on this layer's Overview tile. Aggregation defaults to
          <code>sum</code> (whole-layer traffic) when off; switch to <code>avg</code> for
          ratio-shaped metrics.
        </p>
        <div v-if="cfg.landing.throughput" class="field-grid landing">
          <label>
            <span>Metric</span>
            <select v-model="cfg.landing.throughput.metric" @change="onEdit">
              <option v-for="c in availableColumns" :key="c.metric" :value="c.metric" :title="c.tip">
                {{ c.longLabel }}
              </option>
            </select>
          </label>
          <label>
            <span>Aggregation</span>
            <select v-model="cfg.landing.throughput.aggregation" @change="onEdit">
              <option value="sum">sum</option>
              <option value="avg">avg</option>
            </select>
          </label>
          <label>
            <span>Label (optional)</span>
            <input v-model="cfg.landing.throughput.label" placeholder="Throughput" @input="onEdit" />
          </label>
          <label>
            <span>Unit (optional)</span>
            <input v-model="cfg.landing.throughput.unit" placeholder="—" @input="onEdit" />
          </label>
          <label class="wide-2">
            <span>MQE override (optional)</span>
            <input
              class="mono"
              v-model="cfg.landing.throughput.mqe"
              placeholder="catalog default"
              @input="onEdit"
            />
          </label>
          <label>
            <span>Scale</span>
            <input type="number" step="any" v-model.number="cfg.landing.throughput.scale" placeholder="1" @input="onEdit" />
          </label>
          <label>
            <span>Precision</span>
            <input type="number" min="0" max="6" v-model.number="cfg.landing.throughput.precision" placeholder="auto" @input="onEdit" />
          </label>
        </div>
      </section>

      <div class="actions">
        <button class="sw-btn" type="button" @click="resetThisLayer">Reset to defaults</button>
        <span class="hint">Changes are local until persisted via /api/setup (Stage 2.4).</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.layer-card {
  margin-bottom: 10px;
}
.layer-card.is-inactive .name {
  color: var(--sw-fg-2);
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  cursor: pointer;
  user-select: none;
}
.head .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 8px;
}
.head .name {
  font-weight: 600;
  color: var(--sw-fg-0);
}
.head .dot-mark::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  margin-right: 4px;
  display: inline-block;
}
.caret {
  color: var(--sw-fg-3);
  transition: transform 0.12s;
  transform: rotate(-90deg);
  display: inline-flex;
  margin-left: 8px;
}
.caret.open {
  transform: rotate(0);
}
.summary {
  padding: 0 12px 10px;
  font-size: 11px;
  color: var(--sw-fg-2);
}
.body {
  border-top: 1px solid var(--sw-line);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.body h4 {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-2);
  margin: 0 0 8px;
  font-weight: 600;
}
.field-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}
.field-grid label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  color: var(--sw-fg-2);
}
.field-grid label.wide {
  grid-column: 1 / -1;
  flex-direction: row;
  align-items: center;
}
.field-grid input,
.field-grid select {
  height: 28px;
  padding: 0 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 12px;
}
.field-grid input[type='checkbox'] {
  height: auto;
  margin-right: 6px;
  padding: 0;
}
.caps-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 6px;
}
.cap-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--sw-fg-1);
  padding: 4px 6px;
  border-radius: 4px;
  background: var(--sw-bg-2);
}
.cap-toggle input {
  accent-color: var(--sw-accent);
}
.cols-row {
  margin-top: 10px;
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.cols-label {
  font-size: 11px;
  color: var(--sw-fg-2);
  padding-top: 4px;
  flex: 0 0 80px;
}
.cols-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  height: 24px;
  padding: 0 10px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-1);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.chip.on {
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
  border-color: var(--sw-accent-line);
}
.chip .unit {
  color: var(--sw-fg-3);
  font-size: 10px;
}
.chip.more {
  border-style: dashed;
  color: var(--sw-fg-2);
}
.group-sep {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sw-fg-3);
  align-self: center;
  margin: 0 6px;
}
.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-top: 6px;
  border-top: 1px dashed var(--sw-line);
}
.actions .hint {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.row-with-toggle {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 6px;
}
.row-with-toggle h4 {
  margin: 0;
}
.row-with-toggle .sw-btn {
  margin-left: auto;
  height: 22px;
  font-size: 10.5px;
  padding: 0 8px;
}
.hint.subtle {
  margin: -2px 0 8px;
  font-size: 10.5px;
  color: var(--sw-fg-3);
  line-height: 1.5;
}
.hint.subtle code {
  font-family: var(--sw-mono);
  font-size: 10px;
  background: var(--sw-bg-2);
  padding: 1px 4px;
  border-radius: 3px;
}
.col-editor {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.col-editor th {
  text-align: left;
  font-weight: 500;
  font-size: 10px;
  color: var(--sw-fg-3);
  letter-spacing: 0.04em;
  padding: 4px 6px 6px;
  border-bottom: 1px solid var(--sw-line);
}
.col-editor td {
  padding: 4px 6px;
  vertical-align: middle;
}
.col-editor .metric-key {
  font-family: var(--sw-mono);
  font-size: 10.5px;
  color: var(--sw-fg-2);
}
.col-editor .ctl {
  width: 100%;
  height: 22px;
  padding: 0 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 3px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11px;
}
.col-editor .ctl.narrow {
  max-width: 70px;
}
.col-editor .ctl.mono,
.field-grid .mono {
  font-family: var(--sw-mono);
  font-size: 10.5px;
}
.field-grid label.wide-2 {
  grid-column: span 2;
}
</style>
