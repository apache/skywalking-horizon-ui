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
import { useIsFetching } from '@tanstack/vue-query';
import { useAutoRefreshStore } from '@/controls/autoRefresh';
import RefreshErrorPanel from '@/controls/RefreshErrorPanel.vue';
import { useTopbarTimeContext } from '@/shell/useTopbarTimeContext';

const { t } = useI18n({ useScope: 'global' });
const { ownsTimeRange, noTimeContext, hasFrozenRange, autoSuspended } = useTopbarTimeContext();

/**
 * Auto-refresh: store drives the ticker; the topbar drives the UI
 * (countdown + fetching indicator + interval dropdown). When the operator
 * lands on an opt-out route the ticker suspends; on leaving the
 * route it resumes + fires one immediate tick so the underlying page
 * gets fresh data right away.
 */
const auto = useAutoRefreshStore();

/**
 * Is anything loading RIGHT NOW — a different fact from "when is the next
 * round", and shown separately.
 *
 * The icon used to spin on `effectiveEnabled`, which meant "auto-refresh is
 * on": it span continuously while enabled, so it read as perpetual loading and
 * told the operator nothing. This is the app-wide in-flight count, so the
 * indicator is live exactly while requests are outstanding — including a
 * manual refresh, and including pages that fetch without the ticker.
 */
const inFlight = useIsFetching();
const fetching = computed(() => inFlight.value > 0);
/**
 * A round is out, so the button is not a button.
 *
 * Clicking during a round can only produce a trailing round — which the store
 * would coalesce anyway — while LOOKING like it did nothing. Disabling says
 * so, and `aria-busy` says it to a screen reader too.
 */
const roundOut = computed(() => auto.roundRunning);
watch(
  autoSuspended,
  (now) => {
    if (now) auto.suspend();
    else auto.resume();
  },
  { immediate: true },
);

// No "Off" among the cadences: off is the toggle's job, and conflating the two
// is what lost the chosen cadence — `null` meant both "disabled" and "no
// interval", so switching back on had nothing to return to.
const REFRESH_PRESETS: Array<{ label: string; sec: number }> = [
  { label: '5s', sec: 5 },
  { label: '15s', sec: 15 },
  { label: '30s', sec: 30 },
  { label: '1m', sec: 60 },
  { label: '5m', sec: 300 },
];
const refreshMenuOpen = ref(false);
const refreshClusterEl = ref<HTMLElement | null>(null);
function pickRefresh(sec: number): void {
  auto.setInterval(sec);
  refreshMenuOpen.value = false;
}
function toggleAuto(): void {
  auto.toggleEnabled();
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
  // A round in flight comes first: it is the only state where there is
  // genuinely no next-round instant to name, and saying so beats a number the
  // page cannot honour.
  if (roundOut.value) return t('Refreshing');
  if (autoSuspended.value) return t('Paused');
  if (!auto.enabled) return t('Off');
  if (auto.secondsUntilNext === null) return '—';
  return `${auto.secondsUntilNext}s`;
});
const refreshTooltip = computed<string>(() => {
  if (noTimeContext.value) return t('Auto-refresh is off on config / operate pages');
  if (ownsTimeRange.value) return t('Auto-refresh paused on this page');
  if (hasFrozenRange.value) return t('Auto-refresh paused while a custom time range is selected');
  if (!auto.enabled) return t('Auto-refresh off · click to refresh now');
  return t(
    'Auto-refresh every {seconds}s · {remaining}s remaining · click to refresh now',
    { seconds: auto.intervalSec, remaining: auto.secondsUntilNext ?? '—' },
  );
});
</script>

<template>
  <div ref="refreshClusterEl" class="refresh-cluster" :class="{ 'is-disabled': ownsTimeRange }">
    <!-- Beside the refresh control, and only once something has failed: the
         history is the refresh's own, and an empty one is not worth a slot. -->
    <RefreshErrorPanel />
    <button
      type="button"
      class="sw-btn is-icon refresh-now"
      :class="{ fetching }"
      :title="fetching ? t('Loading…') : refreshTooltip"
      :disabled="ownsTimeRange || roundOut"
      :aria-busy="roundOut ? 'true' : 'false'"
      @click="auto.refreshNow()"
    ><Icon :name="fetching ? 'download' : 'refresh'" :size="12" /></button>
    <span class="refresh-countdown mono" :title="refreshTooltip">{{ refreshLabel }}</span>
    <button
      type="button"
      class="sw-btn refresh-caret"
      :title="t('Pick refresh interval')"
      @click="refreshMenuOpen = !refreshMenuOpen"
    ><Icon name="caret" :size="10" /></button>
    <transition name="rf-menu">
      <ul v-if="refreshMenuOpen" class="rf-menu">
        <!-- The switch, kept apart from the cadences: turning auto-refresh off
             must not discard which cadence was chosen, and turning it back on
             returns to it. -->
        <li class="rf-toggle" :class="{ on: auto.enabled }" @click="toggleAuto">
          {{ auto.enabled ? t('Turn auto-refresh off') : t('Turn auto-refresh on') }}
        </li>
        <li
          v-for="p in REFRESH_PRESETS"
          :key="String(p.sec)"
          :class="{ on: auto.enabled && auto.intervalSec === p.sec }"
          @click="pickRefresh(p.sec)"
        >{{ p.label }}</li>
      </ul>
    </transition>
  </div>
</template>

<style scoped>
/* A page that owns its time range: the refresh ACTION does not apply, so it
   greys — but the cadence menu stays live and at full contrast, because
   choosing how often to refresh is a preference that outlives this page. */
.refresh-cluster.is-disabled .refresh-now,
.refresh-cluster.is-disabled .refresh-countdown {
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
/* In flight: the refresh circle becomes a download arrow, in the accent
   colour. The countdown keeps showing its number — the two answer different
   questions, and blanking one to say something about the other is what the
   split exists to stop. Nudged rather than spun: an arrow that rotates reads
   as "busy", an arrow that moves down reads as "arriving". */
.refresh-now.fetching :deep(svg) {
  color: var(--sw-accent);
  animation: refresh-arrive 1s ease-in infinite;
}
/* Reads as ARRIVING, not as busy: the arrow falls, fades out at the floor, and
   re-enters from above — the cadence of a download rather than the spin of a
   generic wait. The whole glyph moves, baseline included; at 12px that is a
   nudge, and splitting the path to hold the baseline still would cost a
   one-off icon, which this project does not do. */
@keyframes refresh-arrive {
  0%   { transform: translateY(-2.5px); opacity: 0.25; }
  30%  { transform: translateY(0);      opacity: 1; }
  70%  { transform: translateY(2.5px);  opacity: 0; }
  71%  { transform: translateY(-2.5px); opacity: 0; }
  100% { transform: translateY(-2.5px); opacity: 0.25; }
}
@media (prefers-reduced-motion: reduce) {
  /* Still unmistakably in-flight, without motion: the arrow holds, in accent. */
  .refresh-now.fetching :deep(svg) { animation: none; }
}
.rf-menu .rf-toggle {
  border-bottom: 1px solid var(--sw-border);
  color: var(--sw-fg-2);
}
.rf-menu .rf-toggle.on {
  color: var(--sw-fg-1);
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
