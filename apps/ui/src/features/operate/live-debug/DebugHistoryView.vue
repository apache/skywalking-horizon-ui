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
 * Cross-DSL capture history. Lists every locally-saved debug session
 * (MAL / LAL / OAL) from `useDebugHistory`, sorted newest first, with
 * a per-widget filter chip-row.
 *
 * Loading an entry deep-links into the matching debugger via
 * `/operate/live-debug/{widget}?historyId=<id>` — the per-DSL view picks the id off
 * the route on mount and hands it to its `loadHistorical(entry)`.
 * That keeps the storage logic centralised here while the rendering
 * stays in the DSL views that already understand each shape.
 */
import { computed, onScopeDispose, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  isActive,
  useDebugHistory,
  type DebugWidget,
  type HistoryEntry,
} from '@/features/operate/live-debug/useDebugHistory';
import Pill from '@/components/primitives/Pill.vue';

const router = useRouter();
/* The composable's `widget` arg only filters `entries`; `all` returns
 * everything. We bind to MAL arbitrarily and use `all` for the table. */
const history = useDebugHistory('mal');

type WidgetFilter = 'all' | DebugWidget;
const filter = ref<WidgetFilter>('all');

const filteredEntries = computed<HistoryEntry[]>(() => {
  const all = history.all.value;
  return filter.value === 'all' ? all : all.filter((e) => e.widget === filter.value);
});

/** Tick once per second so countdowns / active-vs-completed flips
 *  re-render. Cheap — Vue only diffs the changed text nodes. */
const nowMs = ref<number>(Date.now());
const tick = setInterval(() => {
  nowMs.value = Date.now();
}, 1000);
onScopeDispose(() => clearInterval(tick));

const activeEntries = computed<HistoryEntry[]>(() =>
  filteredEntries.value.filter((e) => isActive(e, nowMs.value)),
);
const completedEntries = computed<HistoryEntry[]>(() =>
  filteredEntries.value.filter((e) => !isActive(e, nowMs.value)),
);

