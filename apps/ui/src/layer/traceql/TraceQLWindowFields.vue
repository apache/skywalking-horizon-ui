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
  The window and the result cap.

  They belong to the page rather than to a query mode — this tab owns its time
  range and the topbar's picker is disabled while on it — so every mode renders
  these, in the position the native Traces tab puts them.
-->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import DateTimeField from '@/components/primitives/DateTimeField.vue';
import { TIME_RANGE_PRESETS } from '@/layer/logs/useLogTimeRange';
import { NO_TIME_RANGE } from './useTraceQL';

const props = defineProps<{
  /** The picker's "Custom…" choice, owned by the page so both agree on it. */
  customRange: number;
  /** A lookup by id may have no window at all, and no cap to apply. */
  traceIdMode?: boolean;
}>();

const windowMinutes = defineModel<number>('windowMinutes', { required: true });
const customStart = defineModel<string>('customStart', { required: true });
const customEnd = defineModel<string>('customEnd', { required: true });
const limit = defineModel<number>('limit', { required: true });

const { t } = useI18n({ useScope: 'global' });
</script>

<template>
  <label v-if="!props.traceIdMode" class="cf">
    <span>{{ t('Limit') }}</span>
    <select v-model.number="limit" class="cf-input">
      <option :value="20">20</option>
      <option :value="30">30</option>
      <option :value="50">50</option>
      <option :value="100">100</option>
    </select>
  </label>
  <label class="cf">
    <span>{{ t('Time range') }}</span>
    <select v-model.number="windowMinutes" class="cf-input">
      <option v-if="props.traceIdMode" :value="NO_TIME_RANGE">{{ t('No time range') }}</option>
      <option v-for="pr in TIME_RANGE_PRESETS" :key="pr.minutes" :value="pr.minutes">{{ t(pr.label) }}</option>
      <option :value="props.customRange">{{ t('Custom range…') }}</option>
    </select>
  </label>
  <label v-if="windowMinutes === props.customRange" class="cf">
    <span>{{ t('From') }}</span>
    <DateTimeField v-model="customStart" />
  </label>
  <label v-if="windowMinutes === props.customRange" class="cf">
    <span>{{ t('To') }}</span>
    <DateTimeField v-model="customEnd" />
  </label>
</template>
