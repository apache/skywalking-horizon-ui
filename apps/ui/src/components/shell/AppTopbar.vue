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
import { computed, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import Icon from '@/components/icons/Icon.vue';
import { useOapInfo } from '@/composables/useOapInfo';
import { useAutoRefreshStore } from '@/stores/autoRefresh';

const route = useRoute();

// Trivial breadcrumb derivation from the path. Real breadcrumb metadata
// lands when individual views start setting `route.meta.breadcrumbs`.
const crumbs = computed<string[]>(() => {
  const segs = route.path.split('/').filter(Boolean);
  if (segs.length === 0) return ['Home'];
  return segs.map((s) => s.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()));
});

const { info, reachable, version, tzOffsetLabel, healthState } = useOapInfo();

const oapChipTooltip = computed<string>(() => {
  if (!info.value) return 'OAP status — loading…';
  if (!reachable.value) {
    return `OAP unreachable: ${info.value.error ?? 'no response'}\nFix the upstream and the pill turns green.`;
  }
  const parts: string[] = [];
  if (info.value.version) parts.push(`Version ${info.value.version}`);
  if (tzOffsetLabel.value) parts.push(`Server TZ ${tzOffsetLabel.value}`);
  if (info.value.currentTimestamp) {
    parts.push(`Server clock ${new Date(info.value.currentTimestamp).toLocaleString()} (your local time)`);
  }
  if (info.value.healthScore !== undefined) {
    parts.push(`Health score ${info.value.healthScore} — ${info.value.healthDetails ?? '(no details)'}`);
  }
  return parts.join('\n');
});

const localTzLabel = computed<string>(() => {
  const offMin = -new Date().getTimezoneOffset(); // browser returns inverted sign
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(m).padStart(2, '0')}`;
});

// True when the user's browser is in a different TZ than the OAP server.
// Time-range queries get converted server-side; the chip flags the gap
// so the operator knows the displayed local time will differ from the
// server's log timestamps.
const { timezone: serverTzMin } = useOapInfo();
const tzMismatch = computed<boolean>(() => {
  if (serverTzMin.value === undefined) return false;
  const browserMin = -new Date().getTimezoneOffset();
  return browserMin !== serverTzMin.value;
});

/**
 * Routes that own their own time range — the global topbar picker +
 * refresh button get disabled (greyed + non-clickable) so the
 * operator knows the page's local picker is the source of truth.
 *
 * Add more routes here as Logs / Traces / etc. each opt out of the
 * global rolling window in favour of a per-page picker.
 */
const TIME_RANGE_OPT_OUT = [
  /^\/layer\/[^/]+\/trace$/,
  // Logs run their own time window the same way traces do — the page
  // carries an explicit time picker (the condition bar), and the level
  // / keyword filters make rolling-window refresh awkward when the
  // operator is mid-investigation. Block the global picker + pause the
  // auto-refresher whenever the operator is on a Logs tab.
  /^\/layer\/[^/]+\/logs$/,
];
const ownsTimeRange = computed<boolean>(() => TIME_RANGE_OPT_OUT.some((r) => r.test(route.path)));
const globalTimeTooltip = computed<string>(() => {
  if (ownsTimeRange.value) {
    return 'This page uses its own time range — disable the page picker to use the global one.';
  }
  return `Browser local time · ${localTzLabel.value}`;
});

/**
 * Auto-refresh: store drives the ticker; the topbar drives the UI
 * (countdown + spinning icon + interval dropdown). When the operator
 * lands on an opt-out route the ticker suspends; on leaving the
 * route it resumes + fires one immediate tick so the underlying page
 * gets fresh data right away.
 */
const auto = useAutoRefreshStore();
watch(
  ownsTimeRange,
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
const refreshLabel = computed<string>(() => {
  if (ownsTimeRange.value) return 'Paused';
  if (auto.intervalSec === null) return 'Off';
  if (auto.secondsUntilNext === null) return '—';
  return `${auto.secondsUntilNext}s`;
});
const refreshTooltip = computed<string>(() => {
  if (ownsTimeRange.value) return 'Auto-refresh paused on this page';
  if (auto.intervalSec === null) return 'Auto-refresh off · click to refresh now';
  return `Auto-refresh every ${auto.intervalSec}s · ${auto.secondsUntilNext ?? '—'}s remaining · click to refresh now`;
});
</script>

<template>
  <header class="sw-top">
    <div class="sw-crumbs">
      <template v-for="(c, i) in crumbs" :key="i">
        <Icon v-if="i > 0" name="chev" :size="10" />
        <b v-if="i === crumbs.length - 1">{{ c }}</b>
        <span v-else>{{ c }}</span>
      </template>
    </div>
    <div class="sw-top-search">
      <Icon name="search" :size="12" />
      <span>Search services, endpoints, traceId&hellip;</span>
      <kbd>⌘K</kbd>
    </div>
    <div class="sw-top-actions">
      <RouterLink class="sw-btn oap-chip" :class="`is-${healthState}`" :title="oapChipTooltip" to="/operate/cluster">
        <span class="dot" />
        <span v-if="reachable && version" class="ver">v{{ version }}</span>
        <span v-else-if="reachable" class="ver">OAP</span>
        <span v-else class="ver">offline</span>
        <span v-if="reachable && tzOffsetLabel" class="tz" :class="{ mismatch: tzMismatch }">
          {{ tzOffsetLabel }}
        </span>
      </RouterLink>
      <div class="sw-btn" :class="{ 'is-disabled': ownsTimeRange }" :title="globalTimeTooltip">
        <Icon name="clock" :size="12" />
        <span>{{ ownsTimeRange ? 'Page time range' : 'Last 60 minutes' }}</span>
        <Icon name="caret" :size="10" />
      </div>
      <!-- Auto-refresh cluster: countdown + spinning button on the
           left, dropdown caret on the right. Click the icon to
           refresh now; click the caret to pick an interval. -->
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
      <div class="sw-btn is-icon"><Icon name="bell" :size="12" /></div>
    </div>
  </header>
</template>

<style scoped>
/* Disabled state for global time-range / refresh chips when the
   current page owns its own time range. Greys out without removing
   the chip so the operator still sees the affordance + tooltip. */
.sw-btn.is-disabled {
  opacity: 0.45;
  pointer-events: none;
  filter: grayscale(0.6);
}

/* Auto-refresh cluster */
.refresh-cluster {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.refresh-cluster.is-disabled {
  opacity: 0.45;
  filter: grayscale(0.6);
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
.oap-chip {
  text-decoration: none;
  font-family: var(--sw-mono);
  font-variant-numeric: tabular-nums;
  font-size: 10.5px;
  gap: 6px;
}
.oap-chip .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  display: inline-block;
}
.oap-chip.is-ok .dot {
  background: var(--sw-ok);
  box-shadow: 0 0 6px 0 rgba(34, 197, 94, 0.55);
}
.oap-chip.is-warn .dot {
  background: var(--sw-warn);
}
.oap-chip.is-err .dot {
  background: var(--sw-err);
  animation: pulse-err 1.6s infinite;
}
.oap-chip.is-unknown .dot {
  background: var(--sw-fg-3);
}
.oap-chip .ver {
  color: var(--sw-fg-0);
  font-weight: 600;
}
.oap-chip .tz {
  color: var(--sw-fg-2);
  padding-left: 4px;
  border-left: 1px solid var(--sw-line-2);
}
.oap-chip .tz.mismatch {
  color: var(--sw-warn);
}
@keyframes pulse-err {
  0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.6); }
  70% { box-shadow: 0 0 0 6px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
</style>
