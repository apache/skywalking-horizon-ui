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
  The time-range menu: a precision tab strip (Minute / Hour / Day, each
  captioned with the window it can address), that precision's rolling
  presets, and a custom-range form scoped to the same precision.

  PRESENTATIONAL. It reads no store and applies nothing — it reports what
  the operator chose and lets the host decide what that means. That is what
  lets the topbar drive the global range with it while an admin panel drives
  a local one, without a second copy of the markup drifting from this one.

  The host owns POSITIONING too: the topbar anchors it under its chip, a
  modal floats it. Absolute positioning here would be clipped by whichever
  scroll container the host happens to be.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  TIME_PRESETS,
  STEP_LIMITS,
  isValidRange,
  type TimeStep,
} from '@/controls/timeRange';

const props = defineProps<{
  /** Currently applied preset id, or `'custom'`. Drives the checkmark. */
  presetId: string;
  /** The applied window — seeds the custom form and the opening tab. */
  current: { startMs: number; endMs: number; step: TimeStep };
  /** Flipped by the host when the menu becomes visible, so the tab and the
   *  custom form re-seed from `current` on each open rather than keeping
   *  whatever the operator left behind last time. */
  open?: boolean;
}>();
const emit = defineEmits<{
  pick: [presetId: string];
  custom: [startMs: number, endMs: number, step: TimeStep];
}>();

const { t } = useI18n({ useScope: 'global' });

const activeStepTab = ref<TimeStep>(props.current.step);
const TAB_DEFS = computed<Array<{ step: TimeStep; tab: string; cap: string }>>(() => [
  { step: 'MINUTE', tab: t('Minute'), cap: t('≤ 4 h') },
  { step: 'HOUR', tab: t('Hour'), cap: t('≤ 14 d') },
  { step: 'DAY', tab: t('Day'), cap: t('≤ 3 mo') },
]);
const presetsForActiveTab = computed(() =>
  TIME_PRESETS.filter((p) => p.step === activeStepTab.value),
);

// Inputs are scoped to the step so the operator can't pick at finer
// resolution than the data will support:
//   MINUTE → datetime-local (date + HH:MM)
//   HOUR   → date + hour-select (00…23), no minute field at all
//   DAY    → date-only
const customOpenStep = ref<TimeStep | null>(null);
/** Per-bound, per-step form state. For HOUR we keep date and hour in
 *  separate keys so the UI can render two distinct controls. */
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
  const v = customDraft.value[`${step}-${side}`] ?? '';
  if (!v) return null;
  const dt = new Date(v);
  return Number.isNaN(dt.getTime()) ? null : dt.getTime();
}

/** Seed the custom form for `step` from the applied window when it fits
 *  that precision, else from "half the step's max, ending now". */
function seedCustomDraft(step: TimeStep): void {
  const lim = STEP_LIMITS[step];
  const cur = props.current;
  const fits = step === cur.step && cur.endMs > cur.startMs && cur.endMs - cur.startMs <= lim.maxMs;
  const endMs = fits ? cur.endMs : Date.now();
  const startMs = fits ? cur.startMs : endMs - Math.floor(lim.maxMs / 2);
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

// Re-opening lands the operator on the precision they are actually using,
// and straight on the inputs they last edited when that was a custom range.
watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    activeStepTab.value = props.current.step;
    if (props.presetId === 'custom') {
      customOpenStep.value = props.current.step;
      seedCustomDraft(props.current.step);
    } else {
      customOpenStep.value = null;
    }
  },
  { immediate: true },
);

function humanDuration(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h < 24) return t('{n} h', { n: h });
  return t('{n} d', { n: Math.floor(h / 24) });
}

function submitCustom(step: TimeStep): void {
  const startMs = draftToMs(step, 'start');
  const endMs = draftToMs(step, 'end');
  if (startMs === null || endMs === null) {
    customError.value = t('Pick both a start and an end.');
    return;
  }
  if (endMs <= startMs) {
    customError.value = t('End must be after start.');
    return;
  }
  if (!isValidRange(step, endMs - startMs)) {
    customError.value = t('Range exceeds {step}-precision cap of {cap}.', {
      step: step.toLowerCase(),
      cap: humanDuration(STEP_LIMITS[step].maxMs),
    });
    return;
  }
  customError.value = null;
  customOpenStep.value = null;
  emit('custom', startMs, endMs, step);
}
</script>

