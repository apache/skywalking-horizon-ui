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
  The layer's log type: which source its logs come from, which picks the tags
  the Logs tab's Tags field suggests. Native is the default and is written as
  an absent `type`, so a template only names the type when it is OTLP.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { LOG_TYPES, logTypeOf, type LogConfig, type LogType } from '@skywalking-horizon-ui/api-client';

const props = defineProps<{ log?: LogConfig; readOnly?: boolean }>();
const emit = defineEmits<{ (e: 'update', value: LogConfig | undefined): void }>();
const { t } = useI18n({ useScope: 'global' });

const current = computed(() => logTypeOf(props.log));

const ROWS = computed(() =>
  LOG_TYPES.map((type) => ({
    type,
    label: type === 'native' ? t('SkyWalking native') : 'OTLP',
    hint:
      type === 'native'
        ? t('Logs sent over the SkyWalking native protocols: SkyWalking agents, Envoy access logs through ALS, and the rest. The default when the template names no type.')
        : t('Logs received over OTLP, from OpenTelemetry SDKs and collectors.'),
  })),
);

function pick(type: LogType): void {
  if (props.readOnly || type === current.value) return;
  const next: LogConfig = { ...(props.log ?? {}) };
  if (type === 'native') delete next.type;
  else next.type = type;
  emit('update', Object.keys(next).length > 0 ? next : undefined);
}
</script>

<template>
  <div class="lt-list" role="radiogroup" :aria-label="t('Log type')">
    <label v-for="row in ROWS" :key="row.type" class="lt-item" :class="{ on: current === row.type }">
      <span class="lt-head">
        <input
          type="radio"
          name="layer-log-type"
          :value="row.type"
          :checked="current === row.type"
          :disabled="readOnly"
          @change="pick(row.type)"
        />
        <span class="lt-name">{{ row.label }}</span>
        <code class="lt-code">{{ row.type }}</code>
      </span>
      <span class="lt-hint">{{ row.hint }}</span>
    </label>
    <p class="lt-note">
      {{ t('SkyWalking 11.2 and later keep the searchable tags of OTLP logs apart from those of every other log, so the Tags field suggests the tags of this type only. An earlier OAP keeps one list for both, and this choice changes nothing there.') }}
    </p>
  </div>
</template>

<style scoped>
.lt-list { display: flex; flex-direction: column; gap: 6px; }
.lt-item {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  padding: 8px 10px;
  background: var(--sw-bg-1);
  cursor: pointer;
}
.lt-item.on { border-color: var(--sw-accent); background: var(--sw-bg-2); }
.lt-head { display: flex; align-items: center; gap: 8px; }
.lt-name { font-size: 12.5px; color: var(--sw-fg-0); }
.lt-code {
  font-family: var(--sw-mono);
  font-size: 10px;
  color: var(--sw-fg-3);
  background: var(--sw-bg-2);
  border-radius: 3px;
  padding: 0 4px;
}
.lt-hint { margin: 3px 0 0 22px; font-size: 10.5px; color: var(--sw-fg-3); line-height: 1.4; }
.lt-note { margin: 2px 11px 8px; font-size: 10.5px; color: var(--sw-fg-3); line-height: 1.4; }
</style>
