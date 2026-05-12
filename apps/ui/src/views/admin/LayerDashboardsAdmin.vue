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
  Admin / Layer dashboards setup. Lists every layer template the BFF
  loaded from JSON and shows its current configuration: alias, enabled
  components, landing card metrics, dashboard widget set. Editing comes
  in the next iteration — this commit gets the view live so operators
  can see what's configured per layer.
-->
<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import type { AdminLayerTemplate } from '@/api/client';
import { bffClient } from '@/api/client';

const templates = ref<AdminLayerTemplate[]>([]);
const isLoading = ref(true);
const error = ref<string | null>(null);
const selectedKey = ref<string>('');

onMounted(async () => {
  try {
    const res = await bffClient.adminLayerTemplates();
    templates.value = res.templates;
    if (res.templates.length > 0) selectedKey.value = res.templates[0].key;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    isLoading.value = false;
  }
});

const selected = computed<AdminLayerTemplate | null>(
  () => templates.value.find((t) => t.key === selectedKey.value) ?? null,
);

function componentFlags(t: AdminLayerTemplate): string[] {
  const c = t.components;
  const out: string[] = [];
  if (c.service) out.push('service');
  if (c.instances) out.push('instances');
  if (c.endpoints) out.push('endpoints');
  if (c.endpointDependency) out.push('api dependency');
  if (c.topology) out.push('topology');
  if (c.traces) out.push('traces');
  if (c.logs) out.push('logs');
  if (c.profiling) out.push('profiling');
  return out;
}
</script>

