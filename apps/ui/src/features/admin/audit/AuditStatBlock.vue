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
 * Hourly sign-in counts, stacked by how someone signed in.
 *
 * Every kind series counts ACCEPTED rows; `rejected` is the only one that does
 * not. A policy-refused sign-in is what happened INSTEAD of one, so counting
 * it in both would let a column total exceed the rows in its hour.
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AuditStatColumn, AuditStatResult, AuditStatWindow } from '@/api/scopes/admin-audit';

const props = defineProps<{
  stat: AuditStatResult | null;
  window: AuditStatWindow;
  loading: boolean;
  error: string | null;
}>();
const emit = defineEmits<{ (e: 'update:window', w: AuditStatWindow): void }>();

const { t } = useI18n();

const WINDOWS: AuditStatWindow[] = [2, 6, 12];

/** `break-glass` takes a loud colour deliberately: it is granted only while
 *  the directory is failing, so its appearance is itself the news. */
/**
 * ONE vocabulary with the filter chips and the list's "How" column.
 *
 * These used to read Password / LDAP / OIDC / OAuth / Token while the chips
 * beside them read Password / LDAP / Break-glass / Single sign-on / API token
 * / OAuth token — so the same row was named two ways, and worse, "OAuth" meant
 * the SSO protocol here and a Horizon-issued token there. The two SSO
 * protocols still get their own bars, because verifying a signed ID token and
 * reading an address from a userinfo call are different assurances, but they
 * are named as the sign-on kinds they are.
 */
const SERIES = [
  { key: 'local', label: 'Password', token: 'var(--sw-accent)' },
  { key: 'ldap', label: 'LDAP', token: 'var(--sw-cyan)' },
  { key: 'oidc', label: 'Single sign-on (OIDC)', token: 'var(--sw-purple)' },
  { key: 'oauth', label: 'Single sign-on (OAuth)', token: 'var(--sw-pink)' },
  { key: 'rejected', label: 'Refused', token: 'var(--sw-err)' },
] as const;

function valueOf(col: AuditStatColumn, key: (typeof SERIES)[number]['key']): number {
  return key === 'rejected' ? col.rejected : col.login[key];
}

function total(col: AuditStatColumn): number {
  return SERIES.reduce((n, s) => n + valueOf(col, s.key), 0);
}

const peak = computed(() => Math.max(1, ...(props.stat?.columns ?? []).map(total)));

/** yyyyMMddHH → the hour, in the reader's own zone. */
function hourLabel(bucket: number): string {
  const hour = bucket % 100;
  const day = Math.floor(bucket / 100) % 100;
  const month = Math.floor(bucket / 10_000) % 100;
  const year = Math.floor(bucket / 1_000_000);
  const d = new Date(Date.UTC(year, month - 1, day, hour));
  // Numeric, not `toLocaleTimeString`: that renders in the browser's language
  // rather than the app's, which is how `08时` reached an English page.
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const grandTotal = computed(() =>
  (props.stat?.columns ?? []).reduce((n, c) => n + total(c), 0),
);
</script>

<template>
  <section class="stat">
    <header class="stat__head">
      <div>
        <h2 class="stat__title">{{ t('Sign-ins') }}</h2>
        <!-- Estimated, and SUMMED: each node records its own counters and the
             query adds them up per hour, so a bar is the cluster's total for
             that hour. Calling it "per node" made two replicas at five
             sign-ins each read as ten apiece. -->
        <p class="stat__sub">
          {{ t('Estimated, summed across nodes.') }}
          <template v-if="stat && stat.horizonNodes > 1">
            {{ t('{n} nodes reporting.', { n: stat.horizonNodes }) }}
          </template>
        </p>
      </div>
      <div class="stat__windows" role="group" :aria-label="t('Time window')">
        <button
          v-for="w in WINDOWS"
          :key="w"
          type="button"
          class="stat__window"
          :class="{ 'stat__window--on': w === window }"
          :aria-pressed="w === window"
          @click="emit('update:window', w)"
        >
          {{ t('{h}h', { h: w }) }}
        </button>
      </div>
    </header>

    <p v-if="loading" class="stat__note">{{ t('Reading data…') }}</p>
    <p v-else-if="error" class="stat__note stat__note--bad">{{ error }}</p>
    <p v-else-if="!stat || grandTotal === 0" class="stat__note">
      {{ t('No sign-ins recorded in this window.') }}
    </p>

    <template v-else>
      <div class="stat__chart">
        <div v-for="col in stat.columns" :key="col.hourBucket" class="stat__col">
          <div class="stat__track">
            <div class="stat__bar" :style="{ height: `${(total(col) / peak) * 100}%` }">
            <span
              v-for="s in SERIES"
              :key="s.key"
              class="stat__seg"
              :style="{
                flexGrow: valueOf(col, s.key),
                background: s.token,
              }"
              :title="`${t(s.label)}: ${valueOf(col, s.key)}`"
              />
            </div>
          </div>
          <span class="stat__hour">{{ hourLabel(col.hourBucket) }}</span>
        </div>
      </div>

      <ul class="stat__legend">
        <li v-for="s in SERIES" :key="s.key" class="stat__key">
          <span class="stat__swatch" :style="{ background: s.token }" />
          {{ t(s.label) }}
        </li>
      </ul>
    </template>

    <!-- Not a series: these count rows and uses that were never written, so
         drawing them beside rows that were would read as volume. -->
    <p v-if="stat && stat.overBudget" class="stat__gap">
      {{ t('Some records were not written in this window:') }}
      <span>{{ t('{n} over the hourly limit', { n: stat.overBudget }) }}</span>
    </p>
  </section>
</template>

<style scoped>
.stat {
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  background: var(--sw-bg-1);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.stat__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.stat__title {
  margin: 0;
  font-size: var(--sw-fs-sm);
  font-weight: 600;
  color: var(--sw-fg-0);
}
.stat__sub {
  margin: 2px 0 0;
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-2);
}
.stat__windows {
  display: flex;
  gap: 2px;
}
.stat__window {
  border: 1px solid var(--sw-line);
  background: transparent;
  color: var(--sw-fg-2);
  font-size: var(--sw-fs-xs);
  padding: 2px 8px;
  cursor: pointer;
  border-radius: 3px;
}
.stat__window--on {
  background: var(--sw-bg-2);
  color: var(--sw-fg-0);
  border-color: var(--sw-line-2);
}
.stat__chart {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  height: 120px;
  overflow-x: auto;
}
.stat__col {
  flex: 1 1 0;
  min-width: 28px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  height: 100%;
  gap: 4px;
}
/* The hour label occupies part of the column, so a bar sized as a percentage
   of the COLUMN could never use the top of the scale — the tallest bar and one
   at 87% drew the same height. The bar is sized against its own track. */
.stat__track {
  flex: 1 1 auto;
  width: 100%;
  display: flex;
  align-items: flex-end;
  min-height: 0;
}
.stat__bar {
  width: 100%;
  min-height: 2px;
  display: flex;
  flex-direction: column-reverse;
  border-radius: 2px;
  overflow: hidden;
}
.stat__seg {
  display: block;
  min-height: 0;
}
.stat__hour {
  font-size: 10px;
  color: var(--sw-fg-2);
  font-variant-numeric: tabular-nums;
}
.stat__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.stat__key {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-2);
}
.stat__swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
}
.stat__note {
  margin: 0;
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-2);
}
.stat__note--bad {
  color: var(--sw-err);
}
.stat__gap {
  margin: 0;
  font-size: var(--sw-fs-xs);
  color: var(--sw-warn);
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
</style>
