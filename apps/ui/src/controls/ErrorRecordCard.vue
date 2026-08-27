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
/**
 * One failure, rendered the same wherever it is read.
 *
 * The refresh history and the toasts show the SAME record and must not drift
 * into two vocabularies for one event — an operator who reads "Topology ·
 * could not be read" in a toast should find that exact line in the history
 * afterwards.
 *
 * Everything is bound through `{{ }}`. There is no `v-html` here and there
 * must never be: the summary, the URL and the body all originate outside the
 * UI, and a failure card is the last place that should be able to execute
 * what it is describing.
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import Icon from '@/components/icons/Icon.vue';
import type { UiErrorRecord } from './errorCenter';

const props = defineProps<{ record: UiErrorRecord; expanded?: boolean }>();
const emit = defineEmits<{ (e: 'toggle'): void }>();
const { t } = useI18n({ useScope: 'global' });

const time = computed(() => new Date(props.record.occurredAt).toLocaleTimeString());
/** A status is worth a line only when there was one — a request that never got
 *  a reply carries 0, and printing "0" as a status invents an answer. */
const status = computed(() => (props.record.status ? String(props.record.status) : t('no response')));
const hasDetail = computed(() =>
  Boolean(props.record.detail || props.record.responseBody || props.record.url),
);
</script>

<template>
  <div class="err-card">
    <div class="err-head">
      <Icon name="alert" :size="12" class="err-icon" />
      <span class="err-owner">{{ t(record.owner) }}</span>
      <span class="err-time mono">{{ time }}</span>
    </div>
    <div class="err-summary">{{ record.summaryKey ? t(record.summaryKey) : record.summary }}</div>
    <div class="err-meta mono">
      <span>{{ t(record.action) }}</span>
      <span class="sep">·</span>
      <span>{{ status }}</span>
      <button
        v-if="hasDetail"
        type="button"
        class="err-more"
        :aria-expanded="expanded ? 'true' : 'false'"
        @click.stop="emit('toggle')"
      >{{ expanded ? t('Hide details') : t('Details') }}</button>
    </div>
    <div v-if="expanded && hasDetail" class="err-detail mono">
      <div v-if="record.url" class="err-line">{{ record.method ?? 'GET' }} {{ record.url }}</div>
      <div v-if="record.detail" class="err-line">{{ record.detail }}</div>
      <pre v-if="record.responseBody" class="err-body">{{ record.responseBody }}</pre>
    </div>
  </div>
</template>

<style scoped>
.err-card {
  padding: 6px 8px;
  border-radius: 5px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
}
.err-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
}
.err-icon { color: var(--sw-danger, #e5534b); flex: none; }
.err-owner { color: var(--sw-fg-1); font-weight: 600; }
.err-time { margin-left: auto; color: var(--sw-fg-3, var(--sw-fg-2)); font-variant-numeric: tabular-nums; }
.err-summary {
  margin-top: 3px;
  font-size: 11px;
  color: var(--sw-fg-1);
  overflow-wrap: anywhere;
}
.err-meta {
  margin-top: 3px;
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  color: var(--sw-fg-2);
}
.err-meta .sep { opacity: 0.5; }
.err-more {
  margin-left: auto;
  background: none;
  border: none;
  padding: 0;
  color: var(--sw-accent-2, var(--sw-accent));
  font: inherit;
  cursor: pointer;
}
.err-detail {
  margin-top: 5px;
  padding-top: 5px;
  border-top: 1px solid var(--sw-line);
  font-size: 10px;
  color: var(--sw-fg-2);
}
.err-line { overflow-wrap: anywhere; }
.err-body {
  margin: 4px 0 0;
  max-height: 180px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--sw-fg-2);
}
</style>
