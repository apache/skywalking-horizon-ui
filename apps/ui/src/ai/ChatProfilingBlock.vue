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
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import ProfileFlameGraph from '@/layer/profiling/ProfileFlameGraph.vue';
import NativeTraceWaterfall from '@/layer/traces/NativeTraceWaterfall.vue';
import ChatCapturedTag from './ChatCapturedTag.vue';
import type { ProfilingResultSpec } from './types';

const props = defineProps<{ n: number; spec: ProfilingResultSpec; capturedAt?: number }>();
const { t } = useI18n({ useScope: 'global' });

const hasData = computed<boolean>(() => props.spec.reachable && props.spec.trees.some((tr) => tr.elements.length));
const trace = computed(() => props.spec.traceContext ?? null);

// Compact task facts — the flame carries no context of its own.
const facts = computed<string[]>(() => {
  const s = props.spec.summary;
  const out: string[] = [];
  if (props.spec.profilingType === 'trace') {
    out.push(s.endpoint ? `endpoint ${s.endpoint}` : t('all endpoints'));
    if (s.segmentCount != null) out.push(t('{n} segments', { n: s.segmentCount }));
  } else {
    if (s.events?.length) out.push(s.events.join(' / '));
    if (s.instances?.length) out.push(t('{n} instances', { n: s.instances.length }));
  }
  if (s.durationLabel) out.push(s.durationLabel);
  if (s.frameCount) out.push(t('{n} frames', { n: s.frameCount }));
  return out;
});
</script>

<template>
  <div class="cpf">
    <div class="cpf__cap">
      {{ t('Figure {n}', { n }) }} · {{ spec.title }}<ChatCapturedTag :at="capturedAt" />
    </div>
    <div class="cpf__facts">
      <span class="cpf__type">{{ spec.profilingType }}</span>
      <span v-for="(f, i) in facts" :key="i" class="cpf__fact">{{ f }}</span>
    </div>
    <p v-if="spec.tip" class="cpf__tip">{{ spec.tip }}</p>
    <!-- The captured waterfall is frozen data — show it even when the analyze
         returned no stacks; only the flame section falls back to the empty state. -->
    <template v-if="trace">
      <div class="cpf__label">{{ t('Profiled trace') }} · <span class="cpf__tid">{{ trace.traceId }}</span></div>
      <div class="cpf__wf">
        <NativeTraceWaterfall :spans="trace.spans" :mark-profiled="true" />
      </div>
      <div class="cpf__label">{{ t('Flame graph') }}</div>
    </template>
    <div v-if="hasData" class="cpf__flame">
      <ProfileFlameGraph :trees="spec.trees" :metric-key="spec.metricKey" />
    </div>
    <div v-else class="cpf__empty">
      <template v-if="!spec.reachable">{{ t('Could not read the profile.') }}<span v-if="spec.error"> — {{ spec.error }}</span></template>
      <template v-else-if="spec.error">{{ spec.error }}</template>
      <template v-else>{{ t('No profile data was collected in this task yet.') }}</template>
    </div>
  </div>
</template>

<style scoped>
.cpf {
  border: 1px solid var(--sw-line, #2a2d36);
  border-radius: 8px;
  background: var(--sw-bg-1, #1b1d24);
  overflow: hidden;
  margin: 8px 0;
}
.cpf__cap {
  padding: 8px 12px;
  font-size: 12px;
  color: var(--sw-fg-2, #9aa0ac);
  border-bottom: 1px solid var(--sw-line, #2a2d36);
}
.cpf__facts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 8px 12px 0;
  font-size: 11px;
  color: var(--sw-fg-2, #9aa0ac);
}
.cpf__type {
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 600;
  color: var(--sw-fg-0, #f5f7fb);
  background: var(--sw-bg-2, #22252e);
  border-radius: 4px;
  padding: 1px 6px;
}
.cpf__fact {
  font-variant-numeric: tabular-nums;
}
.cpf__fact::before {
  content: '·';
  margin-right: 6px;
  color: var(--sw-fg-3, #6b6f7a);
}
.cpf__tip {
  margin: 8px 12px 0;
  font-size: 11px;
  color: var(--sw-warn, #d9a441);
}
.cpf__label {
  padding: 8px 12px 4px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--sw-fg-3, #6b6f7a);
}
.cpf__tid {
  font-family: var(--sw-mono, monospace);
  text-transform: none;
  letter-spacing: 0;
  color: var(--sw-fg-2, #9aa0ac);
}
.cpf__wf {
  height: 260px;
  overflow: auto;
  margin: 0 8px;
  border: 1px solid var(--sw-line, #2a2d36);
  border-radius: 6px;
}
.cpf__flame {
  height: 420px;
  margin-top: 8px;
}
.cpf__empty {
  padding: 24px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--sw-fg-3, #6b6f7a);
}
</style>
