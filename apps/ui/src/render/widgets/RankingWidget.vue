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
  A layer's services ranked by one metric over the picked range, busiest
  first: a row per service with its value and a bar against the top value,
  in two columns once the list passes five rows. The rows come from the
  landing read the overview composable makes for the widget; the card only
  lays them out.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { formatValue } from './ValueFormat';
import { rankingLayout, type RankingRow } from './ranking';
import WidgetTip from '@/components/primitives/WidgetTip.vue';

const props = defineProps<{
  title: string;
  tip?: string;
  /** Layer key — clicking the card opens the layer's Service page. */
  layer?: string;
  unit?: string;
  /** Busiest first; absent while the first read is out. */
  rows?: RankingRow[];
  /** The layer's service count, so the card can say how many it lists. */
  total?: number;
  /** The read that would have brought the rows failed, so an empty card is a failure, not a wait. */
  failed?: boolean;
}>();

const { t } = useI18n();

const tileTo = computed(() => (props.layer ? `/layer/${props.layer.toLowerCase()}/service` : ''));
// The list is measured so the rows can split into as many columns as its
// height calls for; until measured, a column is taken to hold five.
const ROW_PITCH = 26;
const listEl = ref<HTMLElement | null>(null);
const fit = ref(5);
let observer: ResizeObserver | null = null;
watch(listEl, (el, old) => {
  if (typeof ResizeObserver === 'undefined') return;
  observer ??= new ResizeObserver((entries) => {
    const h = entries[0]?.contentRect.height ?? 0;
    if (h > 0) fit.value = Math.max(1, Math.floor((h + 4) / ROW_PITCH));
  });
  if (old) observer.unobserve(old);
  if (el) observer.observe(el);
});
onBeforeUnmount(() => observer?.disconnect());
const layout = computed(() => rankingLayout(props.rows?.length ?? 0, fit.value));
const columns = computed(() => layout.value.columns);
const perColumn = computed(() => layout.value.perColumn);
const top = computed(() => Math.max(0, ...(props.rows ?? []).map((r) => r.value ?? 0)));
const subset = computed(() =>
  props.rows && props.total !== undefined && props.total > props.rows.length
    ? { shown: props.rows.length, total: props.total }
    : null,
);

function barWidth(v: number | null): string {
  if (v === null || !Number.isFinite(v) || top.value <= 0) return '0%';
  return `${Math.max(0, Math.min(100, (v / top.value) * 100)).toFixed(1)}%`;
}
</script>

<template>
  <component :is="tileTo ? RouterLink : 'div'" :to="tileTo || undefined" class="tile-link">
    <section class="sw-card rk">
      <header>
        <h4>{{ title }}</h4>
        <WidgetTip :tip="tip" />
        <span v-if="subset" class="note">{{ t('The {shown} busiest of {total} services.', subset) }}</span>
      </header>
      <div v-if="!rows && failed" class="empty">{{ t('Could not read {title}.', { title }) }}</div>
      <div v-else-if="!rows" class="empty">{{ t('Reading data…') }}</div>
      <div v-else-if="rows.length === 0" class="empty">{{ t('No services reported in this range.') }}</div>
      <ol v-else ref="listEl" class="list" :style="{ '--cols': columns, '--per': perColumn }">
        <li v-for="(r, i) in rows" :key="r.serviceId" class="row">
          <span class="rank">{{ i + 1 }}</span>
          <span class="name" :title="r.name">{{ r.name }}</span>
          <span class="value">{{ formatValue(r.value, unit) }}</span>
          <span class="bar"><span class="fill" :style="{ width: barWidth(r.value) }" /></span>
        </li>
      </ol>
    </section>
  </component>
</template>

<style scoped>
.tile-link { display: block; text-decoration: none; color: inherit; height: 100%; }
.tile-link:hover .sw-card { border-color: var(--sw-line-3); }
.rk { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; height: 100%; min-height: 0; }
header { display: flex; align-items: center; gap: 6px; }
h4 { margin: 0; font-size: 12px; font-weight: 600; color: var(--sw-fg-0); }
.note { margin-left: auto; font-size: 10px; color: var(--sw-fg-3); white-space: nowrap; }
.empty { padding: 14px 8px; font-size: 11px; font-style: italic; color: var(--sw-fg-3); text-align: center; }
/* Down then across: the first column holds ranks 1..per, the second the rest. */
.list {
  display: grid;
  grid-auto-flow: column;
  grid-template-rows: repeat(var(--per), auto);
  grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
  column-gap: 18px;
  row-gap: 4px;
  flex: 1;
  margin: 0;
  padding: 0;
  list-style: none;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  align-content: start;
}
.row {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  grid-template-areas: 'rank name value' 'rank bar bar';
  column-gap: 8px;
  row-gap: 2px;
  align-items: center;
  height: 22px;
}
.rank { grid-area: rank; font-size: 10px; font-weight: 600; color: var(--sw-fg-3); text-align: right; }
.name { grid-area: name; font-size: 12px; color: var(--sw-fg-0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.value { grid-area: value; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--sw-fg-0); }
.bar { grid-area: bar; display: block; height: 3px; border-radius: 2px; background: var(--sw-bg-3); overflow: hidden; }
.fill { display: block; height: 100%; border-radius: 2px; background: var(--sw-accent); }
</style>
