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
<!-- Decision card for a proposed mutating action (profiling). Shows the agent's
     reasoning — the analysed cause, why profiling, what it expects — and only
     on Approve does it call the existing verb-gated profile-create route. -->
<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { bff } from '@/api/client';
import Icon from '@/components/icons/Icon.vue';
import { useAiConversations } from './useAiConversations';
import type { ProposalBlock } from './types';

const props = defineProps<{ block: ProposalBlock }>();
const { t } = useI18n({ useScope: 'global' });
const conv = useAiConversations();
const busy = ref(false);

async function approve(): Promise<void> {
  const s = props.block.spec;
  busy.value = true;
  try {
    const res = await bff.profile.create(s.layer.toLowerCase(), {
      serviceId: s.serviceId,
      endpointName: s.endpoint ?? '',
      startTime: Date.now(),
      duration: s.durationMinutes,
      minDurationThreshold: 0,
      dumpPeriod: 10,
      maxSamplingCount: 5,
    });
    if (!res.reachable || res.errorReason) {
      conv.resolveProposal(props.block, 'failed', { error: res.errorReason ?? res.error ?? '' });
    } else {
      conv.resolveProposal(props.block, 'approved', { taskId: res.id });
    }
  } catch (e) {
    conv.resolveProposal(props.block, 'failed', { error: e instanceof Error ? e.message : String(e) });
  } finally {
    busy.value = false;
  }
}
function dismiss(): void {
  conv.resolveProposal(props.block, 'dismissed');
}
</script>

<template>
  <div class="prop" :class="`is-${block.status}`">
    <div class="prop__head">
      <Icon name="ai" :size="15" />
      <span>{{ t('Suggested action: start trace profiling') }}</span>
    </div>
    <dl class="prop__facts">
      <div><dt>{{ t('Cause') }}</dt><dd>{{ block.spec.cause }}</dd></div>
      <div><dt>{{ t('Why profiling') }}</dt><dd>{{ block.spec.rationale }}</dd></div>
      <div><dt>{{ t('Expected') }}</dt><dd>{{ block.spec.expectation }}</dd></div>
    </dl>
    <div class="prop__target">
      {{ block.spec.service }}<template v-if="block.spec.endpoint"> · {{ block.spec.endpoint }}</template> · {{ block.spec.durationMinutes }}m
    </div>
    <div v-if="block.status === 'pending'" class="prop__actions">
      <button type="button" class="prop__btn" :disabled="busy" @click="dismiss">{{ t('Dismiss') }}</button>
      <button type="button" class="prop__btn prop__btn--primary" :disabled="busy" @click="approve">
        {{ busy ? t('Starting…') : t('Approve & start') }}
      </button>
    </div>
    <p v-else-if="block.status === 'approved'" class="prop__out">
      {{ t('Profiling started — ask me to analyze the results once it has collected data.') }}
    </p>
    <p v-else-if="block.status === 'dismissed'" class="prop__out">{{ t('Dismissed.') }}</p>
    <p v-else class="prop__out prop__out--err">{{ t('Could not start profiling.') }} {{ block.error }}</p>
  </div>
</template>

<style scoped>
.prop {
  border: 1px solid var(--sw-line-2);
  border-left: 3px solid var(--sw-accent);
  border-radius: 8px;
  background: var(--sw-bg-1);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.prop.is-dismissed {
  opacity: 0.6;
  border-left-color: var(--sw-line-2);
}
.prop.is-approved {
  border-left-color: var(--sw-green, #2ea043);
}
.prop.is-failed {
  border-left-color: var(--sw-red, #d1242f);
}
.prop__head {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: var(--sw-fs-sm);
  font-weight: var(--sw-fw-semibold);
  color: var(--sw-fg-0);
}
.prop__facts {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.prop__facts > div {
  display: grid;
  grid-template-columns: 96px 1fr;
  gap: 8px;
}
.prop__facts dt {
  margin: 0;
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-2);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.prop__facts dd {
  margin: 0;
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-1);
}
.prop__target {
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-2);
  font-family: var(--sw-font-mono, monospace);
}
.prop__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.prop__btn {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
  font: inherit;
  font-size: var(--sw-fs-sm);
  cursor: pointer;
}
.prop__btn--primary {
  background: var(--sw-accent);
  border-color: var(--sw-accent);
  color: #0a0d12;
  font-weight: var(--sw-fw-semibold);
}
.prop__btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.prop__out {
  margin: 0;
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-1);
}
.prop__out--err {
  color: var(--sw-red, #d1242f);
}
</style>
