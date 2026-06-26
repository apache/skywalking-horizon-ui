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
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Icon from '@/components/icons/Icon.vue';
import { useAutoRefreshStore } from '@/controls/autoRefresh';
import { useTopbarTimeContext } from '@/shell/useTopbarTimeContext';

const { t } = useI18n({ useScope: 'global' });
const { ownsTimeRange, noTimeContext, hasFrozenRange, autoSuspended } = useTopbarTimeContext();

/**
 * Auto-refresh: store drives the ticker; the topbar drives the UI
 * (countdown + spinning icon + interval dropdown). When the operator
 * lands on an opt-out route the ticker suspends; on leaving the
 * route it resumes + fires one immediate tick so the underlying page
 * gets fresh data right away.
 */
const auto = useAutoRefreshStore();
watch(
  autoSuspended,
  (now) => {
    if (now) auto.suspend();
    else auto.resume();
  },
  { immediate: true },
);

const REFRESH_PRESETS: Array<{ label: string; sec: number | null }> = [
  { label: 'Off', sec: null },
  { label: '5s', sec: 5 },
  { label: '15s', sec: 15 },
  { label: '30s', sec: 30 },
  { label: '1m', sec: 60 },
  { label: '5m', sec: 300 },
];
const refreshMenuOpen = ref(false);
const refreshClusterEl = ref<HTMLElement | null>(null);
function pickRefresh(sec: number | null): void {
  auto.setInterval(sec);
  refreshMenuOpen.value = false;
}
function onWindowClickClose(ev: MouseEvent): void {
  if (!refreshMenuOpen.value) return;
  const el = refreshClusterEl.value;
  if (el && !el.contains(ev.target as Node)) {
    refreshMenuOpen.value = false;
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('click', onWindowClickClose);
}
onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('click', onWindowClickClose);
  }
});
const refreshLabel = computed<string>(() => {
  if (autoSuspended.value) return t('Paused');
  if (auto.intervalSec === null) return t('Off');
  if (auto.secondsUntilNext === null) return '—';
  return `${auto.secondsUntilNext}s`;
});
const refreshTooltip = computed<string>(() => {
  if (noTimeContext.value) return t('Auto-refresh is off on config / operate pages');
  if (ownsTimeRange.value) return t('Auto-refresh paused on this page');
  if (hasFrozenRange.value) return t('Auto-refresh paused while a custom time range is selected');
  if (auto.intervalSec === null) return t('Auto-refresh off · click to refresh now');
  return t(
    'Auto-refresh every {seconds}s · {remaining}s remaining · click to refresh now',
    { seconds: auto.intervalSec, remaining: auto.secondsUntilNext ?? '—' },
  );
});
</script>

<template>
  <div ref="refreshClusterEl" class="refresh-cluster" :class="{ 'is-disabled': ownsTimeRange }">
    <button
      type="button"
      class="sw-btn is-icon refresh-now"
      :class="{ spinning: auto.effectiveEnabled }"
      :title="refreshTooltip"
      :disabled="ownsTimeRange"
      @click="auto.refreshNow()"
    ><Icon name="refresh" :size="12" /></button>
    <span class="refresh-countdown mono" :title="refreshTooltip">{{ refreshLabel }}</span>
    <button
      type="button"
      class="sw-btn refresh-caret"
      :title="'Pick refresh interval'"
      :disabled="ownsTimeRange"
      @click="refreshMenuOpen = !refreshMenuOpen"
    ><Icon name="caret" :size="10" /></button>
    <transition name="rf-menu">
      <ul v-if="refreshMenuOpen" class="rf-menu">
        <li
          v-for="p in REFRESH_PRESETS"
          :key="String(p.sec)"
          :class="{ on: auto.intervalSec === p.sec }"
          @click="pickRefresh(p.sec)"
        >{{ p.label }}</li>
      </ul>
    </transition>
  </div>
</template>

<style scoped>
/* Disabled state when the current page owns its own time range. Greys
   out without removing the chip so the operator still sees the
   affordance + tooltip. */
.refresh-cluster.is-disabled {
  opacity: 0.45;
  filter: grayscale(0.6);
}

.refresh-cluster {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.refresh-now {
  cursor: pointer;
}
.refresh-now.spinning :deep(svg) {
  animation: refresh-spin 1.6s linear infinite;
  transform-origin: 50% 50%;
}
@keyframes refresh-spin {
  to { transform: rotate(360deg); }
}
.refresh-countdown {
  font-size: 10.5px;
  color: var(--sw-fg-2);
  min-width: 28px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.refresh-caret {
  cursor: pointer;
  padding: 0 4px;
  min-width: auto;
}
.rf-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  list-style: none;
  padding: 4px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  min-width: 96px;
  z-index: 10;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
}
.rf-menu li {
  padding: 4px 10px;
  font-size: 11px;
  color: var(--sw-fg-1);
  cursor: pointer;
  border-radius: 4px;
  font-variant-numeric: tabular-nums;
}
.rf-menu li:hover { background: var(--sw-bg-2); }
.rf-menu li.on { background: var(--sw-accent-soft); color: var(--sw-accent-2); font-weight: 600; }
.rf-menu-enter-from, .rf-menu-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
.rf-menu-enter-active, .rf-menu-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
</style>
