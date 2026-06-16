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
  Phase stepper for a structural `/addOrUpdate` apply. The POST returns at
  FENCING (DDL already fired) and the rest runs in OAP's background, so this
  renders the live phase the editor polls from `/runtime/rule/status`:
  Compiled → Confirming (FENCING) → Committing (ROLLING_OUT) → Done.
  DEGRADED is a warning (durable + converging), FAILED is rolled back. The
  parent owns the poll and the recover/re-check/dismiss actions; this only
  renders + emits.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ApplyPhase } from '@skywalking-horizon-ui/api-client';
import Section from '@/components/primitives/Section.vue';
import Btn from '@/components/primitives/Btn.vue';

const props = defineProps<{
  phase: ApplyPhase;
  failureReason?: string;
  fenceLaggards?: string[];
  /** `'durable-dao'` → the status was reconstructed from the durable row
   *  (e.g. after a reload) rather than live progress. */
  derivedFrom?: string;
  /** Gate the recover button on `rule:write:structural`. */
  canRecover?: boolean;
  /** A recover / re-check apply is in flight — disable the actions. */
  busy?: boolean;
}>();

const emit = defineEmits<{ recover: []; recheck: []; dismiss: [] }>();

const { t } = useI18n();

type Marker = 'done' | 'active' | 'pending' | 'ok' | 'warn' | 'err';

const steps = computed<{ label: string; marker: Marker }[]>(() => {
  const labels = [
    t('Compiled & schema applied'),
    t('Confirming across the cluster…'),
    t('Committing'),
    t('Done'),
  ];
  const markers = markersFor(props.phase);
  return labels.map((label, i) => ({ label, marker: markers[i] }));
});

function markersFor(phase: ApplyPhase): Marker[] {
  switch (phase) {
    case 'PENDING':
    case 'DDL':
      return ['active', 'pending', 'pending', 'pending'];
    case 'FENCING':
      return ['done', 'active', 'pending', 'pending'];
    case 'ROLLING_OUT':
      return ['done', 'done', 'active', 'pending'];
    case 'APPLIED':
      return ['done', 'done', 'done', 'ok'];
    case 'DEGRADED':
      return ['done', 'done', 'done', 'warn'];
    case 'FAILED':
      // Rolled back — nothing durable landed (the cluster stays on the prior
      // rule), so don't mark any step done; a ✓ here would contradict the
      // "rolled back" banner. Only the terminal node shows the failure.
      return ['pending', 'pending', 'pending', 'err'];
    default:
      return ['pending', 'pending', 'pending', 'pending'];
  }
}

const GLYPH: Record<Marker, string> = {
  done: '✓',
  ok: '✓',
  active: '●',
  pending: '○',
  warn: '!',
  err: '✕',
};

const isTerminal = computed(
  () => props.phase === 'APPLIED' || props.phase === 'DEGRADED' || props.phase === 'FAILED',
);
const fromStored = computed(() => props.derivedFrom === 'durable-dao');

const title = computed(() => {
  switch (props.phase) {
    case 'APPLIED':
      return fromStored.value ? t('applied (from stored state)') : t('Schema change applied');
    case 'DEGRADED':
      return t('Applied — cluster propagation unconfirmed');
    case 'FAILED':
      return t('Apply failed — rolled back');
    default:
      return t('Applying schema change');
  }
});
</script>

<template>
  <Section :title="title" :data-testid="'apply-progress'" :data-phase="phase">
    <div class="ap">
      <ol class="ap__steps">
        <li v-for="(s, i) in steps" :key="i" class="ap__step">
          <span class="ap__glyph" :class="[`ap__glyph--${s.marker}`, { 'ap__glyph--pulse': s.marker === 'active' }]">
            {{ GLYPH[s.marker] }}
          </span>
          <span class="ap__label" :class="{ 'ap__label--muted': s.marker === 'pending' }">{{ s.label }}</span>
          <span v-if="i < steps.length - 1" class="ap__bar" :class="{ 'ap__bar--done': s.marker === 'done' || s.marker === 'ok' }" />
        </li>
      </ol>

      <p v-if="!isTerminal" class="ap__caption">
        {{ t('Schema changes apply across the cluster in the background — usually seconds, up to a few minutes if a node is slow. You can leave this page.') }}
      </p>

      <div v-else-if="phase === 'DEGRADED'" class="ap__banner ap__banner--warn">
        <p class="ap__msg">
          {{ t('Durable and applied, but cluster-wide schema propagation wasn’t confirmed in time. The listed nodes catch up automatically on their next scan.') }}
        </p>
        <p v-if="fenceLaggards && fenceLaggards.length" class="ap__nodes">
          {{ t('Waiting on: {nodes}', { nodes: fenceLaggards.join(', ') }) }}
        </p>
        <p v-if="failureReason" class="ap__reason">{{ failureReason }}</p>
      </div>

      <div v-else-if="phase === 'FAILED'" class="ap__banner ap__banner--err">
        <p class="ap__msg">
          {{ t('The change was rolled back; the cluster is still on the previous rule. Fix the issue and save again.') }}
        </p>
        <p v-if="failureReason" class="ap__reason">{{ failureReason }}</p>
      </div>

      <div v-if="phase === 'DEGRADED' || phase === 'FAILED'" class="ap__actions">
        <Btn
          v-if="canRecover"
          size="sm"
          :disabled="busy"
          :data-testid="'apply-recover'"
          @click="emit('recover')"
        >
          {{ t('Force re-apply (recover)') }}
        </Btn>
        <Btn v-if="phase === 'DEGRADED'" size="sm" :disabled="busy" @click="emit('recheck')">
          {{ t('Re-check') }}
        </Btn>
        <Btn size="sm" :disabled="busy" @click="emit('dismiss')">{{ t('Dismiss') }}</Btn>
      </div>
    </div>
  </Section>
</template>

<style scoped>
.ap {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ap__steps {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.ap__step {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ap__glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  font-family: var(--rr-font-mono);
  font-size: 12px;
  line-height: 1;
  color: var(--rr-dim);
}
.ap__glyph--done,
.ap__glyph--ok {
  color: var(--rr-ok);
}
.ap__glyph--active {
  color: var(--rr-info);
}
.ap__glyph--warn {
  color: var(--rr-warn);
}
.ap__glyph--err {
  color: var(--rr-err);
}
.ap__glyph--pulse {
  animation: ap-pulse 1.2s ease-in-out infinite;
}
@keyframes ap-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}

.ap__label {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-ink2);
}
.ap__label--muted {
  color: var(--rr-dim);
}

.ap__bar {
  width: 22px;
  height: 1px;
  margin-left: 2px;
  background: var(--rr-border2);
}
.ap__bar--done {
  background: color-mix(in oklch, var(--rr-ok) 60%, var(--rr-border2));
}

.ap__caption {
  margin: 0;
  font-size: var(--sw-fs-base);
  color: var(--rr-dim);
  line-height: var(--sw-lh-tight);
}

.ap__banner {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border-radius: var(--rr-radius-md);
  border-left: 2px solid var(--rr-border2);
  background: var(--rr-bg2);
}
.ap__banner--warn {
  border-left-color: var(--rr-warn);
}
.ap__banner--err {
  border-left-color: var(--rr-err);
}

.ap__msg {
  margin: 0;
  font-size: var(--sw-fs-base);
  color: var(--rr-ink2);
  line-height: var(--sw-lh-tight);
}

.ap__nodes {
  margin: 0;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-warn);
}

.ap__reason {
  margin: 0;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-dim);
  word-break: break-word;
}

.ap__actions {
  display: flex;
  gap: 8px;
}
</style>
