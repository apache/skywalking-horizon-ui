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
<!-- The time window the assistant scopes its next question to (own range, not the topbar). -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import Icon from '@/components/icons/Icon.vue';
import { AI_TIME_PRESETS, aiTimePresetId } from './scope';

const { t } = useI18n({ useScope: 'global' });
</script>

<template>
  <label class="scope">
    <Icon name="clock" :size="13" />
    <select v-model="aiTimePresetId" class="scope__sel" :aria-label="t('Time range')">
      <option v-for="p in AI_TIME_PRESETS" :key="p.id" :value="p.id">{{ t(p.labelKey) }}</option>
    </select>
  </label>
</template>

<style scoped>
.scope {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 8px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  border-radius: 7px;
  color: var(--sw-fg-2);
}
.scope__sel {
  background: transparent;
  border: 0;
  color: var(--sw-fg-1);
  font: inherit;
  font-size: var(--sw-fs-sm);
  cursor: pointer;
  outline: none;
}
.scope__sel option {
  background: var(--sw-bg-2);
  color: var(--sw-fg-0);
}
</style>
