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
import { useQueryClient } from '@tanstack/vue-query';
import Icon from '@/components/icons/Icon.vue';
import { useOapInfo } from '@/shell/useOapInfo';
import { useColdStageStore } from '@/controls/coldStage';

// "Query cold stage" — BanyanDB-only. The chip renders only when the
// connected OAP uses BanyanDB.
//
// IMPORTANT SEMANTICS: OAP's `Duration.coldStage: true` REPLACES the
// hot+warm read, it does not augment it (see the comment on
// `Duration.coldStage` in OAP's query-protocol). Turning the pill on
// while looking at a recent dashboard makes every widget go empty,
// because the recent window doesn't exist in cold yet. Only flip it
// on when the operator is asking for data older than the hot+warm
// TTL boundary (Operate → Time To Live shows the values per class).
//
// Flipping invalidates every tanstack-query cache so subscribers
// refetch with the new header instead of serving stale data from
// the previous stage.
const { backend } = useOapInfo();
const cold = useColdStageStore();
const queryClient = useQueryClient();
const showColdChip = computed<boolean>(() => backend.value === 'banyandb');
function toggleCold(): void {
  cold.toggle(queryClient);
}
const coldChipTooltip = computed<string>(() =>
  cold.enabled
    ? 'Reading cold-stage data only. ⚠ Recent windows return empty — cold doesn\'t hold recent data. Click to switch back to hot+warm.'
    : 'Reading hot+warm data (default). Click to switch to the cold stage instead — use only when the time range is older than the hot+warm TTL (see Operate → Time To Live).',
);
</script>

<template>
  <button
    v-if="showColdChip"
    type="button"
    class="sw-btn cold-chip"
    :class="{ 'is-on': cold.enabled }"
    :title="coldChipTooltip"
    @click="toggleCold"
  >
    <Icon name="snowflake" :size="11" />
    <span>{{ cold.enabled ? 'Cold only' : 'Cold' }}</span>
  </button>
</template>

<style scoped>
/* On state uses a cool cyan tint so it visually pops — operators are
 * intentionally drawn to "you are currently including cold data" because
 * it changes which window of history is in play. */
.cold-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 0 8px;
  cursor: pointer;
  color: var(--sw-fg-2);
}
.cold-chip:hover {
  color: var(--sw-fg-0);
}
.cold-chip.is-on {
  background: var(--sw-accent-soft);
  border-color: var(--sw-accent);
  color: var(--sw-accent);
  font-weight: 600;
}
.cold-chip.is-on :deep(svg) {
  color: var(--sw-accent);
}
</style>