function countdown(deadline: number | undefined): string {
  if (deadline === undefined) return '';
  const remaining = Math.max(0, deadline - nowMs.value);
  if (remaining === 0) return 'expired';
  const totalSec = Math.floor(remaining / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

const counts = computed(() => {
  const c: Record<WidgetFilter, number> = { all: 0, mal: 0, lal: 0, oal: 0 };
  for (const e of history.all.value) {
    c.all += 1;
    c[e.widget] += 1;
  }
  return c;
});

const widgetTone: Record<DebugWidget, 'info' | 'warn' | 'ok'> = {
  mal: 'info',
  lal: 'warn',
  oal: 'ok',
};

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Active entries route through `?resumeSessionId=` so the per-DSL
 *  view attaches polling to the live OAP session (you keep getting
 *  updates as records arrive). Completed entries route through
 *  `?historyId=` for read-only replay of the captured snapshot. */
function loadEntry(entry: HistoryEntry): void {
  if (isActive(entry, nowMs.value)) {
    void router.push({
      path: `/operate/live-debug/${entry.widget}`,
      query: { resumeSessionId: entry.session.sessionId },
    });
  } else {
    void router.push({
      path: `/operate/live-debug/${entry.widget}`,
      query: { historyId: entry.id },
    });
  }
}

function deleteEntry(id: string): void {
  history.remove(id);
}

function clearAll(): void {
  if (typeof window !== 'undefined' && !window.confirm('delete all saved captures?')) return;
  // history.clear() only nukes the bound widget; iterate to wipe all.
  for (const e of [...history.all.value]) {
    history.remove(e.id);
  }
}
</script>

<template>
  <div class="dh">
    <header class="dh__h">
      <div>
        <h1 class="dh__title">capture history</h1>
        <p class="dh__sub">
          past debug sessions captured locally in this browser. nothing
          leaves your machine; entries cap at 20 per browser, oldest first.
        </p>
      </div>
      <button
        v-if="history.all.value.length > 0"
        type="button"
        class="dh__clearall"
        @click="clearAll"
      >clear all</button>
    </header>

    <div class="dh__filters">
      <button
        v-for="key in (['all', 'mal', 'lal', 'oal'] as const)"
        :key="key"
        type="button"
        class="dh__filterchip"
        :class="{ 'dh__filterchip--active': filter === key }"
        @click="filter = key"
      >
        {{ key }} <span class="dh__filterct">{{ counts[key] }}</span>
      </button>
    </div>

    <div v-if="filteredEntries.length === 0" class="dh__empty">
      <template v-if="history.all.value.length === 0">
        no saved captures yet — run a session in the
        <router-link to="/operate/live-debug">live debugger</router-link>; finished
        sessions auto-save here.
      </template>
      <template v-else>
        no captures match this filter.
      </template>
    </div>

    <template v-else>
      <section v-if="activeEntries.length > 0" class="dh__section">
        <header class="dh__sectionh">
          <span class="dh__sectiontitle">active</span>
          <span class="dh__sectionct">{{ activeEntries.length }} ongoing</span>
        </header>
        <ul class="dh__list">
          <li
            v-for="entry in activeEntries"
            :key="entry.id"
            class="dh__item dh__item--active"
          >
            <div class="dh__col dh__col--meta">
              <Pill :tone="widgetTone[entry.widget]">{{ entry.widget }}</Pill>
              <span class="dh__active">live</span>
              <span class="dh__time">{{ formatDateTime(entry.savedAt) }}</span>
            </div>
            <div class="dh__col dh__col--rule">
              <div class="dh__rulekey">
                <code class="dh__cat">{{ entry.catalog }}</code>
                <span class="dh__sep">·</span>
                <code class="dh__name">{{ entry.name }}</code>
                <span class="dh__sep">·</span>
                <code class="dh__metric">{{ entry.ruleName }}</code>
              </div>
              <div class="dh__counts">
                {{ entry.recordCount }} records · {{ entry.nodeCount }} nodes
                <template v-if="entry.granularity">· {{ entry.granularity }}</template>
                <template v-if="entry.recordCap">· cap {{ entry.recordCap }}</template>
                · ends in <span class="dh__countdown">{{ countdown(entry.retentionDeadline) }}</span>
              </div>
            </div>
            <div class="dh__col dh__col--actions">
              <button type="button" class="dh__load dh__load--resume" @click="loadEntry(entry)">resume →</button>
              <button
                type="button"
                class="dh__del"
                title="delete this entry (does not stop the OAP session)"
                @click="deleteEntry(entry.id)"
              >×</button>
            </div>
          </li>
        </ul>
      </section>

      <section v-if="completedEntries.length > 0" class="dh__section">
        <header v-if="activeEntries.length > 0" class="dh__sectionh">
          <span class="dh__sectiontitle">completed</span>
          <span class="dh__sectionct">{{ completedEntries.length }} finished</span>
        </header>
        <ul class="dh__list">
          <li v-for="entry in completedEntries" :key="entry.id" class="dh__item">
            <div class="dh__col dh__col--meta">
              <Pill :tone="widgetTone[entry.widget]">{{ entry.widget }}</Pill>
              <span class="dh__time">{{ formatDateTime(entry.savedAt) }}</span>
            </div>
            <div class="dh__col dh__col--rule">
              <div class="dh__rulekey">
                <code class="dh__cat">{{ entry.catalog }}</code>
                <span class="dh__sep">·</span>
                <code class="dh__name">{{ entry.name }}</code>
                <span class="dh__sep">·</span>
                <code class="dh__metric">{{ entry.ruleName }}</code>
              </div>
              <div class="dh__counts">
                {{ entry.recordCount }} records · {{ entry.nodeCount }} nodes
                <template v-if="entry.granularity">· {{ entry.granularity }}</template>
                <template v-if="entry.recordCap">· cap {{ entry.recordCap }}</template>
              </div>
            </div>
            <div class="dh__col dh__col--actions">
              <button type="button" class="dh__load" @click="loadEntry(entry)">load →</button>
              <button
                type="button"
                class="dh__del"
                title="delete this entry"
                @click="deleteEntry(entry.id)"
              >×</button>
            </div>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.dh {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 22px 26px;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.dh__h {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}

.dh__title {
  margin: 0 0 4px;
  font-family: var(--rr-font-mono);
  font-size: 14px;
  font-weight: 500;
  color: var(--rr-heading);
  letter-spacing: 0.4px;
}

.dh__sub {
  margin: 0;
  font-size: 11.5px;
  color: var(--rr-dim);
  max-width: 640px;
  line-height: 1.5;
}

.dh__clearall {
  margin-left: auto;
  background: transparent;
  border: 1px solid var(--rr-warn, #d6a96d);
  color: var(--rr-warn, #d6a96d);
  font-family: var(--rr-font-mono);
  font-size: 11px;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  padding: 4px 12px;
  cursor: pointer;
}

.dh__clearall:hover {
  background: var(--rr-bg2);
}

.dh__filters {
  display: flex;
  gap: 6px;
}

.dh__filterchip {
  background: transparent;
  border: 1px solid var(--rr-border);
  color: var(--rr-ink2);
  font-family: var(--rr-font-mono);
  font-size: 12px;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  padding: 4px 12px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.dh__filterchip:hover {
  border-color: var(--rr-ink2);
  color: var(--rr-heading);
}

.dh__filterchip--active {
  background: var(--rr-bg3);
  border-color: var(--rr-accent, var(--rr-active));
  color: var(--rr-heading);
}

.dh__filterct {
  font-size: 10.5px;
  color: var(--rr-dim);
}

.dh__filterchip--active .dh__filterct {
  color: var(--rr-accent, var(--rr-active));
}

.dh__empty {
  padding: 24px;
  font-size: 11.5px;
  color: var(--rr-dim);
  font-style: italic;
  border: 1px dashed var(--rr-border);
  text-align: center;
}

.dh__empty a {
  color: var(--rr-accent, var(--rr-active));
}

.dh__section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dh__sectionh {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-family: var(--rr-font-mono);
  font-size: 11px;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--rr-dim);
}

.dh__sectiontitle {
  color: var(--rr-heading);
}

.dh__sectionct {
  font-size: 10.5px;
}

.dh__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--rr-border);
}

.dh__item--active {
  border-left: 3px solid var(--rr-accent, var(--rr-active));
}

.dh__active {
  font-family: var(--rr-font-mono);
  font-size: 10px;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  padding: 2px 6px;
  background: rgba(78, 201, 176, 0.12);
  color: var(--rr-ok, #4ec9b0);
  border: 1px solid var(--rr-ok, #4ec9b0);
}

.dh__countdown {
  color: var(--rr-accent, var(--rr-active));
  font-weight: 600;
}

.dh__load--resume {
  border-color: var(--rr-ok, #4ec9b0);
  color: var(--rr-ok, #4ec9b0);
}

.dh__item {
  display: grid;
  grid-template-columns: 200px 1fr max-content;
  gap: 16px;
  padding: 12px 14px;
  background: var(--rr-bg);
  border-bottom: 1px solid var(--rr-border);
  align-items: center;
}

.dh__item:last-child {
  border-bottom: none;
}

.dh__item:hover {
  background: var(--rr-bg2);
}

.dh__col {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.dh__col--meta {
  flex-direction: row;
  align-items: center;
  gap: 10px;
}

.dh__col--actions {
  flex-direction: row;
  align-items: center;
  gap: 4px;
}

.dh__time {
  font-family: var(--rr-font-mono);
  font-size: 12px;
  color: var(--rr-dim);
  white-space: nowrap;
}

.dh__rulekey {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
  font-family: var(--rr-font-mono);
  font-size: 11.5px;
}

.dh__rulekey code {
  font-family: var(--rr-font-mono);
  background: transparent;
  padding: 0;
}

.dh__cat {
  color: var(--rr-dim);
}

.dh__name {
  color: var(--rr-ink2);
}

.dh__metric {
  color: var(--rr-accent, var(--rr-active));
}

.dh__sep {
  color: var(--rr-border);
}

.dh__counts {
  font-family: var(--rr-font-mono);
  font-size: 11px;
  color: var(--rr-dim);
}

.dh__load {
  background: transparent;
  border: 1px solid var(--rr-accent, var(--rr-active));
  color: var(--rr-accent, var(--rr-active));
  font-family: var(--rr-font-mono);
  font-size: 11px;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  padding: 4px 12px;
  cursor: pointer;
}

.dh__load:hover {
  background: var(--rr-bg3);
}

.dh__del {
  width: 30px;
  height: 26px;
  background: transparent;
  border: 1px solid var(--rr-border);
  color: var(--rr-dim);
  font-size: 13px;
  cursor: pointer;
}

.dh__del:hover {
  color: var(--rr-warn, #d6a96d);
  border-color: var(--rr-warn, #d6a96d);
}
</style>
