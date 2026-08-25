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
 * Token usage — one group per hour, newest first.
 *
 * Not the audit list: presenting a token is not a login, so these groups
 * answer "which hours were busy, and who made them busy" rather than "who got
 * in". The hour's total counts EVERY credential; the rows name only the
 * busiest, so a truncated list never disagrees with its own total.
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { MAX_TOKEN_USAGE_HOURS, type TokenUsageHour } from '@/api/scopes/admin-audit';
import { TOKEN_PRESETS, CUSTOM_RANGE_SENTINEL } from './useTokenUsagePage';
import { timestampLabel } from '@/utils/formatters';

const props = defineProps<{
  hours: TokenUsageHour[];
  spanHours: number;
  customStart: string | null;
  customEnd: string | null;
  rangeError: string | null;
  loading: boolean;
  error: string | null;
}>();
const emit = defineEmits<{
  (e: 'update:span', hours: number): void;
  (e: 'update:customStart', v: string): void;
  (e: 'update:customEnd', v: string): void;
  (e: 'apply'): void;
}>();
const isCustom = computed(() => props.spanHours === CUSTOM_RANGE_SENTINEL);
/* Same wording as the Login tab's picker — one label per span, not a
   parameterized near-duplicate that translates differently. */
const SPAN_LABELS: Record<number, string> = { 2: 'Last 2 hours', 6: 'Last 6 hours', 12: 'Last 12 hours' };
const { t } = useI18n();

/** `UTC+5:30`, `UTC-4` — numeric, so it reads the same in every locale. */
function offsetLabel(at: number): string {
  const minutes = -new Date(at).getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const rest = abs % 60;
  return `UTC${sign}${Math.floor(abs / 60)}${rest ? `:${String(rest).padStart(2, '0')}` : ''}`;
}

/**
 * An hour is a window, not an instant — show both ends.
 *
 * On the day a clock goes back, both ends of the repeated hour read the same
 * on the wall — `01:00 – 01:00`, which describes nothing. The offsets are
 * appended only then, since carrying them on every ordinary row would be
 * noise for the one day a year they matter.
 */
function hourRange(at: number): string {
  const end = at + 3_600_000;
  const span = `${timestampLabel(at).slice(0, 16)} – ${timestampLabel(end).slice(11, 16)}`;
  const from = offsetLabel(at);
  const to = offsetLabel(end);
  return from === to ? span : `${span} (${from} → ${to})`;
}

/**
 * Uses per second across the hour: what a rate tells you that a total cannot.
 *
 * One precision for every row, so the decimal points line up and the column
 * reads as a single scale — mixing `4.1` with `0.175` puts the same digit in
 * two places. A rate too small to show at that precision is reported as a
 * floor rather than as `0.000`, which would read as no traffic at all.
 */
const RATE_DECIMALS = 3;
const RATE_FLOOR = 10 ** -RATE_DECIMALS;

function perSecond(count: number): string {
  const rate = count / 3600;
  if (rate > 0 && rate < RATE_FLOOR) return `<${RATE_FLOOR.toFixed(RATE_DECIMALS)}`;
  return rate.toFixed(RATE_DECIMALS);
}

/** Bar width against the busiest hour in the window, so the shape reads at a
 *  glance rather than needing the numbers compared. */
function share(total: number): string {
  const peak = Math.max(1, ...props.hours.map((h) => h.total));
  return `${Math.round((total / peak) * 100)}%`;
}
</script>

