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
 * The login audit page. One page, read top to bottom: statistics, then the
 * query controls, then the list.
 *
 * Statistics come first because the first question is "is anything unusual
 * happening?" and the second is "show me which" — a filter form above an
 * unread summary asks the operator to guess what to filter for.
 */
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AuditKind } from '@/api/scopes/admin-audit';
import AuditList from './AuditList.vue';
import AuditStatBlock from './AuditStatBlock.vue';
import TokenUsageList from './TokenUsageList.vue';
import { useTokenUsagePage } from './useTokenUsagePage';
import { useAuditPage, ALL_TIME, CUSTOM_RANGE_SENTINEL } from './useAuditPage';

const { t } = useI18n();
const page = useAuditPage();
const tokens = useTokenUsagePage();

/**
 * Two tabs, because the two records answer different questions at different
 * grains. A sign-in is a person arriving; a token-usage row is an hour of
 * traffic. Stacking them in one list made a busy script outweigh every human
 * sign-in beside it.
 */
type Tab = 'logins' | 'tokens';
const tab = ref<Tab>('logins');

async function pick(next: Tab): Promise<void> {
  if (tab.value === next) return;
  tab.value = next;
  // Load on first view rather than on mount — the other tab's query is not
  // free, and most visits only ever look at one.
  if (next === 'tokens' && tokens.hours.value.length === 0 && !tokens.loading.value) {
    await tokens.load();
  }
}

const TIME_RANGE_PRESETS = computed<Array<{ label: string; minutes: number }>>(() => [
  { label: t('All'), minutes: ALL_TIME },
  { label: t('Last 15 min'), minutes: 15 },
  { label: t('Last 30 min'), minutes: 30 },
  { label: t('Last 1 hour'), minutes: 60 },
  { label: t('Last 3 hours'), minutes: 180 },
  { label: t('Last 6 hours'), minutes: 360 },
  { label: t('Last 12 hours'), minutes: 720 },
  { label: t('Last 24 hours'), minutes: 1440 },
]);
const isCustomRange = computed(() => page.filters.value.windowMinutes === CUSTOM_RANGE_SENTINEL);

const KINDS: { value: AuditKind; label: string }[] = [
  { value: 'local', label: 'Password' },
  { value: 'ldap', label: 'LDAP' },
  { value: 'break-glass', label: 'Break-glass' },
  { value: 'sso', label: 'Single sign-on' },
];

onMounted(() => void page.refresh());
</script>

