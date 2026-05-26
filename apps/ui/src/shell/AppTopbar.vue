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
import { useI18n } from 'vue-i18n';
import Icon from '@/components/icons/Icon.vue';
import LocaleChip from '@/shell/LocaleChip.vue';
import { useQueryClient } from '@tanstack/vue-query';
import { useOapInfo } from '@/shell/useOapInfo';
import { useAlarmCount } from '@/shell/useAlarmCount';
import { useAutoRefreshStore } from '@/controls/autoRefresh';
import { useColdStageStore } from '@/controls/coldStage';
import { useTimeRangeStore, TIME_PRESETS, STEP_LIMITS, isValidRange, type TimeStep } from '@/controls/timeRange';
import { useThemeStore, AVAILABLE_THEMES, type ThemeId } from '@/state/theme';
import { useAuthStore } from '@/state/auth';
import { useTimeDefaultsStore } from '@/state/timeDefaults';
import { useSidebar } from '@/controls/sidebar';
import logoSw from '@/assets/icons/logo-sw.svg?raw';

// When the sidebar is folded its wordmark is hidden; surface the brand
// (logo + name) here in the topbar's left zone instead.
const { collapsed: sidebarCollapsed } = useSidebar();
const logoSwBlue = logoSw.replace(/fill="#fff"/g, 'fill="#1368B3"');

// Per-user "Save as my default" / "Reset to org default" on the time
// picker. The org default is what the admin set on
// /admin/global-defaults (3-tier: localStorage → OAP → bundled 60m).
const timeDefaultsStore = useTimeDefaultsStore();
function saveCurrentAsMyTimeDefault(): void {
  const dur = timeRange.preset?.durationMs;
  if (!dur || !Number.isFinite(dur)) return;
  const minutes = Math.max(1, Math.round(dur / 60_000));
  timeDefaultsStore.setUserOverride(minutes);
}
function resetTimeDefaultToOrg(): void {
  timeDefaultsStore.clearUserOverride();
  // After clearing the local pref the resolved minutes flip back to
  // org-default-or-bundled — apply that to the visible picker.
  timeRange.selectByMinutes(timeDefaultsStore.defaultWindowMinutes);
}

// Per-user theme chip — opens a popover with the 5 bundled themes +
// an option to clear the local override and fall back to the org
// default. Lives in the topbar's right cluster, next to alarm badge.
// Per CLAUDE.md the theme is a runtime concern, not a feature flag;
// this is the only surface where end users touch it.
const themeStore = useThemeStore();
const isLightAppearance = computed<boolean>(
  () => AVAILABLE_THEMES.find((t) => t.id === themeStore.active)?.appearance === 'light',
);
const themeMenuOpen = ref(false);
const themeChipEl = ref<HTMLElement | null>(null);
function toggleThemeMenu(): void { themeMenuOpen.value = !themeMenuOpen.value; }
function pickTheme(id: ThemeId): void {
  themeStore.setUserOverride(id);
  themeMenuOpen.value = false;
}
function resetThemeOverride(): void {
  themeStore.clearUserOverride();
  themeMenuOpen.value = false;
}
function onThemeChipBlur(e: FocusEvent): void {
  // Close when focus leaves the cluster — the popover lives outside
  // the chip, so we check `relatedTarget` for cluster containment.
  const next = e.relatedTarget as HTMLElement | null;
  if (!themeChipEl.value?.contains(next)) themeMenuOpen.value = false;
}

const route = useRoute();
const { t } = useI18n({ useScope: 'global' });

const { info, reachable, tzOffsetLabel, healthState, backend } = useOapInfo();
const auth = useAuthStore();

