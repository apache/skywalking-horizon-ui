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
import { RouterLink } from 'vue-router';
import { useOapInfo } from '@/shell/useOapInfo';
import { useAuthStore } from '@/state/auth';

const { info, reachable, tzOffsetLabel, healthState } = useOapInfo();
const auth = useAuthStore();

// The Cluster Status page is maintainer-tier; only link the chip there
// when the user can actually read it (matches the route's verb gate).
const canViewCluster = computed(() => auth.hasVerb('cluster:read'));

const oapChipTooltip = computed<string>(() => {
  if (!info.value) return 'OAP status — loading…';
  if (!reachable.value) {
    return `OAP unreachable: ${info.value.error ?? 'no response'}\nFix the upstream and the pill turns green.`;
  }
  const parts: string[] = [];
  if (info.value.version) parts.push(`Version ${info.value.version}`);
  if (tzOffsetLabel.value) parts.push(`Server TZ ${tzOffsetLabel.value}`);
  if (info.value.currentTimestamp) {
    parts.push(`Server clock ${new Date(info.value.currentTimestamp).toLocaleString()} (your local time)`);
  }
  if (info.value.healthScore !== undefined) {
    parts.push(`Health score ${info.value.healthScore} — ${info.value.healthDetails ?? '(no details)'}`);
  }
  return parts.join('\n');
});
</script>

<template>
  <component
    :is="canViewCluster ? RouterLink : 'div'"
    class="sw-btn oap-chip"
    :class="[`is-${healthState}`, { 'is-static': !canViewCluster }]"
    :title="oapChipTooltip"
    v-bind="canViewCluster ? { to: '/operate/cluster' } : {}"
  >
    <span class="dot" />
    <span v-if="reachable" class="ver">OAP</span>
    <span v-else class="ver">offline</span>
    <!-- Server TZ offset is kept out of the visible chip (noise next to
         the health dot); it stays in the tooltip and on the Cluster
         Status page. -->
  </component>
</template>

<style scoped>
.oap-chip {
  text-decoration: none;
  font-family: var(--sw-mono);
  font-variant-numeric: tabular-nums;
  font-size: 10.5px;
  gap: 6px;
}
/* Non-clickable health chip for users without cluster:read. */
.oap-chip.is-static {
  cursor: default;
  display: inline-flex;
  align-items: center;
}
.oap-chip .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  display: inline-block;
}
.oap-chip.is-ok .dot {
  background: var(--sw-ok);
  box-shadow: 0 0 6px 0 rgba(34, 197, 94, 0.55);
}
.oap-chip.is-warn .dot {
  background: var(--sw-warn);
}
.oap-chip.is-err .dot {
  background: var(--sw-err);
  animation: pulse-err 1.6s infinite;
}
.oap-chip.is-unknown .dot {
  background: var(--sw-fg-3);
}
.oap-chip .ver {
  color: var(--sw-fg-0);
  font-weight: 600;
}
@keyframes pulse-err {
  0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.6); }
  70% { box-shadow: 0 0 0 6px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
</style>
