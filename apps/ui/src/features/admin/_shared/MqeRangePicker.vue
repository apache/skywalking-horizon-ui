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
  The MQE panel's time range: the topbar's chip and menu, driven by a LOCAL
  value.

  It cannot be the topbar's own chip. That one writes the global store — so
  picking a window here would move every dashboard behind the modal — and it
  disables itself by route, `/admin/` included, so a copy would render grey
  and never open. The menu inside is the same component the topbar renders.

  The window is stamped when `resolve()` is called rather than held, so a
  rolling preset always means "now" at the moment of the run, not whenever
  the panel was opened.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Icon from '@/components/icons/Icon.vue';
import FloatingPanel from '@/components/primitives/FloatingPanel.vue';
import TimeRangeMenu from '@/components/primitives/TimeRangeMenu.vue';
import { TIME_PRESETS, type TimeStep } from '@/controls/timeRange';

const emit = defineEmits<{ change: [] }>();

interface ResolvedRange {
  step: TimeStep;
  startMs: number;
  endMs: number;
}

const { t } = useI18n({ useScope: 'global' });

const DEFAULT_PRESET = '1h';
const presetId = ref<string>(DEFAULT_PRESET);
/** Set only while `presetId === 'custom'` — a frozen window, not a rolling one. */
const fixed = ref<ResolvedRange | null>(null);

const preset = computed(() => TIME_PRESETS.find((p) => p.id === presetId.value) ?? null);

function stampNow(): ResolvedRange {
  const p = preset.value ?? TIME_PRESETS.find((x) => x.id === DEFAULT_PRESET)!;
  const endMs = Date.now();
  return { step: p.step, startMs: endMs - p.durationMs, endMs };
}

/** The window as of NOW for a rolling preset, or the frozen one the operator
 *  entered. Called at run time, never cached — re-running after leaving the
 *  panel open should ask about the newer data. */
function resolve(): ResolvedRange {
  return fixed.value ?? stampNow();
}
defineExpose({ resolve });

/** What the menu seeds its custom form and opening tab from. */
const current = computed<ResolvedRange>(() => fixed.value ?? stampNow());

function stamp(ms: number, step: TimeStep): string {
  const d = new Date(ms);
  const z = (n: number) => String(n).padStart(2, '0');
  if (step === 'DAY') return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
  if (step === 'HOUR') return `${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}h`;
  return `${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}
const label = computed(() => {
  if (fixed.value) {
    const f = fixed.value;
    return `${stamp(f.startMs, f.step)} → ${stamp(f.endMs, f.step)}`;
  }
  return preset.value ? t(preset.value.label) : t('Last 1 hour');
});
const step = computed(() => (fixed.value ?? stampNow()).step);

const open = ref(false);
const triggerEl = ref<HTMLElement | null>(null);

function onPick(id: string): void {
  presetId.value = id;
  fixed.value = null;
  open.value = false;
  emit('change');
}
function onCustom(startMs: number, endMs: number, s: TimeStep): void {
  presetId.value = 'custom';
  fixed.value = { startMs, endMs, step: s };
  open.value = false;
  emit('change');
}

/**
 * Escape must close the MENU, not the modal behind it.
 *
 * `Modal` listens on `window` and `FloatingPanel` on `document`, both in the
 * bubble phase, so one Escape would otherwise dismiss the whole panel along
 * with the dropdown. A capture-phase listener runs before either and stops
 * the event there while the menu is open.
 */
function onEscapeCapture(e: KeyboardEvent): void {
  if (!open.value || e.key !== 'Escape') return;
  e.stopPropagation();
  open.value = false;
}
watch(open, (isOpen) => {
  if (isOpen) window.addEventListener('keydown', onEscapeCapture, true);
  else window.removeEventListener('keydown', onEscapeCapture, true);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onEscapeCapture, true));
</script>

<template>
  <div class="mrp-range">
    <span class="mrp-cap">{{ t('time range') }}</span>
    <button
      ref="triggerEl"
      type="button"
      class="sw-btn mrp-trigger"
      :title="t('time range')"
      @click="open = !open"
    >
      <Icon name="clock" :size="12" />
      <span>{{ label }} · {{ step }}</span>
      <Icon name="caret" :size="10" />
    </button>

    <!-- Teleported: the modal body scrolls, so a menu positioned inside it
         would be clipped at the body edge instead of floating over it. -->
    <FloatingPanel :open="open" :anchor="triggerEl" :width="280" @close="open = false">
      <TimeRangeMenu
        :preset-id="presetId"
        :current="current"
        :open="open"
        @pick="onPick"
        @custom="onCustom"
      />
    </FloatingPanel>
  </div>
</template>

<style scoped>
.mrp-range {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.mrp-cap {
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--sw-fg-3);
}
.mrp-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}
</style>
