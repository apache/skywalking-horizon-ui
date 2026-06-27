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
  Alarms time-window picker: 20m / 2h / 4h preset buttons + a custom
  range editor (datetime-local inputs, ≤4h cap). Binds an `AlarmWindow`
  state machine (see useAlarmWindow.ts); owns no alarm data itself.

  Renders as two pieces: the inline preset button group (slot
  `default`, lives in the header actions) and the custom editor row
  (slot `editor`, lives below the header at the page root). The parent
  places each where the layout needs it.
-->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useEscapeToClose } from '@/components/primitives/useEscapeToClose';
import { PRESETS, MAX_CUSTOM_MS, type AlarmWindow } from './useAlarmWindow';

const { t } = useI18n();
const props = defineProps<{ window: AlarmWindow; part: 'buttons' | 'editor' }>();
const w = props.window;

useEscapeToClose(() => w.customOpen.value, () => w.closeCustom());
</script>

<template>
  <div v-if="part === 'buttons'" class="ax__window">
    <button
      v-for="p in PRESETS"
      :key="p"
      type="button"
      class="ax__window-btn"
      :class="{ active: w.windowMode.value === p }"
      @click="w.pickPreset(p)"
    >{{ p }}</button>
    <button
      type="button"
      class="ax__window-btn"
      :class="{ active: w.windowMode.value === 'custom' }"
      @click="w.openCustom()"
    >{{ t('custom') }}</button>
  </div>

  <div v-else-if="part === 'editor' && w.customOpen.value" class="ax__custom">
    <label class="ax__custom-field">
      <span>{{ t('Start') }}</span>
      <input v-model="w.customStartInput.value" type="datetime-local" step="60" />
    </label>
    <label class="ax__custom-field">
      <span>{{ t('End') }}</span>
      <input v-model="w.customEndInput.value" type="datetime-local" step="60" />
    </label>
    <div v-if="w.customError.value" class="ax__custom-err">{{ w.customError.value }}</div>
    <div class="ax__custom-actions">
      <span class="ax__custom-hint">{{ t('max {h}h', { h: MAX_CUSTOM_MS / 60_000 / 60 }) }}</span>
      <button type="button" class="ax__custom-btn" @click="w.closeCustom()">{{ t('cancel') }}</button>
      <button type="button" class="ax__custom-btn ax__custom-btn--primary" @click="w.applyCustom()">{{ t('apply') }}</button>
    </div>
  </div>
</template>

<style scoped>
.ax__window {
  display: flex;
  gap: 2px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  padding: 3px;
}
.ax__window-btn {
  background: transparent;
  border: 0;
  color: var(--sw-fg-2);
  font: inherit;
  font-size: 11.5px;
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
}
.ax__window-btn:hover { color: var(--sw-fg-0); }
.ax__window-btn.active {
  background: var(--sw-bg-3);
  color: var(--sw-fg-0);
}

.ax__custom {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  margin-bottom: 12px;
}
.ax__custom-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 10.5px;
  color: var(--sw-fg-3);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.ax__custom-field input {
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 4px;
}
.ax__custom-err {
  color: var(--sw-err);
  font-size: 11px;
}
.ax__custom-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
.ax__custom-hint {
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.ax__custom-btn {
  background: transparent;
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-1);
  font: inherit;
  font-size: 11.5px;
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
}
.ax__custom-btn--primary {
  background: var(--sw-accent);
  border-color: var(--sw-accent);
  color: #0a0d12;
  font-weight: 600;
}
</style>