// "Query cold stage" — BanyanDB-only. The chip renders only when the
// connected OAP uses BanyanDB.
//
// IMPORTANT SEMANTICS: OAP's `Duration.coldStage: true` REPLACES the
// hot+warm read, it does not augment it (see the comment on
// `Duration.coldStage` in OAP's query-protocol). Turning the pill on
// while looking at a recent dashboard makes every widget go empty,
// because the recent window doesn't exist in cold yet. Only flip it
// on when the operator is asking for data older than the hot+warm
// TTL boundary (Operate → Time To Live shows the values per class).
//
// Flipping invalidates every tanstack-query cache so subscribers
// refetch with the new header instead of serving stale data from
// the previous stage.
const cold = useColdStageStore();
const queryClient = useQueryClient();
const showColdChip = computed<boolean>(() => backend.value === 'banyandb');
function toggleCold(): void {
  cold.toggle(queryClient);
}
const coldChipTooltip = computed<string>(() =>
  cold.enabled
    ? 'Reading cold-stage data only. ⚠ Recent windows return empty — cold doesn\'t hold recent data. Click to switch back to hot+warm.'
    : 'Reading hot+warm data (default). Click to switch to the cold stage instead — use only when the time range is older than the hot+warm TTL (see Operate → Time To Live).',
);
// The Cluster Status page is maintainer-tier; only link the chip there
// when the user can actually read it (matches the route's verb gate).
const canViewCluster = computed(() => auth.hasVerb('cluster:read'));

/* Alarm badge — independent 60s timer, rolling 20m window. The
 * badge sits next to OAP / time / refresh because alarms are a
 * top-level concern; clicking jumps straight to /alarms regardless of
 * which page the operator is on. */
const alarmCount = useAlarmCount();
const alarmBadgeTooltip = computed<string>(() => {
  if (alarmCount.hasError.value) {
    return `Alarms unavailable: ${alarmCount.errorMessage.value ?? 'no response'}`;
  }
  const windowMin = Math.round(alarmCount.windowMs.value / 60_000);
  const active = alarmCount.activeIncidents.value;
  const inc = alarmCount.incidents.value;
  const cap = alarmCount.truncated.value ? ' (capped — open the page for the full list)' : '';
  if (active === 0) {
    if (inc > 0) {
      return `No active alarms in the last ${windowMin}m · ${inc} recovered incident${inc === 1 ? '' : 's'}`;
    }
    return `No alarms in the last ${windowMin}m`;
  }
  return `${active} active incident${active === 1 ? '' : 's'} in the last ${windowMin}m${cap}`;
});
const alarmBadgeState = computed<'ok' | 'err' | 'unknown'>(() => {
  if (alarmCount.hasError.value) return 'unknown';
  return alarmCount.activeIncidents.value > 0 ? 'err' : 'ok';
});

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

// `tzMismatch` removed alongside the TZ chip; if a per-component
// browser-vs-server TZ check returns, derive from `useOapInfo().timezone`.

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
  // Alarms is a triage view — auto-refresh shifts the visible window
  // out from under any selection / brush the operator is making, and
  // we already chunk the traffic backfill ourselves with explicit
  // delta refresh. Pause the global ticker while on /alarms.
  /^\/alarms$/,
  // Profiling tabs (trace / eBPF / network / async / pprof) bind to a
  // *task* and the operator drills into a single segment + analyze
  // result. Auto-refresh would yank the task list, re-pick the first
  // task, and blow away the analyze pane mid-investigation. The pages
  // expose their own "refresh tasks" affordance instead. Same regex
  // shape as the trace/logs opt-outs above.
  /^\/layer\/[^/]+\/trace-profiling$/,
  /^\/layer\/[^/]+\/ebpf-profiling$/,
  /^\/layer\/[^/]+\/network-profiling$/,
  /^\/layer\/[^/]+\/async-profiling$/,
  /^\/layer\/[^/]+\/pprof$/,
];
const ownsTimeRange = computed<boolean>(() => TIME_RANGE_OPT_OUT.some((r) => r.test(route.path)));
/** Auto-refresh is paused whenever the operator has frozen the window
 *  to a custom range — polling a fixed snapshot just re-fetches the
 *  same bytes. The button still works for a one-shot manual refresh. */
const hasFrozenRange = computed<boolean>(
  () => useTimeRangeStore().presetId === 'custom',
);
const autoSuspended = computed<boolean>(() => ownsTimeRange.value || hasFrozenRange.value);
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
const refreshLabel = computed<string>(() => {
  if (autoSuspended.value) return t('Paused');
  if (auto.intervalSec === null) return t('Off');
  if (auto.secondsUntilNext === null) return '—';
  return `${auto.secondsUntilNext}s`;
});
const refreshTooltip = computed<string>(() => {
  if (ownsTimeRange.value) return t('Auto-refresh paused on this page');
  if (hasFrozenRange.value) return t('Auto-refresh paused while a custom time range is selected');
  if (auto.intervalSec === null) return t('Auto-refresh off · click to refresh now');
  return t(
    'Auto-refresh every {seconds}s · {remaining}s remaining · click to refresh now',
    { seconds: auto.intervalSec, remaining: auto.secondsUntilNext ?? '—' },
  );
});

