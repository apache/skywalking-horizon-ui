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
  Loud warning strip for the cold-stage "replace, not augment" trap.

  Mounts under the topbar on every shell route. Renders ONLY when ALL
  of the following hold:

    1. backend === 'banyandb' (otherwise the toggle isn't visible
       and there's no trap to warn about).
    2. The operator has the Cold pill ON (querying ONLY cold-stage
       data — see comments in `controls/coldStage.ts`).
    3. The currently-picked time window's END is newer than the
       hot+warm cutoff reported in TTL (i.e. the window is at least
       partly in hot+warm, where cold returns nothing).

  Why this exists despite the topbar tooltip: operators don't read
  tooltips mid-investigation. They read inline-banner copy because it
  changes the page. The trap is wire-true ("Duration.coldStage: true"
  REPLACES the hot+warm read) and every demo session has bitten on
  it; tooltip alone isn't enough.

  The cutoff is derived from `stages.hot.metrics.minute` — the most
  operator-relevant data class for dashboard / metric queries.
  Per-class boundaries vary slightly; we err on the side of warning
  (use the LOWEST hot+warm days across classes so the banner fires
  whenever ANY class would go empty).
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useColdStageStore } from '@/controls/coldStage';
import { useTimeRangeStore } from '@/controls/timeRange';
import { useTtl } from '@/features/operate/ttl/useTtl';
import { useOapInfo } from '@/shell/useOapInfo';

const { t } = useI18n({ useScope: 'global' });
const cold = useColdStageStore();
const timeRange = useTimeRangeStore();
const { backend } = useOapInfo();
const { data: ttl } = useTtl();

/** Smallest hot+warm window (in days) across the data classes the
 *  dashboard/landing/topology routes actually query — picking the min
 *  means we warn whenever ANY class would return empty for the
 *  current window. */
const hotPlusWarmDays = computed<number | null>(() => {
  const hot = ttl.value?.stages?.hot;
  if (!hot) return null;
  const cands: number[] = [
    hot.metrics.minute,
    hot.metrics.hour,
    hot.metrics.day,
    hot.records.normal,
    hot.records.trace,
    hot.records.log,
  ].filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);
  if (cands.length === 0) return null;
  return Math.min(...cands);
});

/** True when the current time-range END is newer than the hot+warm
 *  cutoff — i.e. the picked window touches data that isn't in cold
 *  yet. We compute against `endMs` (not start) because if the END is
 *  inside hot+warm, the cold-only read is at least partly empty;
 *  showing the warning then is the right move. */
const rangeOverlapsHotWarm = computed<boolean>(() => {
  const days = hotPlusWarmDays.value;
  if (days == null) return false;
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  return timeRange.range.endMs > cutoffMs;
});

const visible = computed<boolean>(
  () =>
    backend.value === 'banyandb' &&
    cold.enabled &&
    rangeOverlapsHotWarm.value,
);

function turnColdOff(): void {
  // Match the toggle path the topbar uses — invalidates queries so
  // subscribers refetch in hot+warm mode immediately.
  cold.set(false);
}
</script>

<template>
  <div v-if="visible" role="alert" class="cs-trap">
    <span class="cs-trap__icon" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="M12 3v18M3 12h18M5 5l14 14M19 5L5 19" />
      </svg>
    </span>
    <span class="cs-trap__text">
      <strong>{{ t('Cold-only read is active') }}</strong> — {{ t('your time range is within the last') }}
      <b>{{ hotPlusWarmDays }} d</b> {{ t('(hot + warm), where the cold stage returns nothing.') }}
      {{ t('Pick a window older than') }} <b>{{ hotPlusWarmDays }} {{ t('days') }}</b> {{ t('ago, or turn the Cold pill off.') }}
    </span>
    <button type="button" class="cs-trap__action" @click="turnColdOff">{{ t('Turn Cold off') }}</button>
  </div>
</template>

<style scoped>
.cs-trap {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 14px;
  background: var(--sw-warn-soft, rgba(234, 179, 8, 0.12));
  border-bottom: 1px solid var(--sw-warn, rgba(234, 179, 8, 0.55));
  color: var(--sw-fg-0);
  font-size: 12px;
  line-height: 1.5;
}
.cs-trap__icon {
  display: inline-flex;
  color: var(--sw-warn, #eab308);
}
.cs-trap__text {
  flex: 1;
  color: var(--sw-fg-1);
}
.cs-trap__text strong {
  color: var(--sw-warn, #eab308);
  margin-right: 4px;
}
.cs-trap__text b {
  color: var(--sw-fg-0);
  font-weight: 600;
}
.cs-trap__action {
  background: transparent;
  border: 1px solid var(--sw-warn, #eab308);
  color: var(--sw-warn, #eab308);
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 4px;
  cursor: pointer;
}
.cs-trap__action:hover {
  background: var(--sw-warn-soft, rgba(234, 179, 8, 0.18));
}
</style>
