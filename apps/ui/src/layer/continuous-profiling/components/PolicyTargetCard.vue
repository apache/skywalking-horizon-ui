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
  One eBPF target's rules (ON_CPU / OFF_CPU / NETWORK).

  A target with no check items cannot be saved — OAP requires at least one —
  so removing the last condition removes the whole target instead.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type {
  ContinuousProfilingMonitoringInstance,
  ContinuousProfilingPolicyItem,
  ContinuousProfilingPolicyTarget,
} from '@skywalking-horizon-ui/api-client';
import Btn from '@/components/primitives/Btn.vue';
import Icon from '@/components/icons/Icon.vue';
import CheckItemRow from './CheckItemRow.vue';
import TargetRunsOn from './TargetRunsOn.vue';
import { MONITOR_TYPES, newCheckItem } from '../data';

const props = defineProps<{
  target: ContinuousProfilingPolicyTarget;
  /** Live status for this target from the last read — absent until saved once. */
  status?: { triggeredCount?: number; lastTriggerTimestamp?: number | null } | null;
  /** Whether these rules are what OAP has stored. `new` has never been applied,
   *  `modified` was applied and then edited — in both cases the rules on screen
   *  are NOT the rules running, which is the thing an operator must not have to
   *  infer from a toast. */
  state: 'applied' | 'modified' | 'new';
  /** Shared roster for the whole policy — folded in per target below. */
  rows: ContinuousProfilingMonitoringInstance[];
  rowsLoading: boolean;
  rowsReachable: boolean;
  rowsError?: string | null;
  serviceName: string;
}>();
const emit = defineEmits<{ update: [ContinuousProfilingPolicyTarget]; remove: [] }>();

const { t } = useI18n();

function updateItem(index: number, item: ContinuousProfilingPolicyItem): void {
  const checkItems = props.target.checkItems.map((c, i) => (i === index ? item : c));
  emit('update', { ...props.target, checkItems });
}

const usedMonitors = computed(() => props.target.checkItems.map((c) => c.type));
const canAdd = computed(() => usedMonitors.value.length < MONITOR_TYPES.length);

function addItem(): void {
  emit('update', {
    ...props.target,
    checkItems: [...props.target.checkItems, newCheckItem(usedMonitors.value)],
  });
}

function removeItem(index: number): void {
  if (props.target.checkItems.length <= 1) {
    emit('remove');
    return;
  }
  emit('update', {
    ...props.target,
    checkItems: props.target.checkItems.filter((_, i) => i !== index),
  });
}

function lastTrigger(ms: number | null | undefined): string {
  return ms ? new Date(ms).toLocaleString() : t('never');
}
</script>

<template>
  <section class="target">
    <header class="head">
      <div class="ident">
        <Icon name="flame" />
        <h3>{{ target.type }}</h3>
        <span class="state" :class="`is-${state}`">
          {{ state === 'applied' ? t('Applied') : state === 'modified' ? t('Not applied — edited') : t('Not applied — new') }}
        </span>
        <!-- The rule's TARGET. It is stated once in the Policy header above,
             but that scrolls away exactly when the rule is being read — and a
             rule that does not name what it applies to is not self-describing. -->
        <span class="target-svc">
          <Icon name="svc" />
          <span class="svc-name">{{ serviceName }}</span>
          <em class="scope">{{ t('all instances') }}</em>
        </span>
      </div>
      <div class="meta">
        <span v-if="status" class="stat">
          {{ t('Triggered') }} <strong>{{ status.triggeredCount ?? 0 }}×</strong>
        </span>
        <span v-if="status" class="stat">
          {{ t('Last') }} <strong>{{ lastTrigger(status.lastTriggerTimestamp) }}</strong>
        </span>
        <Btn kind="ghost" size="sm" :aria-label="t('Remove target')" @click="emit('remove')">
          <Icon name="trash" />
        </Btn>
      </div>
    </header>

    <div class="items">
      <CheckItemRow
        v-for="(item, i) in target.checkItems"
        :key="i"
        :item="item"
        :taken="usedMonitors"
        :removable="true"
        @update="updateItem(i, $event)"
        @remove="removeItem(i)"
      />
    </div>

    <Btn kind="ghost" size="sm" :disabled="!canAdd" @click="addItem">
      <Icon name="plus" />
      {{ canAdd ? t('Add condition') : t('Every measurement is already used') }}
    </Btn>

    <!-- Evidence folded into the rule it belongs to, so a count can never be
         read against the wrong target. -->
    <TargetRunsOn
      :target="target.type"
      :rows="rows"
      :loading="rowsLoading"
      :reachable="rowsReachable"
      :read-error="rowsError"
      :service-name="serviceName"
      :applied="state === 'applied' || state === 'modified'"
    />
  </section>
</template>

<style scoped>
.target {
  border: 1px solid var(--sw-line);
  border-radius: var(--sw-radius);
  background: var(--sw-bg-1);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.ident {
  display: flex;
  align-items: center;
  gap: 8px;
}
h3 {
  margin: 0;
  font-size: var(--sw-fs-md);
  font-weight: var(--sw-fw-semibold);
  color: var(--sw-fg-0);
  letter-spacing: var(--sw-ls-tight);
}
.meta {
  display: flex;
  align-items: center;
  gap: 12px;
}
.stat {
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-2);
}
.stat strong {
  color: var(--sw-fg-1);
  font-weight: var(--sw-fw-medium);
}
.target-svc {
  display: inline-flex;
  gap: 5px;
  align-items: baseline;
  padding-left: 10px;
  margin-left: 4px;
  border-left: 1px solid var(--sw-line-2);
}
.svc-name {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-1);
}
.scope {
  font-style: normal;
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-3);
}
.state {
  font-size: var(--sw-fs-xs);
  padding: 1px 7px;
  border-radius: var(--sw-radius);
  border: 1px solid transparent;
}
.state.is-applied {
  color: var(--sw-ok);
  border-color: var(--sw-ok);
  background: var(--sw-ok-soft);
}
.state.is-modified,
.state.is-new {
  color: var(--sw-warn);
  border-color: var(--sw-warn);
  background: var(--sw-warn-soft);
}
.items {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
