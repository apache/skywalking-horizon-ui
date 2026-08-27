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

/** The classes the dashboard / landing / topology routes actually read, paired
 *  with whether each has a cold tier at all. */
const classes = computed<Array<{ hot: number; hasCold: boolean }>>(() => {
  const hot = ttl.value?.stages?.hot;
  if (!hot) return [];
  const cold = ttl.value?.stages?.cold ?? null;
  const pick = (h: number | undefined, c: number | undefined): { hot: number; hasCold: boolean } | null =>
    typeof h === 'number' && Number.isFinite(h) && h > 0
      ? { hot: h, hasCold: typeof c === 'number' && c >= 0 }
      : null;
  return [
    pick(hot.metrics.minute, cold?.metrics.minute),
    pick(hot.metrics.hour, cold?.metrics.hour),
    pick(hot.metrics.day, cold?.metrics.day),
    pick(hot.records.normal, cold?.records.normal),
    pick(hot.records.trace, cold?.records.trace),
    pick(hot.records.log, cold?.records.log),
  ].filter((c): c is { hot: number; hasCold: boolean } => c !== null);
});

/** Does this deployment have a cold stage on ANY class the pages read?
 *  `false` is the DEFAULT BanyanDB configuration — every `enableColdStage`
 *  ships off — and it changes what the banner can honestly advise. */
const hasAnyCold = computed<boolean>(() => classes.value.some((c) => c.hasCold));

/** Smallest hot+warm window, in days — the WARNING trigger. Min, because we
 *  warn as soon as ANY class would come back empty for the current window. */
const hotPlusWarmDays = computed<number | null>(() => {
  const all = classes.value;
  if (all.length === 0) return null;
  return Math.min(...all.map((c) => c.hot));
});

/** The window that actually clears every boundary — the REMEDY, and a
 *  different number from the trigger.
 *
 *  Taking the min for both was wrong in the same breath it was right: min is
 *  correct for "something here is empty", but as advice it clears only the
 *  shallowest class. Records default to 3 days while `metrics.minute` holds 7,
 *  so "older than 3 days ago" brought traces back and left every metric widget
 *  exactly as empty as before. Only classes that HAVE a cold tier count —
 *  moving past a class that has none buys nothing. */
const remedyDays = computed<number | null>(() => {
  const withCold = classes.value.filter((c) => c.hasCold);
  if (withCold.length === 0) return null;
  return Math.max(...withCold.map((c) => c.hot));
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

const visible = computed<boolean>(() => {
  if (backend.value !== 'banyandb' || !cold.enabled) return false;
  // With no cold stage anywhere, NO window returns anything — so the warning
  // cannot be conditioned on the range. Left conditioned, following the old
  // advice ("pick an older window") moved the range out of hot+warm and took
  // the banner with it: a blank page and the one sentence explaining it gone.
  if (!hasAnyCold.value) return true;
  return rangeOverlapsHotWarm.value;
});

function turnColdOff(): void {
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
    <span v-if="!hasAnyCold" class="cs-trap__text">
      <strong>{{ t('Cold-only read is active') }}</strong> —
      {{ t('this OAP has no cold stage configured, so every read returns nothing whatever window you pick. Turn the Cold pill off.') }}
    </span>
    <span v-else class="cs-trap__text">
      <strong>{{ t('Cold-only read is active') }}</strong> — {{ t('your time range is within the last') }}
      <b>{{ hotPlusWarmDays }} d</b> {{ t('(hot + warm), where the cold stage returns nothing.') }}
      {{ t('Pick a window older than') }} <b>{{ remedyDays }} {{ t('days') }}</b> {{ t('ago, or turn the Cold pill off.') }}
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
