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
import Icon from '@/components/icons/Icon.vue';
import { useAlarmCount } from '@/shell/useAlarmCount';

// Independent 60s timer, rolling 20m window (see useAlarmCount). Clicking
// jumps to /alarms regardless of which page the operator is on.
const alarmCount = useAlarmCount();
const alarmBadgeTooltip = computed<string>(() => {
  if (alarmCount.hasError.value) {
    return `Alarms unavailable: ${alarmCount.errorMessage.value ?? 'no response'}`;
  }
  const windowMin = Math.round(alarmCount.windowMs.value / 60_000);
  const active = alarmCount.activeIncidents.value;
  const inc = alarmCount.incidents.value;
  const cap = alarmCount.truncated.value ? ' (capped — open the page for the full list)' : '';
  if (active === 0) {
    if (inc > 0) {
      return `No active alarms in the last ${windowMin}m · ${inc} recovered incident${inc === 1 ? '' : 's'}`;
    }
    return `No alarms in the last ${windowMin}m`;
  }
  return `${active} active incident${active === 1 ? '' : 's'} in the last ${windowMin}m${cap}`;
});
const alarmBadgeState = computed<'ok' | 'err' | 'unknown'>(() => {
  if (alarmCount.hasError.value) return 'unknown';
  return alarmCount.activeIncidents.value > 0 ? 'err' : 'ok';
});
</script>

<template>
  <RouterLink
    class="sw-btn alarm-badge"
    :class="`is-${alarmBadgeState}`"
    :title="alarmBadgeTooltip"
    to="/alarms"
  >
    <Icon name="bell" :size="12" />
    <span class="alarm-count mono">{{ alarmCount.displayCount.value }}</span>
  </RouterLink>
</template>

<style scoped>
/* Red when any alarm fired in the window, neutral when clean, grey when
 * the BFF can't reach OAP. */
.alarm-badge {
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
}
.alarm-badge .alarm-count {
  font-size: 10.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  min-width: 14px;
  text-align: center;
}
.alarm-badge.is-ok {
  color: var(--sw-fg-2);
}
.alarm-badge.is-ok .alarm-count {
  color: var(--sw-fg-2);
}
.alarm-badge.is-err {
  color: var(--sw-err);
}
.alarm-badge.is-err .alarm-count {
  color: var(--sw-err);
}
.alarm-badge.is-err :deep(svg) {
  animation: pulse-err 1.6s infinite;
  transform-origin: 50% 50%;
}
.alarm-badge.is-unknown {
  color: var(--sw-fg-3);
}
.alarm-badge.is-unknown .alarm-count {
  color: var(--sw-fg-3);
}
@keyframes pulse-err {
  0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.6); }
  70% { box-shadow: 0 0 0 6px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
</style>