<template>
  <div class="admin-page">
    <header class="page-head">
      <div>
        <div class="kicker">Admin</div>
        <h1>Layer dashboards</h1>
        <p class="lede">
          Each layer ships with a JSON template defining its alias, enabled components,
          landing card metrics, and dashboard widgets. This view shows the current
          template per layer. Inline editing + operator overrides are next.
        </p>
      </div>
    </header>

    <div v-if="error" class="banner err">{{ error }}</div>
    <div v-if="isLoading" class="empty">Loading templates…</div>
    <div v-else-if="templates.length === 0" class="empty">No layer templates loaded.</div>

    <div v-else class="grid">
      <!-- Layer picker (left) -->
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
          <span class="badge">{{ t.widgets.length }}</span>
        </button>
      </aside>

      <!-- Template detail (right) -->
      <main v-if="selected" class="detail">
        <section class="sw-card">
          <div class="card-head">
            <h4>Identity</h4>
          </div>
          <table class="kv">
            <tbody>
              <tr><th>Key</th><td class="mono">{{ selected.key }}</td></tr>
              <tr><th>Alias</th><td>{{ selected.alias || '—' }}</td></tr>
              <tr><th>Color</th><td>
                <span class="dot inline" :style="{ background: selected.color || 'var(--sw-fg-3)' }" />
                <code>{{ selected.color || '—' }}</code>
              </td></tr>
              <tr v-if="selected.documentLink"><th>Docs</th>
                <td><a :href="selected.documentLink" target="_blank" rel="noopener noreferrer">{{ selected.documentLink }} ↗</a></td>
              </tr>
            </tbody>
          </table>
        </section>

        <section class="sw-card">
          <div class="card-head"><h4>Components enabled</h4></div>
          <div class="chips">
            <span v-for="c in componentFlags(selected)" :key="c" class="chip on">{{ c }}</span>
            <span v-if="componentFlags(selected).length === 0" class="chip off">none</span>
          </div>
        </section>

        <section class="sw-card">
          <div class="card-head">
            <h4>Slots</h4>
            <span class="sub">term aliases for service / instance / endpoint scopes</span>
          </div>
          <table class="kv">
            <tbody>
              <tr><th>Services</th><td>{{ selected.slots.services || '—' }}</td></tr>
              <tr><th>Instances</th><td>{{ selected.slots.instances || '—' }}</td></tr>
              <tr><th>Endpoints</th><td>{{ selected.slots.endpoints || '—' }}</td></tr>
              <tr v-if="selected.slots.endpointDependency">
                <th>Endpoint dependency</th><td>{{ selected.slots.endpointDependency }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section class="sw-card">
          <div class="card-head">
            <h4>Landing card metrics</h4>
            <span class="sub">columns shown on the Overview KPI tile + per-layer header</span>
          </div>
          <table v-if="selected.metrics.columns?.length" class="sw-table">
            <thead>
              <tr>
                <th>metric</th><th>label</th><th>unit</th><th>aggregation</th><th>mqe</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in selected.metrics.columns" :key="c.metric">
                <td class="mono">{{ c.metric }}</td>
                <td>{{ c.label }}</td>
                <td>{{ c.unit || '—' }}</td>
                <td><span class="tag">{{ c.aggregation || 'avg' }}</span></td>
                <td class="mono">{{ c.mqe || '(catalog default)' }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="empty">No columns defined.</p>
          <div class="extras">
            <span><strong>orderBy:</strong> <code>{{ selected.metrics.orderBy || '—' }}</code></span>
            <span><strong>throughput:</strong> <code>{{ selected.metrics.throughput || '—' }}</code></span>
            <span><strong>spark:</strong> <code>{{ selected.metrics.spark || '—' }}</code></span>
          </div>
        </section>

        <section class="sw-card">
          <div class="card-head">
            <h4>Dashboard widgets</h4>
            <span class="sub">{{ selected.widgets.length }} widget{{ selected.widgets.length === 1 ? '' : 's' }} · grid is 24-col</span>
          </div>
          <table v-if="selected.widgets.length > 0" class="sw-table">
            <thead>
              <tr>
                <th>id</th><th>title</th><th>type</th><th>unit</th><th>x,y</th><th>w×h</th><th>expressions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="w in selected.widgets" :key="w.id">
                <td class="mono">{{ w.id }}</td>
                <td>{{ w.title }}</td>
                <td><span class="tag">{{ w.type }}</span></td>
                <td>{{ w.unit || '—' }}</td>
                <td class="mono">{{ w.x }},{{ w.y }}</td>
                <td class="mono">{{ w.w }}×{{ w.h }}</td>
                <td class="mono mqe">
                  <div v-for="(e, i) in w.expressions" :key="i">{{ e }}</div>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-else class="empty">No widgets defined.</p>
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
.page-head {
  margin-bottom: 18px;
}
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
.grid {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 14px;
}
.layer-list {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-self: start;
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
.layer-row:hover {
  background: var(--sw-bg-2);
}
.layer-row.active {
  background: var(--sw-bg-3);
  color: var(--sw-fg-0);
  box-shadow: inset 2px 0 0 var(--sw-accent);
}
.layer-row .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 7px;
}
.layer-row .name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.layer-row .badge {
  font-family: var(--sw-mono);
  font-size: 10px;
  color: var(--sw-fg-3);
}
.detail {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.card-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
}
.card-head h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--sw-fg-0);
}
.card-head .sub {
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.kv {
  width: 100%;
  font-size: 12px;
}
.kv th, .kv td {
  padding: 6px 14px;
  text-align: left;
  border-bottom: 1px solid var(--sw-line);
  vertical-align: top;
}
.kv th {
  width: 140px;
  color: var(--sw-fg-3);
  font-weight: 500;
}
.kv tr:last-child th, .kv tr:last-child td {
  border-bottom: none;
}
.mono {
  font-family: var(--sw-mono);
  font-size: 11.5px;
  color: var(--sw-fg-1);
}
.mono code {
  background: transparent;
  padding: 0;
}
.dot.inline {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
  vertical-align: middle;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 12px 14px;
}
.chip {
  font-size: 10.5px;
  padding: 3px 8px;
  border-radius: 4px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
  border: 1px solid var(--sw-line-2);
}
.chip.on {
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
  border-color: var(--sw-accent-line);
}
.chip.off {
  color: var(--sw-fg-3);
}
.sw-table {
  width: 100%;
  font-size: 11.5px;
}
.sw-table th {
  text-align: left;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
  font-weight: 500;
  padding: 6px 14px;
  border-bottom: 1px solid var(--sw-line);
}
.sw-table td {
  padding: 6px 14px;
  border-bottom: 1px solid var(--sw-line);
  color: var(--sw-fg-1);
  vertical-align: top;
}
.sw-table td.mqe div + div {
  margin-top: 2px;
}
.tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-2);
  font-family: var(--sw-mono);
}
.extras {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  padding: 10px 14px;
  border-top: 1px dashed var(--sw-line);
  font-size: 11px;
  color: var(--sw-fg-2);
}
.extras strong {
  color: var(--sw-fg-3);
  font-weight: 500;
  text-transform: uppercase;
  font-size: 9.5px;
  letter-spacing: 0.08em;
  margin-right: 4px;
}
.extras code {
  font-family: var(--sw-mono);
  font-size: 10.5px;
  background: var(--sw-bg-2);
  padding: 1px 4px;
  border-radius: 3px;
  color: var(--sw-fg-1);
}
</style>