<template>
  <section class="tu">
    <header class="tu__head">
      <div>
        <h2 class="tu__title">{{ t('Token usage') }}</h2>
        <p class="tu__sub">
          {{ t('One row per credential per hour. Presenting a token is not a sign-in, so it is counted here rather than recorded in the audit list.') }}
        </p>
      </div>
      <label class="cf" :class="{ 'cf-wide': isCustom }">
        <span>{{ t('Time range') }}</span>
        <template v-if="isCustom">
          <div class="cf-range">
            <input
              :value="props.customStart" type="datetime-local"
              class="cf-input cf-range-num" :title="t('Snaps to a group boundary — a group is one hour')"
              @input="emit('update:customStart', ($event.target as HTMLInputElement).value)"
            />
            <span class="cf-range-sep">–</span>
            <input
              :value="props.customEnd" type="datetime-local"
              class="cf-input cf-range-num" :title="t('Snaps to a group boundary — a group is one hour')"
              @input="emit('update:customEnd', ($event.target as HTMLInputElement).value)"
            />
            <button class="sw-btn small primary" type="button" @click="emit('apply')">{{ t('Query') }}</button>
            <button
              class="sw-btn small ghost" type="button" :title="t('Back to presets')"
              @click="emit('update:span', 6)"
            >×</button>
          </div>
        </template>
        <select
          v-else class="cf-input" :value="props.spanHours"
          @change="emit('update:span', Number(($event.target as HTMLSelectElement).value))"
        >
          <option v-for="p in TOKEN_PRESETS" :key="p" :value="p">{{ t(SPAN_LABELS[p]) }}</option>
          <option :value="CUSTOM_RANGE_SENTINEL">{{ t('Custom…') }}</option>
        </select>
      </label>
    </header>

    <p v-if="props.rangeError" class="tu__note tu__note--bad" role="alert">
      {{ t(props.rangeError, { h: MAX_TOKEN_USAGE_HOURS }) }}
    </p>
    <p v-else-if="props.loading" class="tu__note">{{ t('Reading data…') }}</p>
    <p v-else-if="props.error" class="tu__note tu__note--bad">{{ props.error }}</p>
    <template v-else>
      <div v-for="hour in props.hours" :key="hour.hourBucket" class="tu__hour">
        <div class="tu__hour-head">
          <span class="tu__when">{{ hourRange(hour.at) }}</span>
          <span class="tu__bar"><i :style="{ width: share(hour.total) }" /></span>
          <span class="tu__stat">
            {{ t('Uses') }} <b class="tu__uses">{{ hour.total }}</b>
          </span>
          <span class="tu__stat">
            {{ t('Credentials') }} <b class="tu__creds">{{ hour.credentials }}</b>
          </span>
        </div>

        <p v-if="hour.top.length === 0" class="tu__quiet">{{ t('No token use in this hour.') }}</p>
        <template v-else>
          <!-- Said as its own line, not a suffix: an hour with more
               credentials than rows is showing a SAMPLE, and a reader must
               never mistake the listed ten for the whole hour. -->
          <p class="tu__legend" :class="{ 'tu__legend--cut': hour.credentials > hour.top.length }">
            <template v-if="hour.credentials > hour.top.length">
              {{ t('Top {shown} of {total} credentials — the rest are counted in the total, not listed', {
                shown: hour.top.length, total: hour.credentials }) }}
            </template>
            <template v-else>
              {{ t('Every credential used in this hour is listed') }}
            </template>
          </p>
          <div class="tu__scroll">
            <table class="tu__table">
            <thead>
              <tr>
                <th class="tu__col-token">{{ t('Token') }}</th>
                <th class="tu__num tu__col-uses">{{ t('Uses') }}</th>
                <th class="tu__num tu__col-rate">{{ t('Rate') }}</th>
                <th>{{ t('User') }}</th>
              </tr>
            </thead>
            <tbody>
            <tr v-for="row in hour.top" :key="row.tokenId">
              <td class="tu__mono tu__col-token" :title="row.tokenId">{{ row.tokenId }}</td>
              <td class="tu__num tu__col-uses">{{ row.count }}</td>
              <td class="tu__num tu__col-rate">
                {{ perSecond(row.count) }}<span class="tu__unit">{{ t('/s') }}</span>
              </td>
              <td class="tu__mono tu__acting" :title="row.username">{{ row.username }}</td>
            </tr>
            </tbody>
            </table>
          </div>
        </template>
      </div>
    </template>
  </section>
</template>

<style scoped>
.tu { display: flex; flex-direction: column; gap: 10px; }
.tu__head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; }
.tu__title { margin: 0; font-size: var(--sw-fs-md); color: var(--sw-fg-0); font-weight: 600; }
.tu__sub { margin: 2px 0 0; font-size: var(--sw-fs-xs); color: var(--sw-fg-3); max-width: 70ch; }
/* The trace/log/explore query screens all define this same condition-field
   set locally; copied here so the range picker is the same control as the
   one on the Login tab. */
.cf {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: var(--sw-fg-3);
  font-weight: 500;
  min-width: 180px;
  flex: 0 0 auto;
}
.cf.cf-wide { min-width: 400px; }
.cf-input {
  height: 28px;
  padding: 0 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11px;
  width: 100%;
  box-sizing: border-box;
}
.cf-range { display: flex; align-items: center; gap: 4px; }
.cf-range-num { flex: 1; min-width: 0; }
.cf-range-sep { color: var(--sw-fg-3); font-size: 12px; flex: 0 0 auto; }
/* The Login tab restyles these three away from the token defaults; scoped
   styles do not cross components, so the same rules are needed here or the
   two tabs' Query buttons do not match. */
