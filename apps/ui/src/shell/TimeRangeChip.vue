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
import { useTimeRangeStore, TIME_PRESETS, STEP_LIMITS, isValidRange, type TimeStep } from '@/controls/timeRange';
import { useTimeDefaultsStore } from '@/state/timeDefaults';
import { useTopbarTimeContext } from '@/shell/useTopbarTimeContext';

const { t } = useI18n({ useScope: 'global' });
const { ownsTimeRange, noTimeContext } = useTopbarTimeContext();
const auto = useAutoRefreshStore();

// The org default is what the admin set on /admin/global-defaults
// (3-tier: localStorage → OAP → bundled 60m).
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

const localTzLabel = computed<string>(() => {
  const offMin = -new Date().getTimezoneOffset(); // browser returns inverted sign
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(m).padStart(2, '0')}`;
});

const globalTimeTooltip = computed<string>(() => {
  if (noTimeContext.value) return 'No time range on config / operate pages.';
  if (ownsTimeRange.value) {
    return 'This page uses its own time range — disable the page picker to use the global one.';
  }
  return `Browser local time · ${localTzLabel.value}`;
});

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
onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('click', onTimeMenuClickClose);
  }
});
const timeChipLabel = computed<string>(() => {
  if (noTimeContext.value) return t('Time range N/A');
  if (ownsTimeRange.value) return t('This page uses its own time range');
  if (timeRange.presetId === 'custom') {
    const r = timeRange.range;
    return `${formatRangeStamp(r.startMs, timeRange.step)} → ${formatRangeStamp(r.endMs, timeRange.step)}`;
  }
  return timeRange.label;
});

// Inputs are scoped to the step so the operator can't pick at finer
// resolution than the data will support:
//   MINUTE → datetime-local (date + HH:MM)
//   HOUR   → date + hour-select (00…23), no minute field at all
//   DAY    → date-only
// Submit clamps against STEP_LIMITS so an overlong window is rejected at
// the boundary instead of silently truncated.
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
                <input
                  v-if="activeStepTab === 'MINUTE'"
                  type="datetime-local"
                  step="60"
                  class="tr-custom-input"
                  v-model="customDraft[`${activeStepTab}-${side}`]"
                />
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
</template>

<style scoped>
/* Disabled state for the global time-range chip when the current page
   owns its own time range. Greys out without removing the chip so the
   operator still sees the affordance + tooltip. */
.sw-btn.is-disabled {
  opacity: 0.45;
  pointer-events: none;
  filter: grayscale(0.6);
}

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

/* Popover transition (shared `rf-menu` name, kept local to the chip). */
.rf-menu-enter-from, .rf-menu-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
.rf-menu-enter-active, .rf-menu-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
</style>
