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
 * The inner body of one matrix cell in `DebugLal.vue`. The payload is
 * OAP-serialized JSON whose field set varies by log format (LogData,
 * EnvoyAccessLogBuilder, a raw proto, …), so scalar fields render as a
 * generic key/value dump rather than a fixed subset; tags and body /
 * content keep their own groups. The view owns the surrounding
 * `.lal__cell` wrapper (selection/pin/click state); this renders only
 * what's inside it for a given step type + payload.
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { LalSamplePayload, SampleType } from '@skywalking-horizon-ui/api-client';
import {
  addedTags,
  bodyPreview,
  carriedTags,
  contentPreview,
  inputEntries,
  inputTags,
  outputEntries,
} from './lalPayload.js';

const props = defineProps<{
  stepType: SampleType;
  payload: LalSamplePayload | null;
  /** When set (the cell popout), body/content shows its complete pretty-
   *  printed value instead of the 80-char dense-matrix preview. */
  full?: boolean;
}>();

const { t } = useI18n({ useScope: 'global' });

/** Concrete payload class (LogData / LogBuilder / EnvoyAccessLogBuilder /
 *  the raw proto on the Envoy path) — shown as the cell's format kicker
 *  since the field set below depends on it. */
const ptype = computed(
  () => (props.stepType === 'input' ? props.payload?.input : props.payload?.output)?.type ?? '',
);
const bodyTxt = computed(() => bodyPreview(props.payload, props.full));
const contentTxt = computed(() => contentPreview(props.payload, props.full));
const inputKvs = computed(() => inputEntries(props.payload, props.full));
const outputKvs = computed(() => outputEntries(props.payload, props.full));
</script>

<template>
  <div v-if="ptype" class="lal__ptype">{{ ptype }}</div>
  <template v-if="props.stepType === 'input'">
    <div class="lal__kvs">
      <div v-for="kv in inputKvs" :key="kv.k" class="lal__kv">
        <span class="lal__kvk">{{ kv.k }}</span>
        <span class="lal__kvv">{{ kv.v }}</span>
      </div>
    </div>
    <div
      v-if="inputTags(props.payload).length > 0"
      class="lal__tags"
    >
      <span
        v-for="(tag, ti) in inputTags(props.payload)"
        :key="ti"
        class="lal__tag lal__tag--orig"
      >{{ tag.key }}={{ tag.value }}</span>
    </div>
    <div v-if="bodyTxt" class="lal__body" :class="{ 'lal__body--full': props.full }">
      {{ bodyTxt }}
    </div>
  </template>

  <!-- function / output -->
  <template v-else>
    <div class="lal__kvs">
      <div v-for="kv in outputKvs" :key="kv.k" class="lal__kv">
        <span class="lal__kvk">{{ kv.k }}</span>
        <span class="lal__kvv">{{ kv.v }}</span>
      </div>
    </div>
    <div
      v-if="carriedTags(props.payload).length > 0"
      class="lal__taggroup"
    >
      <span class="lal__tagheader">{{ t('carried') }}</span>
      <span
        v-for="(tag, ti) in carriedTags(props.payload)"
        :key="`o-${ti}`"
        class="lal__tag lal__tag--orig"
      >{{ tag.key }}={{ tag.value }}</span>
    </div>
    <div
      v-if="addedTags(props.payload).length > 0"
      class="lal__taggroup"
    >
      <span class="lal__tagheader">{{ t('+ added') }}</span>
      <span
        v-for="(tag, ti) in addedTags(props.payload)"
        :key="`a-${ti}`"
        class="lal__tag"
        :class="tag.status === 'lal-override' ? 'lal__tag--over' : 'lal__tag--add'"
      >{{ tag.key }}={{ tag.value }}</span>
    </div>
    <div v-if="contentTxt" class="lal__body" :class="{ 'lal__body--full': props.full }">
      {{ contentTxt }}
    </div>
  </template>
  <div v-if="props.payload?.aborted" class="lal__abort">{{ t('aborted') }}</div>
</template>

<style scoped>
.lal__kvs {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px 8px;
}

.lal__kv {
  display: contents;
}

.lal__kvk {
  color: var(--sw-fg-3);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  align-self: start;
}

.lal__kvv {
  color: var(--rr-ink);
  word-break: break-all;
  white-space: pre-wrap;
  font-size: var(--sw-fs-sm);
}

.lal__body {
  background: var(--rr-bg2);
  border: 1px solid var(--rr-border);
  padding: 4px 6px;
  color: var(--rr-ink2);
  font-size: var(--sw-fs-xs);
  line-height: 1.4;
  word-break: break-all;
  white-space: pre-wrap;
}

/* Cell popout: the complete pretty-printed content, slightly larger and
   more legible than the dense one-line preview. */
.lal__body--full {
  font-size: var(--sw-fs-sm);
  color: var(--rr-ink);
}

.lal__ptype {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  color: var(--rr-dim);
  word-break: break-all;
}

.lal__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}

.lal__taggroup {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px;
}

.lal__tagheader {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
  margin-right: 4px;
  flex-shrink: 0;
}

.lal__tag {
  padding: 1px 5px;
  font-size: var(--sw-fs-xs);
  border: 1px solid var(--rr-border);
  background: var(--rr-bg);
  color: var(--rr-ink2);
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lal__tag--orig {
  color: var(--rr-ink2);
}

.lal__tag--add {
  color: var(--rr-accent, var(--rr-active));
  border-color: var(--rr-accent, var(--rr-active));
}

.lal__tag--over {
  color: var(--rr-warn, #d6a96d);
  border-color: var(--rr-warn, #d6a96d);
}

.lal__abort {
  color: var(--rr-warn, #d6a96d);
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
}
</style>
