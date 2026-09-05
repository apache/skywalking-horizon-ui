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
import { computed, onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Icon from '@/components/icons/Icon.vue';
import TimeRangeMenu from '@/components/primitives/TimeRangeMenu.vue';
import { useAutoRefreshStore } from '@/controls/autoRefresh';
import { useTimeRangeStore, type TimeStep } from '@/controls/timeRange';
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
  if (noTimeContext.value) return t('No time range on config / operate pages.');
  if (ownsTimeRange.value) {
    return t('This page uses its own time range — disable the page picker to use the global one.');
  }
  return t('Browser local time · {tz}', { tz: localTzLabel.value });
});

const timeRange = useTimeRangeStore();
const timeMenuOpen = ref(false);
const timeClusterEl = ref<HTMLElement | null>(null);
// Computed (not a module const) so the tab / cap labels re-resolve
// against the current locale on switch.
function pickTimePreset(id: string): void {
  timeRange.selectPreset(id);
  timeMenuOpen.value = false;
  // Fire one auto-refresh tick so subscribers re-query with the new
  // window immediately rather than waiting for the next interval.
  if (!ownsTimeRange.value) auto.refreshNow('time-change');
}
function onTimeMenuClickClose(ev: MouseEvent): void {
  if (!timeMenuOpen.value) return;
  const el = timeClusterEl.value;
  if (el && !el.contains(ev.target as Node)) {
    timeMenuOpen.value = false;
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
  return t(timeRange.label);
});

/** The menu validated the range and reports it; the store and the refresh
 *  round are this component's business, not the menu's. */
function applyCustom(startMs: number, endMs: number, step: TimeStep): void {
  timeRange.selectCustom(startMs, endMs, step);
  timeMenuOpen.value = false;
  if (!ownsTimeRange.value) auto.refreshNow('time-change');
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
        <TimeRangeMenu
          :preset-id="timeRange.presetId"
          :current="{ startMs: timeRange.range.startMs, endMs: timeRange.range.endMs, step: timeRange.step }"
          :open="timeMenuOpen"
          @pick="pickTimePreset"
          @custom="applyCustom"
        />
        <!-- Per-user "Save as my default" / "Reset to org default".
             Persists the current rolling window's minute count into
             localStorage, or clears it so the org default wins. Hidden
             when the current selection is a custom range (we can't
             represent that as a single minute count). -->
        <div class="tr-defaults">
          <div class="tr-defaults-line">
            <span>{{ t('My default:') }} <strong>{{ timeDefaultsStore.defaultWindowMinutes }}m</strong>{{ timeDefaultsStore.hasUserOverride ? ' ' + t('(your override)') : ' ' + t('(org default)') }}</span>
          </div>
          <div class="tr-defaults-foot">
            <button
              type="button"
              class="tr-cust-btn ghost"
              :disabled="timeRange.presetId === 'custom'"
              :title="timeRange.presetId === 'custom' ? t('Pick a rolling preset first') : ''"
              @click="saveCurrentAsMyTimeDefault"
            >{{ t('Save as my default') }}</button>
            <button
              type="button"
              class="tr-cust-btn ghost"
              :disabled="!timeDefaultsStore.hasUserOverride"
              @click="resetTimeDefaultToOrg"
            >{{ t('Reset to org default') }}</button>
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
  width: 280px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.45);
  padding: 4px 0;
  font-size: 11.5px;
  max-height: 70vh;
  overflow-y: auto;
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
