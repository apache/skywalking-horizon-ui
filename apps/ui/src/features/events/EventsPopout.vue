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
  Per-service events popout. Mounted once in AppShell; opens when any surface
  (a layer's service banner) calls `useEventsPopout().open(layer, service)`.
  Shows that one service's events as a swimlane — one row per instance — with
  its own time window, without leaving the current page. Reuses EventsGantt (in
  `flat` mode) + the detail panel, scoped to the single service.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Modal from '@/features/operate/_shared/Modal.vue';
import EventsGantt from './EventsGantt.vue';
import EventsDetailPanel from './EventsDetailPanel.vue';
import { useEventsWindow, PRESETS, MAX_CUSTOM_MS } from './useEventsWindow';
import { useEvents, type EventFilterValues } from './useEvents';
import { useEventsPopout } from './useEventsPopout';
import type { EventRow } from '@/api/client';

const { t } = useI18n();
const { target, close } = useEventsPopout();

const win = useEventsWindow();
const applied = computed<EventFilterValues>(() => ({
  layer: target.value?.layer ?? '',
  service: target.value?.service ?? '',
  type: '',
  name: '',
}));
const enabled = computed<boolean>(() => !!target.value?.service);
const ev = useEvents(win.startTime, win.endTime, applied, enabled);

const open = computed<boolean>(() => target.value !== null);
const title = computed<string>(() => t('Events · {service}', { service: target.value?.service ?? '' }));

const selectedUuid = ref<string | null>(null);
const search = ref('');
const selectedEvent = computed<EventRow | null>(
  () => ev.events.value.find((e) => e.uuid === selectedUuid.value) ?? null,
);
function selectEvent(e: EventRow): void {
  selectedUuid.value = e.uuid;
}
watch(target, () => {
  selectedUuid.value = null;
  search.value = '';
});

function onClose(): void {
  close();
}
</script>

<template>
  <Modal :open="open" :title="title" width="min(1200px, 92vw)" @close="onClose">
    <div class="evtp">
      <div class="evtp__bar">
        <div class="evtp__window">
          <button
            v-for="p in PRESETS"
            :key="p"
            type="button"
            class="evtp__window-btn"
            :class="{ active: win.windowMode.value === p }"
            @click="win.pickPreset(p)"
          >{{ p }}</button>
          <button
            type="button"
            class="evtp__window-btn"
            :class="{ active: win.windowMode.value === 'custom' }"
            @click="win.openCustom()"
          >{{ t('custom') }}</button>
        </div>
        <input v-model="search" type="text" class="evtp__search" :placeholder="t('Search instance…')" />
        <span v-if="ev.isFetching.value" class="evtp__hint">{{ t('Reading data…') }}</span>
        <template v-else-if="ev.reachable.value">
          <span v-if="ev.truncated.value" class="evtp__warn">{{ t('Showing newest {n} — more available, narrow the range', { n: ev.events.value.length }) }}</span>
          <span v-else-if="ev.events.value.length > 0" class="evtp__hint">{{ t('{n} events · all in range shown', { n: ev.events.value.length }) }}</span>
        </template>
      </div>

      <div v-if="win.customOpen.value" class="evtp__custom">
        <label class="evtp__custom-field">
          <span>{{ t('Start') }}</span>
          <input v-model="win.customStartInput.value" type="datetime-local" step="60" />
        </label>
        <label class="evtp__custom-field">
          <span>{{ t('End') }}</span>
          <input v-model="win.customEndInput.value" type="datetime-local" step="60" />
        </label>
        <div v-if="win.customError.value" class="evtp__custom-err">{{ win.customError.value }}</div>
        <div class="evtp__custom-actions">
          <span class="evtp__custom-hint">{{ t('max {d}d', { d: MAX_CUSTOM_MS / 60_000 / 60 / 24 }) }}</span>
          <button type="button" class="evtp__custom-btn" @click="win.closeCustom()">{{ t('cancel') }}</button>
          <button type="button" class="evtp__custom-btn evtp__custom-btn--primary" @click="win.applyCustom()">{{ t('apply') }}</button>
        </div>
      </div>

      <div class="evtp__split">
        <div class="evtp__main">
          <div v-if="!ev.reachable.value" class="evtp__empty evtp__empty--err">
            {{ t('OAP is unreachable.') }} <span v-if="ev.errorMsg.value">{{ ev.errorMsg.value }}</span>
          </div>
          <div v-else-if="ev.isPending.value" class="evtp__empty">{{ t('Reading data…') }}</div>
          <EventsGantt
            v-else
            :events="ev.events.value"
            :start-time="win.startTime.value"
            :end-time="win.endTime.value"
            :selected-uuid="selectedUuid"
            :flat="true"
            :row-filter="search"
            @select-event="selectEvent"
          />
        </div>
        <EventsDetailPanel :event="selectedEvent" />
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.evtp { display: flex; flex-direction: column; gap: 12px; }
.evtp__bar { display: flex; align-items: center; gap: 12px; }
.evtp__window { display: flex; gap: 2px; background: var(--sw-bg-1); border: 1px solid var(--sw-line); border-radius: 6px; padding: 3px; }
.evtp__window-btn { background: transparent; border: 0; color: var(--sw-fg-2); font: inherit; font-size: 11.5px; padding: 4px 12px; border-radius: 4px; cursor: pointer; }
.evtp__window-btn:hover { color: var(--sw-fg-0); }
.evtp__window-btn.active { background: var(--sw-bg-3); color: var(--sw-fg-0); }
.evtp__search { background: var(--sw-bg-2); border: 1px solid var(--sw-line-2); color: var(--sw-fg-0); font: inherit; font-size: 12px; padding: 4px 8px; border-radius: 4px; min-width: 180px; }
.evtp__search:focus { outline: none; border-color: var(--sw-accent); }
.evtp__hint { font-size: 11px; color: var(--sw-fg-3); font-style: italic; }
.evtp__warn { font-size: 11px; color: var(--sw-warn); }
.evtp__custom { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 10px 12px; background: var(--sw-bg-1); border: 1px solid var(--sw-line); border-radius: 8px; }
.evtp__custom-field { display: flex; flex-direction: column; gap: 2px; font-size: 10.5px; color: var(--sw-fg-3); text-transform: uppercase; letter-spacing: 0.08em; }
.evtp__custom-field input { background: var(--sw-bg-2); border: 1px solid var(--sw-line); color: var(--sw-fg-0); font: inherit; font-size: 12px; padding: 4px 6px; border-radius: 4px; }
.evtp__custom-err { color: var(--sw-err); font-size: 11px; }
.evtp__custom-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.evtp__custom-hint { font-size: 10.5px; color: var(--sw-fg-3); }
.evtp__custom-btn { background: transparent; border: 1px solid var(--sw-line-2); color: var(--sw-fg-1); font: inherit; font-size: 11.5px; padding: 4px 12px; border-radius: 4px; cursor: pointer; }
.evtp__custom-btn--primary { background: var(--sw-accent); border-color: var(--sw-accent); color: #0a0d12; font-weight: 600; }
.evtp__split { display: grid; grid-template-columns: 1fr 320px; gap: 14px; align-items: start; }
@media (max-width: 900px) { .evtp__split { grid-template-columns: 1fr; } }
.evtp__main { min-width: 0; }
.evtp__empty { padding: 28px; text-align: center; font-size: 12px; color: var(--sw-fg-3); background: var(--sw-bg-1); border: 1px dashed var(--sw-line); border-radius: 8px; }
.evtp__empty--err { color: var(--sw-err); border-color: rgba(239,68,68,0.3); }
</style>