// ── Global time-range picker ──────────────────────────────────────
const timeRange = useTimeRangeStore();
const timeMenuOpen = ref(false);
const timeClusterEl = ref<HTMLElement | null>(null);
/** Active tab in the dropdown — one tab per precision. Seeded from
 *  the currently-selected preset's step so reopening lands on the
 *  same precision the operator last used. */
const activeStepTab = ref<TimeStep>(timeRange.step);
watch(() => timeRange.step, (s) => (activeStepTab.value = s));
const TAB_DEFS: Array<{ step: TimeStep; tab: string; cap: string }> = [
  { step: 'MINUTE', tab: 'Minute', cap: '≤ 4 h' },
  { step: 'HOUR',   tab: 'Hour',   cap: '≤ 14 d' },
  { step: 'DAY',    tab: 'Day',    cap: '≤ 3 mo' },
];
const presetsForActiveTab = computed(() =>
  TIME_PRESETS.filter((p) => p.step === activeStepTab.value),
);
function pickTimePreset(id: string): void {
  timeRange.selectPreset(id);
  timeMenuOpen.value = false;
  // Fire one auto-refresh tick so subscribers re-query with the new
  // window immediately rather than waiting for the next interval.
  if (!ownsTimeRange.value) auto.refreshNow();
}
function onTimeMenuClickClose(ev: MouseEvent): void {
  if (!timeMenuOpen.value) return;
  const el = timeClusterEl.value;
  if (el && !el.contains(ev.target as Node)) {
    timeMenuOpen.value = false;
    customOpenStep.value = null;
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('click', onTimeMenuClickClose);
}
const timeChipLabel = computed<string>(() => {
  if (ownsTimeRange.value) return t('This page uses its own time range');
  if (timeRange.presetId === 'custom') {
    const r = timeRange.range;
    return `${formatRangeStamp(r.startMs, timeRange.step)} → ${formatRangeStamp(r.endMs, timeRange.step)}`;
  }
  return timeRange.label;
});

// ── Custom range, per precision ───────────────────────────────────
// One "Custom…" expander per precision group. Inputs are scoped to
// the step so the operator can't pick at finer resolution than the
// data will support:
//   MINUTE → datetime-local (date + HH:MM)
//   HOUR   → date + hour-select (00…23), no minute field at all
//   DAY    → date-only
// Submit clamps against STEP_LIMITS so an overlong window is
// rejected at the boundary instead of silently truncated.
const customOpenStep = ref<TimeStep | null>(null);
/** Per-bound, per-step form state. For HOUR we keep date and hour
 *  in separate keys so the UI can render two distinct controls. */
const customDraft = ref<Record<string, string>>({});
const customError = ref<string | null>(null);

function z2(n: number): string {
  return String(n).padStart(2, '0');
}
const HOURS_OF_DAY: readonly number[] = Array.from({ length: 24 }, (_, i) => i);

/** Seed form state for one bound. The shape depends on the step. */
function setDraftFromMs(step: TimeStep, side: 'start' | 'end', ms: number): void {
  const d = new Date(ms);
  const base = `${d.getFullYear()}-${z2(d.getMonth() + 1)}-${z2(d.getDate())}`;
  if (step === 'DAY') {
    customDraft.value[`${step}-${side}`] = base;
    return;
  }
  if (step === 'HOUR') {
    customDraft.value[`${step}-${side}-date`] = base;
    customDraft.value[`${step}-${side}-hour`] = z2(d.getHours());
    return;
  }
  // MINUTE
  customDraft.value[`${step}-${side}`] = `${base}T${z2(d.getHours())}:${z2(d.getMinutes())}`;
}
/** Compose form state for one bound back into an ms timestamp. */
function draftToMs(step: TimeStep, side: 'start' | 'end'): number | null {
  if (step === 'DAY') {
    const v = customDraft.value[`${step}-${side}`] ?? '';
    if (!v) return null;
    const [y, mo, da] = v.split('-').map(Number);
    if (!y || !mo || !da) return null;
    return new Date(y, mo - 1, da).getTime();
  }
  if (step === 'HOUR') {
    const dateV = customDraft.value[`${step}-${side}-date`] ?? '';
    const hourV = customDraft.value[`${step}-${side}-hour`] ?? '';
    if (!dateV || hourV === '') return null;
    const [y, mo, da] = dateV.split('-').map(Number);
    const h = Number(hourV);
    if (!y || !mo || !da || Number.isNaN(h)) return null;
    return new Date(y, mo - 1, da, h, 0, 0, 0).getTime();
  }
  // MINUTE
  const v = customDraft.value[`${step}-${side}`] ?? '';
  if (!v) return null;
  const dt = new Date(v);
  return Number.isNaN(dt.getTime()) ? null : dt.getTime();
}
/** Seed the custom-range form for `step`. Pulls from the currently
 *  applied range when the step matches and the window fits; otherwise
 *  falls back to "half the step's max, ending now". Called both from
 *  the manual "Custom range…" click AND from the auto-expand on
 *  picker-open path below — keeps the seed logic in one place. */
function seedCustomDraft(step: TimeStep): void {
  const lim = STEP_LIMITS[step];
  let endMs: number;
  let startMs: number;
  const cur = timeRange.range;
  const fits = step === timeRange.step && cur.endMs > cur.startMs && cur.endMs - cur.startMs <= lim.maxMs;
  if (fits) {
    startMs = cur.startMs;
    endMs = cur.endMs;
  } else {
    endMs = Date.now();
    startMs = endMs - Math.floor(lim.maxMs / 2);
  }
  setDraftFromMs(step, 'start', startMs);
  setDraftFromMs(step, 'end', endMs);
}
function openCustom(step: TimeStep): void {
  customError.value = null;
  if (customOpenStep.value === step) {
    customOpenStep.value = null;
    return;
  }
  customOpenStep.value = step;
  seedCustomDraft(step);
}

// Auto-expand the custom-range form whenever the picker opens AND the
// currently-applied range is a custom one — so re-opening lands the
// operator straight on the inputs they last edited, on the matching
// precision tab. For preset ranges (Last 15m, etc.) we leave the
// custom form collapsed so the preset list is the focal point.
watch(timeMenuOpen, (open) => {
  if (!open) return;
  activeStepTab.value = timeRange.step;
  if (timeRange.presetId === 'custom') {
    customOpenStep.value = timeRange.step;
    seedCustomDraft(timeRange.step);
  } else {
    customOpenStep.value = null;
  }
});
function submitCustom(step: TimeStep): void {
  const startMs = draftToMs(step, 'start');
  const endMs = draftToMs(step, 'end');
  if (startMs === null || endMs === null) {
    customError.value = 'Pick both a start and an end.';
    return;
  }
  if (endMs <= startMs) {
    customError.value = 'End must be after start.';
    return;
  }
  if (!isValidRange(step, endMs - startMs)) {
    const lim = STEP_LIMITS[step];
    customError.value = `Range exceeds ${step.toLowerCase()}-precision cap of ${humanDuration(lim.maxMs)}.`;
    return;
  }
  customError.value = null;
  timeRange.selectCustom(startMs, endMs, step);
  timeMenuOpen.value = false;
  customOpenStep.value = null;
  if (!ownsTimeRange.value) auto.refreshNow();
}
function humanDuration(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  return `${d} d`;
}
function formatRangeStamp(ms: number, step: TimeStep): string {
  const d = new Date(ms);
  const z = (n: number) => String(n).padStart(2, '0');
  if (step === 'DAY') return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
  if (step === 'HOUR') return `${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}h`;
  return `${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}
</script>

<template>
  <header class="sw-top">
    <!-- When the sidebar is folded, its wordmark is hidden — show the
         brand (logo + name) here so the product identity stays visible.
         Otherwise the left zone stays empty (the framework-event feed
         moved to the bottom-fixed DebugEventPanel). -->
    <RouterLink v-if="sidebarCollapsed" to="/" class="top-brand" aria-label="SkyWalking Horizon">
      <span class="top-brand-logo" v-html="isLightAppearance ? logoSwBlue : logoSw" />
      <small>Horizon</small>
    </RouterLink>
    <div class="sw-top-spacer" />
    <div class="sw-top-actions">
      <component
        :is="canViewCluster ? RouterLink : 'div'"
        class="sw-btn oap-chip"
        :class="[`is-${healthState}`, { 'is-static': !canViewCluster }]"
        :title="oapChipTooltip"
        v-bind="canViewCluster ? { to: '/operate/cluster' } : {}"
      >
        <span class="dot" />
        <span v-if="reachable" class="ver">OAP</span>
        <span v-else class="ver">offline</span>
        <!-- Server TZ offset removed from the visible chip — too much
             noise next to the health dot for an operator-rare check.
             The tooltip (`oapChipTooltip`) still surfaces the value
             when reachable, and the Cluster Status page → Query pane
             shows it prominently. Non-cluster:read users get a static
             chip (no link to the maintainer-only Cluster page). -->
      </component>
      <button
        v-if="showColdChip"
        type="button"
        class="sw-btn cold-chip"
        :class="{ 'is-on': cold.enabled }"
        :title="coldChipTooltip"
        @click="toggleCold"
      >
        <Icon name="snowflake" :size="11" />
        <span>{{ cold.enabled ? 'Cold only' : 'Cold' }}</span>
      </button>
      <div ref="timeClusterEl" class="time-cluster">
        <button
          type="button"
          class="sw-btn time-trigger"
          :class="{ 'is-disabled': ownsTimeRange }"
          :title="globalTimeTooltip"
          :disabled="ownsTimeRange"
          @click="timeMenuOpen = !timeMenuOpen"
        >
          <Icon name="clock" :size="12" />
          <span>{{ timeChipLabel }}</span>
          <Icon name="caret" :size="10" />
        </button>
        <transition name="rf-menu">
          <div v-if="timeMenuOpen && !ownsTimeRange" class="tr-menu">
            <!-- Tab strip — one tab per precision; switching tabs
                 doesn't apply anything, it just swaps which preset
                 list + custom form is shown. -->
            <div class="tr-tabs" role="tablist">
              <button
                v-for="t in TAB_DEFS"
                :key="t.step"
                type="button"
                class="tr-tab"
                :class="{ 'is-on': activeStepTab === t.step }"
                role="tab"
                :aria-selected="activeStepTab === t.step"
                @click="activeStepTab = t.step; customError = null"
              >
                <span class="tr-tab-name">{{ t.tab }}</span>
                <span class="tr-tab-cap">{{ t.cap }}</span>
              </button>
            </div>

            <div class="tr-tab-body">
              <button
                v-for="p in presetsForActiveTab"
                :key="p.id"
                type="button"
                class="tr-item"
                :class="{ 'is-on': timeRange.presetId === p.id }"
                @click="pickTimePreset(p.id)"
              >
                <span>{{ p.label }}</span>
                <span v-if="timeRange.presetId === p.id" class="tr-tick">✓</span>
              </button>
              <!-- Custom expander, scoped to the active precision. -->
              <button
                type="button"
                class="tr-item tr-custom-trigger"
                :class="{ 'is-on': customOpenStep === activeStepTab }"
                @click="openCustom(activeStepTab)"
              >
                <span>Custom range…</span>
                <span class="tr-tick">{{ customOpenStep === activeStepTab ? '▾' : '▸' }}</span>
              </button>
              <div v-if="customOpenStep === activeStepTab" class="tr-custom">
                <template v-for="side in (['start', 'end'] as const)" :key="side">
                  <label class="tr-custom-field">
                    <span>{{ side === 'start' ? 'Start' : 'End' }}</span>
                    <!-- MINUTE precision — full date + HH:MM. -->
                    <input
                      v-if="activeStepTab === 'MINUTE'"
                      type="datetime-local"
                      step="60"
                      class="tr-custom-input"
                      v-model="customDraft[`${activeStepTab}-${side}`]"
                    />
                    <!-- HOUR precision — date + hour-select. -->
                    <div v-else-if="activeStepTab === 'HOUR'" class="tr-custom-split">
                      <input
                        type="date"
                        class="tr-custom-input"
                        v-model="customDraft[`${activeStepTab}-${side}-date`]"
                      />
                      <select
                        class="tr-custom-input tr-custom-hour"
                        v-model="customDraft[`${activeStepTab}-${side}-hour`]"
                      >
                        <option v-for="h in HOURS_OF_DAY" :key="h" :value="String(h).padStart(2, '0')">
                          {{ String(h).padStart(2, '0') }}:00
                        </option>
                      </select>
                    </div>
                    <!-- DAY precision — date only. -->
                    <input
                      v-else
                      type="date"
                      class="tr-custom-input"
                      v-model="customDraft[`${activeStepTab}-${side}`]"
                    />
                  </label>
                </template>
                <div v-if="customError" class="tr-custom-err">{{ customError }}</div>
                <div class="tr-custom-foot">
                  <button type="button" class="tr-cust-btn ghost" @click="customOpenStep = null">Cancel</button>
                  <button type="button" class="tr-cust-btn primary" @click="submitCustom(activeStepTab)">Apply</button>
                </div>
              </div>
            </div>
            <!-- Per-user "Save as my default" / "Reset to org default".
                 Persists the current rolling window's minute count into
                 localStorage, or clears it so the org default wins. Hidden
                 when the current selection is a custom range (we can't
                 represent that as a single minute count). -->
            <div class="tr-defaults">
              <div class="tr-defaults-line">
                <span>My default: <strong>{{ timeDefaultsStore.defaultWindowMinutes }}m</strong>{{ timeDefaultsStore.hasUserOverride ? ' (your override)' : ' (org default)' }}</span>
              </div>
              <div class="tr-defaults-foot">
                <button
                  type="button"
                  class="tr-cust-btn ghost"
                  :disabled="timeRange.presetId === 'custom'"
                  :title="timeRange.presetId === 'custom' ? 'Pick a rolling preset first' : ''"
                  @click="saveCurrentAsMyTimeDefault"
                >Save as my default</button>
                <button
                  type="button"
                  class="tr-cust-btn ghost"
                  :disabled="!timeDefaultsStore.hasUserOverride"
                  @click="resetTimeDefaultToOrg"
                >Reset to org default</button>
              </div>
            </div>
          </div>
        </transition>
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
      <RouterLink
        class="sw-btn alarm-badge"
        :class="`is-${alarmBadgeState}`"
        :title="alarmBadgeTooltip"
        to="/alarms"
      >
        <Icon name="bell" :size="12" />
        <span class="alarm-count mono">{{ alarmCount.displayCount.value }}</span>
      </RouterLink>

      <!-- ── Theme chip ────────────────────────────────────────────
        Labeled with the current theme name so operators can find it
        without guessing the icon. The small dot indicates an active
        user override (theme differs from org default). Click opens a
        popover with the 5 themes + Reset. -->
      <div ref="themeChipEl" class="theme-chip-cluster" tabindex="-1" @focusout="onThemeChipBlur">
        <button
          type="button"
          class="sw-btn theme-chip"
          :title="`Theme: ${themeStore.active}${themeStore.hasUserOverride ? ' (your override)' : ''} — click to change`"
          @click="toggleThemeMenu"
        >
          <span class="theme-chip-swatch" />
          <span class="theme-chip-label">{{ themeStore.active }}</span>
          <span v-if="themeStore.hasUserOverride" class="theme-chip-dot" />
          <Icon name="caret" :size="10" />
        </button>
        <transition name="rf-menu">
          <ul v-if="themeMenuOpen" class="theme-menu">
            <li class="theme-menu-head">Theme</li>
            <li
              v-for="t in AVAILABLE_THEMES"
              :key="t.id"
              :class="{ on: themeStore.active === t.id }"
              @click="pickTheme(t.id)"
            >
              {{ t.label }}
              <span v-if="!themeStore.hasUserOverride && t.id === themeStore.active" class="theme-menu-org">(org default)</span>
            </li>
            <li
              v-if="themeStore.hasUserOverride"
              class="theme-menu-reset"
              @click="resetThemeOverride"
            >Reset to org default</li>
          </ul>
        </transition>
      </div>

      <!-- Locale picker. Sits next to the theme chip so the two
           operator-overridable surfaces (theme + language) cluster
           together. Pick is persisted to localStorage and invalidates
           every active vue-query so BFF-localized payloads (menu /
           layer dashboards / overviews) refetch in the new locale. -->
      <LocaleChip />
    </div>
  </header>
</template>

<style scoped>
/* Brand shown in the topbar's left zone only while the sidebar is
   folded — same wordmark + "Horizon" label as the sidebar header. */
.top-brand {
  display: inline-flex;
  align-items: center;
  text-decoration: none;
  color: inherit;
}
.top-brand-logo { display: inline-flex; align-items: center; }
.top-brand-logo :deep(svg) { height: 16px; width: auto; display: block; }
.top-brand small {
  font-weight: 500;
  color: var(--sw-fg-2);
  margin-left: 4px;
  letter-spacing: 0.02em;
}

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

/* ── Cold-stage chip (BanyanDB only) ─────────────────────────── */
/* Snowflake pill that sits to the left of the time picker. Off state
 * is muted (matches the other off-state chips); on state uses a cool
 * cyan tint so it visually pops — operators are intentionally drawn
 * to "you are currently including cold data" because it changes which
 * window of history is in play. */
.cold-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 0 8px;
  cursor: pointer;
  color: var(--sw-fg-2);
}
.cold-chip:hover {
  color: var(--sw-fg-0);
}
.cold-chip.is-on {
  background: var(--sw-accent-soft);
  border-color: var(--sw-accent);
  color: var(--sw-accent);
  font-weight: 600;
}
.cold-chip.is-on :deep(svg) {
  color: var(--sw-accent);
}

/* ── Global time-range picker ─────────────────────────────────── */
.time-cluster {
  position: relative;
  display: flex;
}
.time-trigger {
  cursor: pointer;
}
.tr-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 60;
  width: 240px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.45);
  padding: 4px 0;
  font-size: 11.5px;
  max-height: 70vh;
  overflow-y: auto;
}
/* Tab strip + body for the 3-precision dropdown. The tab list sits
 * flush with the menu top and slides the body content under it.
 * Active tab gets an underline + accent text so the precision is
 * obvious at a glance. */
.tr-tabs {
  display: flex;
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-2);
}
.tr-tab {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 8px 4px 6px;
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  color: var(--sw-fg-2);
  font: inherit;
  cursor: pointer;
  transition: color 0.1s ease, border-color 0.1s ease;
}
.tr-tab:hover {
  color: var(--sw-fg-0);
}
.tr-tab.is-on {
  color: var(--sw-accent);
  border-bottom-color: var(--sw-accent);
}
.tr-tab-name {
  font-size: 11.5px;
  font-weight: 600;
}
.tr-tab-cap {
  font-size: 9.5px;
  color: var(--sw-fg-3);
  letter-spacing: 0.04em;
}
.tr-tab.is-on .tr-tab-cap {
  color: var(--sw-accent-2);
}
.tr-tab-body {
  padding: 4px 0;
}
.tr-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 5px 12px;
  border: 0;
  background: transparent;
  color: var(--sw-fg-1);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.tr-item:hover {
  background: var(--sw-bg-2);
  color: var(--sw-fg-0);
}
.tr-item.is-on {
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
  font-weight: 600;
}
.tr-tick {
  font-size: 11px;
  color: var(--sw-accent);
}
.tr-menu {
  width: 280px;
}
.tr-custom-trigger {
  color: var(--sw-fg-2);
}
.tr-custom-trigger.is-on {
  background: var(--sw-bg-2);
  color: var(--sw-fg-0);
  font-weight: 500;
}
.tr-custom {
  padding: 6px 12px 10px;
  background: var(--sw-bg-2);
  border-top: 1px dotted var(--sw-line);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tr-custom-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
}
.tr-custom-input {
  background: var(--sw-bg-1);
  color: var(--sw-fg-0);
  border: 1px solid var(--sw-line);
  border-radius: 3px;
  padding: 4px 6px;
  font-family: var(--sw-mono);
  font-size: 11.5px;
  outline: none;
}
.tr-custom-input:focus {
  border-color: var(--sw-accent);
}
.tr-custom-split {
  display: flex;
  gap: 6px;
}
.tr-custom-split .tr-custom-input {
  flex: 1 1 0;
  min-width: 0;
}
.tr-custom-hour {
  flex: 0 0 78px;
}
.tr-custom-err {
  font-size: 10.5px;
  color: var(--sw-err);
}
.tr-custom-foot {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 2px;
}
.tr-cust-btn {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 3px;
  border: 1px solid var(--sw-line-2);
  background: transparent;
  color: var(--sw-fg-1);
  cursor: pointer;
}
.tr-cust-btn.primary {
  background: var(--sw-accent);
  border-color: var(--sw-accent);
  color: #0a0d12;
  font-weight: 600;
}
.tr-cust-btn:hover:not(:disabled) {
  filter: brightness(1.08);
}

.oap-chip {
  text-decoration: none;
  font-family: var(--sw-mono);
  font-variant-numeric: tabular-nums;
  font-size: 10.5px;
  gap: 6px;
}
/* Non-clickable health chip for users without cluster:read. */
.oap-chip.is-static {
  cursor: default;
  display: inline-flex;
  align-items: center;
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
@keyframes pulse-err {
  0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.6); }
  70% { box-shadow: 0 0 0 6px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}

/* ── Alarm badge ───────────────────────────────────────────────── */
/* Bell + count, same chip footprint as the OAP pill. Red fill when
 * any alarm fired in the window, neutral when clean, grey when the
 * BFF can't reach OAP. Click jumps to /alarms. */
.alarm-badge {
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
}
.alarm-badge .alarm-count {
  font-size: 10.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  min-width: 14px;
  text-align: center;
}
.alarm-badge.is-ok {
  color: var(--sw-fg-2);
}
.alarm-badge.is-ok .alarm-count {
  color: var(--sw-fg-2);
}
.alarm-badge.is-err {
  color: var(--sw-err);
}
.alarm-badge.is-err .alarm-count {
  color: var(--sw-err);
}
.alarm-badge.is-err :deep(svg) {
  animation: pulse-err 1.6s infinite;
  transform-origin: 50% 50%;
}
.alarm-badge.is-unknown {
  color: var(--sw-fg-3);
}
.alarm-badge.is-unknown .alarm-count {
  color: var(--sw-fg-3);
}

/* ── Theme chip ────────────────────────────────────────────────────
   Mirrors `refresh-cluster` — a small icon button + popover. The dot
   surfaces when the user has a local theme override active. */
.theme-chip-cluster {
  position: relative;
  display: inline-flex;
  outline: none;
}
.theme-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 0 8px;
  height: 26px;
}
.theme-chip-swatch {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--sw-accent);
  border: 1px solid var(--sw-line-2);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18);
}
.theme-chip-label {
  font-size: 11px;
  color: var(--sw-fg-1);
  text-transform: capitalize;
  letter-spacing: 0.02em;
}
.theme-chip-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--sw-accent);
  border: 1px solid var(--sw-bg-0);
}
.theme-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  padding: 4px 0;
  margin: 0;
  list-style: none;
  min-width: 200px;
  z-index: 60;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
}
.theme-menu-head {
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--sw-fg-3);
  padding: 4px 10px 6px;
  border-bottom: 1px solid var(--sw-line);
}
.theme-menu li:not(.theme-menu-head) {
  padding: 6px 10px;
  font-size: 11.5px;
  color: var(--sw-fg-1);
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.theme-menu li:not(.theme-menu-head):hover {
  background: var(--sw-bg-3);
}
.theme-menu li.on { color: var(--sw-accent); font-weight: 500; }
.theme-menu-org { color: var(--sw-fg-3); font-size: 10.5px; }
.theme-menu-reset {
  border-top: 1px solid var(--sw-line);
  color: var(--sw-fg-2);
  font-size: 10.5px !important;
}

/* ── Per-user time-defaults footer (in the time-picker dropdown) ──── */
.tr-defaults {
  border-top: 1px solid var(--sw-line);
  padding: 8px 10px;
}
.tr-defaults-line {
  font-size: 10.5px;
  color: var(--sw-fg-2);
  margin-bottom: 6px;
}
.tr-defaults-line strong {
  color: var(--sw-fg-0);
  font-weight: 600;
}
.tr-defaults-foot {
  display: flex; gap: 6px;
}
</style>