<template>
  <div class="tr-menu-body">
    <!-- Tab strip — one tab per precision; switching tabs doesn't apply
         anything, it just swaps which preset list + custom form is shown. -->
    <div class="tr-tabs" role="tablist">
      <button
        v-for="d in TAB_DEFS"
        :key="d.step"
        type="button"
        class="tr-tab"
        :class="{ 'is-on': activeStepTab === d.step }"
        role="tab"
        :aria-selected="activeStepTab === d.step"
        @click="activeStepTab = d.step; customError = null"
      >
        <span class="tr-tab-name">{{ d.tab }}</span>
        <span class="tr-tab-cap">{{ d.cap }}</span>
      </button>
    </div>

    <div class="tr-tab-body">
      <button
        v-for="p in presetsForActiveTab"
        :key="p.id"
        type="button"
        class="tr-item"
        :class="{ 'is-on': presetId === p.id }"
        @click="emit('pick', p.id)"
      >
        <span>{{ t(p.label) }}</span>
        <span v-if="presetId === p.id" class="tr-tick">✓</span>
      </button>

      <!-- Custom expander, scoped to the active precision. -->
      <button
        type="button"
        class="tr-item tr-custom-trigger"
        :class="{ 'is-on': customOpenStep === activeStepTab }"
        @click="openCustom(activeStepTab)"
      >
        <span>{{ t('Custom range…') }}</span>
        <span class="tr-tick">{{ customOpenStep === activeStepTab ? '▾' : '▸' }}</span>
      </button>
      <div v-if="customOpenStep === activeStepTab" class="tr-custom">
        <template v-for="side in (['start', 'end'] as const)" :key="side">
          <label class="tr-custom-field">
            <span>{{ side === 'start' ? t('Start') : t('End') }}</span>
            <input
              v-if="activeStepTab === 'MINUTE'"
              v-model="customDraft[`${activeStepTab}-${side}`]"
              type="datetime-local"
              step="60"
              class="tr-custom-input"
            />
            <div v-else-if="activeStepTab === 'HOUR'" class="tr-custom-split">
              <input
                v-model="customDraft[`${activeStepTab}-${side}-date`]"
                type="date"
                class="tr-custom-input"
              />
              <select
                v-model="customDraft[`${activeStepTab}-${side}-hour`]"
                class="tr-custom-input tr-custom-hour"
              >
                <option v-for="h in HOURS_OF_DAY" :key="h" :value="String(h).padStart(2, '0')">
                  {{ String(h).padStart(2, '0') }}:00
                </option>
              </select>
            </div>
            <input
              v-else
              v-model="customDraft[`${activeStepTab}-${side}`]"
              type="date"
              class="tr-custom-input"
            />
          </label>
        </template>
        <div v-if="customError" class="tr-custom-err">{{ customError }}</div>
        <div class="tr-custom-foot">
          <button type="button" class="tr-cust-btn ghost" @click="customOpenStep = null">
            {{ t('Cancel') }}
          </button>
          <button type="button" class="tr-cust-btn primary" @click="submitCustom(activeStepTab)">
            {{ t('Apply') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Host-supplied extras (the topbar's "save as my default" block). -->
    <slot name="footer" />
  </div>
</template>

<style scoped>
.tr-menu-body {
  display: flex;
  flex-direction: column;
}
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
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tr-custom-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 10.5px;
  color: var(--sw-fg-3);
  letter-spacing: 0.04em;
}
.tr-custom-input {
  width: 100%;
  padding: 4px 6px;
  background: var(--sw-bg-0);
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11px;
}
.tr-custom-input:focus {
  outline: none;
  border-color: var(--sw-accent);
}
.tr-custom-split {
  display: flex;
  gap: 4px;
}
.tr-custom-split .tr-custom-input {
  flex: 1 1 auto;
}
.tr-custom-hour {
  flex: 0 0 78px;
}
.tr-custom-err {
  color: var(--sw-err);
  font-size: 10.5px;
}
.tr-custom-foot {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
.tr-cust-btn {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 3px;
  border: 1px solid var(--sw-line-2);
  background: transparent;
  color: var(--sw-fg-1);
  font: inherit;
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
</style>
