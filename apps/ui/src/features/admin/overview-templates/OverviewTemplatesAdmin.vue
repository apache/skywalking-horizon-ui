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
  Admin: overview-dashboard templates. Lists every bundled dashboard,
  lets the operator edit per-widget fields that don't need code
  changes — layer / limit / title / tip / span / rowSpan. Type,
  MQE, KPIs, and the widget set stay frozen at the bundled value;
  changing those is still a code edit (the bundled JSON is the
  source of truth, this admin is an in-place tweak layer).
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { OverviewDashboard, OverviewWidget } from '@skywalking-horizon-ui/api-client';
import { bff } from '@/api/client';
import { useLayers } from '@/shell/useLayers';

const listQuery = useQuery({
  queryKey: ['admin/overview-templates'],
  queryFn: () => bff.overview.adminList(),
  staleTime: 60_000,
});
const dashboards = computed(() => listQuery.data.value?.dashboards ?? []);

const selectedId = ref<string>('');
watch(
  () => dashboards.value,
  (list) => {
    if (!selectedId.value && list.length > 0) selectedId.value = list[0]!.id;
  },
);

const detailQuery = useQuery({
  queryKey: computed(() => ['admin/overview-templates', selectedId.value]),
  queryFn: () => bff.overview.adminGet(selectedId.value),
  enabled: computed(() => selectedId.value.length > 0),
  staleTime: 60_000,
});

const { availableLayers } = useLayers();
/** Layer dropdown options. Starts from the layers the connected OAP
 *  is actively reporting on (so the operator sees real data sources
 *  first) but ALSO includes any layer key already referenced by a
 *  widget in the current draft — even if that layer has no live
 *  data. Without this fallback, configuring a widget for a layer
 *  that's "configured but quiet" (e.g. VIRTUAL_GENAI on a deployment
 *  with no AI traffic) would silently blank the dropdown and lose
 *  the operator's prior choice. */
const layerOptions = computed<string[]>(() => {
  const live = new Set((availableLayers.value ?? []).map((l) => l.key.toUpperCase()));
  for (const w of draft.value?.widgets ?? []) {
    if (w.layer) live.add(w.layer.toUpperCase());
  }
  return Array.from(live).sort();
});

/* Local working copy — deep-cloned so edits don't mutate the
 * react-query cache. Reset on dashboard switch + on save. */
const draft = ref<OverviewDashboard | null>(null);
watch(
  () => detailQuery.data.value,
  (resp) => {
    draft.value = resp ? (JSON.parse(JSON.stringify(resp.dashboard)) as OverviewDashboard) : null;
  },
);

const flash = ref<string | null>(null);
const saving = ref(false);
function setFlash(msg: string): void {
  flash.value = msg;
  setTimeout(() => {
    if (flash.value === msg) flash.value = null;
  }, 4000);
}

const isDirty = computed<boolean>(() => {
  const cur = draft.value;
  const orig = detailQuery.data.value?.dashboard;
  if (!cur || !orig) return false;
  return JSON.stringify(cur) !== JSON.stringify(orig);
});

async function onSave(): Promise<void> {
  if (!draft.value || !selectedId.value) return;
  saving.value = true;
  try {
    await bff.overview.adminSave(selectedId.value, draft.value);
    await detailQuery.refetch();
    setFlash('saved · reload the overview to see widget changes');
  } catch (err) {
    setFlash(err instanceof Error ? `error: ${err.message}` : 'save failed');
  } finally {
    saving.value = false;
  }
}

function onReset(): void {
  const orig = detailQuery.data.value?.dashboard;
  if (orig) draft.value = JSON.parse(JSON.stringify(orig)) as OverviewDashboard;
}

/** Which widget fields are editable per-type. Type / MQE / KPIs stay
 *  frozen — they're code-shape decisions, not config tweaks. */
function showsLayer(w: OverviewWidget): boolean {
  return w.type !== 'section-break' && w.type !== 'alarms' ? true : w.type === 'alarms';
}
function showsLimit(w: OverviewWidget): boolean {
  return w.type === 'alarms';
}
function showsLayout(w: OverviewWidget): boolean {
  return w.type !== 'section-break';
}
</script>