<template>
  <div class="audit">
    <header class="audit__head">
      <h1 class="audit__title">{{ t('Login audit') }}</h1>
      <p class="audit__blurb">
        {{ t('Who signed in, when, and from where. Records only what a valid credential produced — everything an unauthenticated caller can trigger stays in the application log.') }}
      </p>
    </header>

    <!-- A sign-in is a person arriving; a token-usage row is an hour of
         traffic. Separate tabs so neither grain drowns the other. -->
    <div class="audit__tabs" role="tablist">
      <button
        type="button" role="tab" class="audit__tab"
        :class="{ 'audit__tab--on': tab === 'logins' }"
        :aria-selected="tab === 'logins'"
        @click="pick('logins')"
      >{{ t('Login') }}</button>
      <button
        type="button" role="tab" class="audit__tab"
        :class="{ 'audit__tab--on': tab === 'tokens' }"
        :aria-selected="tab === 'tokens'"
        @click="pick('tokens')"
      >{{ t('Token usage') }}</button>
    </div>

    <!-- Every state renders something. An empty table where rows exist but
         cannot be read would be a lie, so an unreachable store says so. -->
    <p v-if="page.state.value === 'loading'" class="audit__state">{{ t('Reading data…') }}</p>
    <p v-else-if="page.state.value === 'denied'" class="audit__state audit__state--bad">
      {{ t('You do not have permission to read the login audit log.') }}
    </p>
    <p v-else-if="page.state.value === 'unknown'" class="audit__state audit__state--bad">
      {{ t('Could not read the audit status.') }}
    </p>
    <p v-else-if="page.state.value === 'off'" class="audit__state">
      {{ t('The audit log is off. Set audit.enabled to record sign-ins.') }}
    </p>
    <p v-else-if="page.state.value === 'misconfigured'" class="audit__state audit__state--bad">
      {{ t('The audit log is enabled but its configuration was refused: {problem}', { problem: page.health.value?.configProblem ?? '' }) }}
    </p>
    <p v-else-if="page.state.value === 'unconfigured'" class="audit__state">
      {{ t('The audit log is enabled but no backend is selected. Set audit.provider.') }}
    </p>
    <p v-else-if="page.state.value === 'unreachable'" class="audit__state audit__state--bad">
      {{ t('The audit store cannot be reached ({cause}). Sign-ins are still being accepted, but they are not being recorded.', { cause: page.health.value?.error ?? 'unreachable' }) }}
    </p>

    <template v-else-if="tab === 'logins'">
      <AuditStatBlock
        :stat="page.stat.value"
        :window="page.statWindow.value"
        :loading="page.loadingStat.value"
        :error="page.statError.value"
        @update:window="page.setWindow"
      />

      <form class="audit__filters" @submit.prevent="page.applyFilters">
        <!-- Same three words the list is headed with, in the same order: a
             filter that names a column differently reads as a fourth thing. -->
        <label class="cf" :class="{ 'cf-wide': isCustomRange }">
          <span>{{ t('Time range') }}</span>
          <template v-if="isCustomRange">
            <div class="cf-range">
              <input v-model="page.filters.value.customStart" type="datetime-local" class="cf-input cf-range-num" />
              <span class="cf-range-sep">–</span>
              <input v-model="page.filters.value.customEnd" type="datetime-local" class="cf-input cf-range-num" />
              <button
                class="sw-btn small ghost"
                type="button"
                :title="t('Back to presets')"
                @click="page.setWindowMinutes(ALL_TIME)"
              >×</button>
            </div>
          </template>
          <select
            v-else
            class="cf-input"
            :value="page.filters.value.windowMinutes"
            @change="page.setWindowMinutes(Number(($event.target as HTMLSelectElement).value))"
          >
            <option v-for="p in TIME_RANGE_PRESETS" :key="p.minutes" :value="p.minutes">{{ p.label }}</option>
            <option :value="CUSTOM_RANGE_SENTINEL">{{ t('Custom…') }}</option>
          </select>
        </label>
        <label class="cf">
          <span>{{ t('Login ID') }}</span>
          <input v-model="page.filters.value.username" type="text" class="cf-input" :placeholder="t('name or email')" />
        </label>
        <label class="cf">
          <span>{{ t('Auth Channel') }}</span>
          <select v-model="page.filters.value.kind" class="cf-input">
            <option value="">{{ t('All') }}</option>
            <option v-for="k in KINDS" :key="k.value" :value="k.value">{{ t(k.label) }}</option>
          </select>
        </label>
        <div class="audit__actions">
          <button type="submit" class="sw-btn primary">{{ t('Query') }}</button>
          <button type="button" class="sw-btn ghost" @click="page.clearFilters">{{ t('Clear') }}</button>
        </div>
        <p v-if="page.rangeError.value" class="audit__range-error" role="alert">
          {{ t(page.rangeError.value) }}
        </p>
      </form>

      <AuditList
        :rows="page.rows.value"
        :loading="page.loadingList.value"
        :error="page.listError.value"
        :page-num="page.pageNum.value"
        :has-next="page.hasNext.value"
        @go="page.go"
      />

      <!-- Health is process-local: a multi-replica deployment has as many
           answers as replicas, so the page names the one it reached. -->
      <p v-if="page.health.value" class="audit__foot">
        {{ t('Node {node} · {rows} rows this hour', {
          node: page.health.value.horizonNode,
          rows: page.health.value.rowsThisHour,
        }) }}
        <template v-if="page.health.value.overBudgetThisHour">
          · {{ t('{n} refused by the hourly limit', { n: page.health.value.overBudgetThisHour }) }}
        </template>
      </p>
    </template>

    <template v-else>
      <TokenUsageList
        :hours="tokens.hours.value"
        :span-hours="tokens.spanHours.value"
        :custom-start="tokens.customStart.value"
        :custom-end="tokens.customEnd.value"
        :range-error="tokens.rangeError.value"
        :loading="tokens.loading.value"
        :error="tokens.error.value"
        @update:span="tokens.setSpan"
        @update:custom-start="(v: string) => { tokens.customStart.value = v; }"
        @update:custom-end="(v: string) => { tokens.customEnd.value = v; }"
        @apply="tokens.load"
      />
    </template>
  </div>
</template>

<style scoped>
.audit { display: flex; flex-direction: column; gap: 16px; padding: 16px; }
.audit__head { display: flex; flex-direction: column; gap: 4px; }
.audit__tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--sw-line); }
.audit__tab {
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  color: var(--sw-fg-3);
  font: inherit;
  font-size: var(--sw-fs-sm);
  padding: 6px 12px;
  cursor: pointer;
}
.audit__tab--on { color: var(--sw-fg-0); border-bottom-color: var(--sw-accent); }
.audit__title {
  margin: 0;
  font-size: var(--sw-fs-xl);
  font-weight: var(--sw-fw-semibold);
  color: var(--sw-fg-0);
}
.audit__blurb { margin: 0; font-size: var(--sw-fs-xs); color: var(--sw-fg-2); max-width: 78ch; }
.audit__state {
  margin: 0;
  padding: 10px 14px;
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  background: var(--sw-bg-1);
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-2);
}
.audit__state--bad { border-color: var(--sw-err); color: var(--sw-err); }
.audit__filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  background: var(--sw-bg-1);
}
/* The trace/log/explore query screens all define this same condition-field
   set locally; copied here so the audit filters are the same control. */
.cf {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: var(--sw-fg-3);
  font-weight: 500;
  min-width: 180px;
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
.cf-input:disabled { opacity: 0.5; cursor: not-allowed; }
.cf-range { display: flex; align-items: center; gap: 4px; }
.cf-range-num { flex: 1; min-width: 0; }
.cf-range-sep { color: var(--sw-fg-3); font-size: 12px; flex: 0 0 auto; }
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
.audit__range-error {
  flex-basis: 100%;
  margin: 0;
  font-size: var(--sw-fs-xs);
  color: var(--sw-err);
}
.audit__actions { display: flex; gap: 8px; }
.audit__foot { margin: 0; font-size: var(--sw-fs-xs); color: var(--sw-fg-3); font-variant-numeric: tabular-nums; }
</style>
