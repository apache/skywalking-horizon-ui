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
<!-- Read-only pod-log block: renders the exact lines the assistant fetched
     on-demand, as text. It is a result, not a console — no tail, no refresh, no
     re-query (operate a live tail in the Pod Logs tab). The active content
     filter, if any, is shown so an empty result reads as "nothing matched this
     filter", not "the pod is silent". -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import Icon from '@/components/icons/Icon.vue';
import type { PodLogSpec } from './types';

const props = defineProps<{ n: number; spec: PodLogSpec }>();
const { t } = useI18n({ useScope: 'global' });

const target = computed(() => [props.spec.service, props.spec.pod].filter(Boolean).join(' / '));
const text = computed(() => props.spec.initialLines.map((l) => l.content).join('\n'));
const hasLines = computed(() => props.spec.initialLines.length > 0);

const includeKw = computed<string[]>(() => props.spec.keywordsOfContent ?? []);
const excludeKw = computed<string[]>(() => props.spec.excludingKeywordsOfContent ?? []);
const hasFilter = computed(() => includeKw.value.length > 0 || excludeKw.value.length > 0);
</script>

<template>
  <div class="plog">
    <div class="plog__head">
      <Icon name="log" :size="14" />
      <span class="plog__num">{{ n }}</span>
      <span class="plog__title">{{ spec.title }}</span>
    </div>

    <div class="plog__meta">
      <span v-if="target" class="plog__target">{{ target }}</span>
      <span v-if="target" class="plog__sep">·</span>
      <span class="plog__container-name">{{ spec.container }}</span>
    </div>

    <div v-if="hasFilter" class="plog__filter">
      <span class="plog__filter-label">{{ t('Content filter') }}</span>
      <template v-if="includeKw.length">
        <span class="plog__filter-op">{{ t('match') }}</span>
        <code v-for="k in includeKw" :key="'i:' + k" class="plog__filter-kw">{{ k }}</code>
      </template>
      <template v-if="excludeKw.length">
        <span class="plog__filter-op">{{ t('exclude') }}</span>
        <code v-for="k in excludeKw" :key="'e:' + k" class="plog__filter-kw plog__filter-kw--ex">{{ k }}</code>
      </template>
    </div>

    <p v-if="spec.errorReason" class="plog__err">{{ spec.errorReason }}</p>

    <div class="plog__body">
      <pre v-if="hasLines" class="plog__pre">{{ text }}</pre>
      <p v-else class="plog__empty">
        {{
          hasFilter
            ? t('No lines matched this content filter in the window.')
            : t('No log lines in this window.')
        }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.plog {
  border: 1px solid var(--sw-line-2);
  border-left: 3px solid var(--sw-accent);
  border-radius: 8px;
  background: var(--sw-bg-1);
  padding: 10px 12px;
  margin: 0 0 8px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.plog__head {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--sw-fg-0);
}
.plog__num {
  font-size: var(--sw-fs-xs);
  font-family: var(--sw-mono);
  color: var(--sw-fg-3);
}
.plog__title {
  font-size: var(--sw-fs-sm);
  font-weight: var(--sw-fw-semibold);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plog__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-2);
  font-family: var(--sw-mono);
  flex-wrap: wrap;
}
.plog__sep {
  color: var(--sw-fg-3);
}
.plog__filter {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  font-size: var(--sw-fs-xs);
}
.plog__filter-label {
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--sw-fg-3);
}
.plog__filter-op {
  color: var(--sw-fg-3);
  font-style: italic;
}
.plog__filter-kw {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-xs);
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-1);
}
.plog__filter-kw--ex {
  color: var(--sw-fg-3);
  text-decoration: line-through;
}
.plog__err {
  margin: 0;
  padding: 6px 8px;
  border-radius: 5px;
  background: var(--sw-bg-0);
  border: 1px solid var(--sw-line-2);
  font-size: var(--sw-fs-xs);
  color: var(--sw-err);
}
.plog__body {
  max-height: 320px;
  overflow: auto;
  background: var(--sw-bg-0);
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  padding: 8px 10px;
}
.plog__pre {
  margin: 0;
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-xs);
  line-height: var(--sw-lh-normal);
  color: var(--sw-fg-1);
  white-space: pre-wrap;
  word-break: break-word;
}
.plog__empty {
  margin: 0;
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-3);
  font-style: italic;
}
</style>