<template>
  <div class="ot">
    <header class="ot__head">
      <div>
        <div class="ot__kicker">Dashboard setup · Overviews</div>
        <h1>Overview templates</h1>
        <p class="ot__lede">
          Per-widget tweaks for the bundled overview dashboards. Edits write back to
          <code>bundled_templates/overviews/*.json</code> and invalidate the BFF cache
          so the next dashboard fetch picks them up. Widget type / MQE / KPI definitions
          stay code-managed — only layout + scope fields are editable here.
        </p>
      </div>
    </header>

    <div v-if="listQuery.isPending.value" class="ot__empty">loading…</div>

    <div v-else class="ot__split">
      <ul class="ot__list">
        <li
          v-for="d in dashboards"
          :key="d.id"
          class="ot__list-item"
          :class="{ active: d.id === selectedId, readonly: !d.editable }"
          @click="selectedId = d.id"
        >
          <div class="ot__list-title">{{ d.title }}</div>
          <div class="ot__list-meta">
            <code>{{ d.id }}</code>
            <span>{{ d.widgetCount }} widget{{ d.widgetCount === 1 ? '' : 's' }}</span>
            <span v-if="!d.editable" class="ot__readonly-tag">no source file</span>
          </div>
        </li>
        <li v-if="dashboards.length === 0" class="ot__list-empty">No overview templates loaded.</li>
      </ul>

      <section class="ot__detail">
        <div v-if="detailQuery.isPending.value && !draft" class="ot__empty">loading…</div>
        <template v-else-if="draft">
          <header class="ot__detail-head">
            <h2><code>{{ draft.id }}</code></h2>
            <span class="ot__count mono">{{ draft.widgets.length }} widget{{ draft.widgets.length === 1 ? '' : 's' }}</span>
          </header>

          <table class="ot__table">
            <thead>
              <tr>
                <th>Widget</th>
                <th>Type</th>
                <th>Layer</th>
                <th>Limit</th>
                <th>Span / Row</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(w, i) in draft.widgets" :key="w.id">
                <td>
                  <input v-model="w.title" type="text" class="ot__in" :placeholder="w.id" />
                  <input v-model="w.tip" type="text" class="ot__in ot__in--tip" placeholder="tip (optional)" />
                  <code class="ot__wid-id">{{ w.id }}</code>
                </td>
                <td><span class="ot__type">{{ w.type }}</span></td>
                <td>
                  <select
                    v-if="showsLayer(w)"
                    v-model="w.layer"
                    class="ot__in ot__in--narrow"
                  >
                    <option :value="undefined">— any —</option>
                    <option v-for="k in layerOptions" :key="k" :value="k">{{ k }}</option>
                  </select>
                  <span v-else class="ot__none">—</span>
                </td>
                <td>
                  <input
                    v-if="showsLimit(w)"
                    v-model.number="w.limit"
                    type="number"
                    min="1"
                    max="100"
                    class="ot__in ot__in--num"
                  />
                  <span v-else class="ot__none">—</span>
                </td>
                <td>
                  <template v-if="showsLayout(w)">
                    <input
                      v-model.number="w.span"
                      type="number"
                      min="1"
                      max="12"
                      class="ot__in ot__in--xnum"
                      :title="`Widget ${i + 1} grid span (1..12)`"
                    />
                    <input
                      v-model.number="w.rowSpan"
                      type="number"
                      min="1"
                      max="12"
                      class="ot__in ot__in--xnum"
                      :title="`Widget ${i + 1} row span (1..12)`"
                    />
                  </template>
                  <span v-else class="ot__none">— / —</span>
                </td>
              </tr>
            </tbody>
          </table>

          <div class="ot__actions">
            <span v-if="flash" class="ot__flash">{{ flash }}</span>
            <span v-else-if="isDirty" class="ot__dirty">unsaved changes</span>
            <span v-else class="ot__clean">saved</span>
            <button type="button" class="ot__btn" :disabled="!isDirty || saving" @click="onReset">
              reset
            </button>
            <button
              type="button"
              class="ot__btn ot__btn--primary"
              :disabled="!isDirty || saving"
              @click="onSave"
            >
              {{ saving ? 'saving…' : 'save' }}
            </button>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.ot { padding: 20px 20px 60px; max-width: 1400px; margin: 0 auto; }
.ot__head { margin-bottom: 18px; }
.ot__kicker {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--sw-accent); margin-bottom: 4px;
}
.ot h1 { font-size: 22px; font-weight: 600; color: var(--sw-fg-0); margin: 0 0 8px; }
.ot__lede { font-size: 12.5px; color: var(--sw-fg-1); line-height: 1.5; margin: 0; max-width: 820px; }
.ot__lede code {
  font-family: var(--sw-mono); font-size: 11.5px;
  color: var(--sw-fg-0); background: var(--sw-bg-2); padding: 1px 5px; border-radius: 3px;
}
.ot__empty { padding: 32px; text-align: center; color: var(--sw-fg-3); font-size: 12px; }

.ot__split { display: grid; grid-template-columns: 280px 1fr; gap: 16px; align-items: start; }
.ot__list {
  list-style: none; margin: 0; padding: 0;
  background: var(--sw-bg-1); border: 1px solid var(--sw-line); border-radius: 8px; overflow: hidden;
}
.ot__list-item { padding: 10px 14px; border-bottom: 1px solid var(--sw-line); cursor: pointer; }
.ot__list-item:last-child { border-bottom: none; }
.ot__list-item:hover { background: var(--sw-bg-2); }
.ot__list-item.active { background: var(--sw-bg-3); box-shadow: inset 2px 0 0 var(--sw-accent); }
.ot__list-item.readonly { opacity: 0.6; cursor: not-allowed; }
.ot__list-title { font-size: 12.5px; font-weight: 500; color: var(--sw-fg-0); }
.ot__list-meta { margin-top: 4px; display: flex; gap: 8px; font-size: 10.5px; color: var(--sw-fg-3); }
.ot__list-meta code { font-family: var(--sw-mono); color: var(--sw-fg-2); }
.ot__readonly-tag { color: var(--sw-warn); font-style: italic; }
.ot__list-empty { padding: 24px; text-align: center; font-size: 12px; color: var(--sw-fg-3); }

.ot__detail { background: var(--sw-bg-1); border: 1px solid var(--sw-line); border-radius: 8px; padding: 16px; }
.ot__detail-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
.ot__detail-head h2 { margin: 0; font-size: 13px; font-weight: 600; }
.ot__detail-head h2 code { font-family: var(--sw-mono); color: var(--sw-fg-0); }
.ot__count { font-size: 11px; color: var(--sw-fg-3); margin-left: auto; }

.ot__table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
.ot__table thead th {
  text-align: left; font-size: 10px;
  text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--sw-fg-3); padding: 6px 8px;
  border-bottom: 1px solid var(--sw-line); font-weight: 600;
}
.ot__table tbody td {
  padding: 8px; vertical-align: top;
  border-bottom: 1px solid var(--sw-line);
}
.ot__table tbody tr:last-child td { border-bottom: none; }
.ot__in {
  background: var(--sw-bg-2); border: 1px solid var(--sw-line);
  color: var(--sw-fg-0); font: inherit; font-size: 11.5px;
  padding: 4px 6px; border-radius: 4px;
}
.ot__in--narrow { width: 140px; }
.ot__in--num { width: 70px; font-variant-numeric: tabular-nums; }
.ot__in--xnum { width: 48px; font-variant-numeric: tabular-nums; margin-right: 4px; }
.ot__in--tip {
  display: block; margin-top: 4px;
  font-size: 10.5px; color: var(--sw-fg-2); width: 100%;
}
.ot__wid-id {
  display: block; margin-top: 4px;
  font-family: var(--sw-mono); font-size: 10px; color: var(--sw-fg-3);
}
.ot__type {
  font-family: var(--sw-mono); font-size: 10.5px;
  color: var(--sw-fg-1); background: var(--sw-bg-2);
  padding: 2px 6px; border-radius: 3px;
}
.ot__none { color: var(--sw-fg-3); }

.ot__actions { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
.ot__flash { font-size: 11px; color: var(--sw-ok); margin-right: auto; }
.ot__dirty { font-size: 11px; color: var(--sw-warn); margin-right: auto; }
.ot__clean { font-size: 11px; color: var(--sw-fg-3); margin-right: auto; }
.ot__btn {
  background: var(--sw-bg-1); border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-0); font: inherit; font-size: 12px;
  padding: 6px 14px; border-radius: 4px; cursor: pointer;
}
.ot__btn:not(:disabled):hover { background: var(--sw-bg-2); }
.ot__btn:disabled { opacity: 0.4; cursor: not-allowed; }
.ot__btn--primary {
  background: var(--sw-accent); border-color: var(--sw-accent);
  color: #0a0d12; font-weight: 600;
}
.ot__btn--primary:not(:disabled):hover { background: var(--sw-accent-light, #fb923c); }
</style>