.sw-btn.primary {
  background: var(--sw-accent);
  color: var(--sw-bg-0);
  border: none;
  height: 26px;
  padding: 0 14px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.sw-btn.small { height: 24px; padding: 0 10px; font-size: 11px; }
.sw-btn.ghost { background: transparent; border: 1px solid var(--sw-line-2); color: var(--sw-fg-2); }
.tu__note { margin: 0; padding: 14px; font-size: var(--sw-fs-sm); color: var(--sw-fg-3); }
.tu__note--bad { color: var(--sw-err); }
.tu__hour { border: 1px solid var(--sw-line); border-radius: 4px; background: var(--sw-bg-1); }
.tu__hour-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--sw-line);
  flex-wrap: wrap;
}
.tu__when { font-size: var(--sw-fs-xs); color: var(--sw-fg-1); white-space: nowrap; font-variant-numeric: tabular-nums; }
/* A FIXED track, pushed right by the slack before it. Sized by `flex: 1` the
   track grew or shrank with the width of the numbers beside it, so an hour's
   bar was drawn to a different scale than the hour above it — which is the one
   thing a bar has to get right. */
.tu__bar {
  flex: 0 0 240px;
  margin-left: auto;
  height: 6px;
  background: var(--sw-bg-3);
  border-radius: 3px;
  overflow: hidden;
}
.tu__bar i { display: block; height: 100%; background: var(--sw-accent); }
.tu__stat { font-size: var(--sw-fs-xs); color: var(--sw-fg-3); white-space: nowrap; }
.tu__stat b {
  display: inline-block;
  margin-left: 4px;
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-0);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
/* Reserved so the trailing block is one width for every hour: a bar whose
   right edge moved row to row would be as unreadable as one whose length did. */
.tu__uses { min-width: 6ch; }
.tu__creds { min-width: 3ch; }
.tu__quiet { margin: 0; padding: 8px 10px; font-size: var(--sw-fs-xs); color: var(--sw-fg-3); }
/* Whether the rows are the whole hour or its busiest ten changes what the
   totals above mean, so it is stated on its own line rather than tucked
   into the header as a suffix. */
.tu__legend {
  margin: 0;
  padding: 6px 10px 4px;
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-3);
}
.tu__legend--cut { color: var(--sw-warn); }
/* FIXED geometry, because each hour is its own table. Sized by content, one
   hour's seven-digit total pushed its columns a couple of hundred pixels right
   of the hour above it, and a column that moves per group cannot be read down
   the page. Every table now lays out identically whatever it holds. */
/* The fixed columns below add up to a minimum the table cannot go under, so
   the table scrolls inside its own box rather than widening the page. */
.tu__scroll { overflow-x: auto; }
.tu__table {
  width: 100%;
  min-width: 520px;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: var(--sw-fs-sm);
}
.tu__table th {
  padding: 0 10px 4px;
  text-align: left;
  font-size: var(--sw-fs-xs);
  font-weight: 500;
  color: var(--sw-fg-3);
  border-bottom: 1px solid var(--sw-line);
  white-space: nowrap;
}
.tu__table td { padding: 4px 10px; color: var(--sw-fg-1); }
.tu__table tbody tr + tr td { border-top: 1px solid var(--sw-line); }
.tu__mono { font-family: var(--sw-mono); color: var(--sw-fg-0); }
.tu__acting { color: var(--sw-fg-2); }
.tu__num { text-align: right; font-variant-numeric: tabular-nums; }
/* A right-aligned column whose heading sits left reads as two columns. */
.tu__table th.tu__num { text-align: right; }
/* Widths reserved for the realistic maxima: seven-digit hourly totals, and a
   rate of four digits before the point. Under `table-layout: fixed` the width
   is the whole column INCLUDING its padding, so these carry ~3ch more than the
   digits need — a number that ellipsised would be a WRONG number, silently,
   which is the one thing these columns must never do. A generated token id is
   six hex characters; an operator may hand-write a longer one, so that column
   alone truncates, with the full value on hover. */
.tu__col-token { width: 22ch; }
.tu__col-uses { width: 13ch; }
.tu__col-rate { width: 19ch; }
.tu__col-token, .tu__col-uses, .tu__col-rate { white-space: nowrap; }
.tu__table td.tu__col-token, .tu__table td.tu__acting {
  overflow: hidden;
  text-overflow: ellipsis;
}
.tu__table td.tu__col-uses { color: var(--sw-fg-0); font-weight: 600; }
.tu__table td.tu__col-rate { color: var(--sw-fg-2); }
/* The unit is not a digit — dimmed so a column of rates reads as numbers. */
.tu__unit { color: var(--sw-fg-3); }

/* Narrow: the bar is the first thing to go. It compares hours to each other,
   which is a luxury next to the numbers it sits beside — and a fixed 240px
   track cannot shrink, so keeping it would push the counts off the row. */
@media (max-width: 900px) {
  .tu__head { flex-direction: column; align-items: stretch; }
  .cf { min-width: 0; }
  .cf.cf-wide { min-width: 0; }
  .tu__bar { display: none; }
  .tu__when { flex: 1 1 auto; }
}
</style>
