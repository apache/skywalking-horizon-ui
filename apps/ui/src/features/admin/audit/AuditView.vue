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
import { onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AuditKind } from '@/api/scopes/admin-audit';
import AuditList from './AuditList.vue';
import AuditStatBlock from './AuditStatBlock.vue';
import { useAuditPage } from './useAuditPage';

const { t } = useI18n();
const page = useAuditPage();

const KINDS: { value: AuditKind; label: string }[] = [
  { value: 'local', label: 'Password' },
  { value: 'ldap', label: 'LDAP' },
  { value: 'break-glass', label: 'Break-glass' },
  { value: 'sso', label: 'Single sign-on' },
  { value: 'api-token', label: 'API token' },
  { value: 'oauth-token', label: 'OAuth token' },
];

function toggleKind(kind: AuditKind): void {
  const list = page.filters.value.kind;
  page.filters.value.kind = list.includes(kind) ? list.filter((k) => k !== kind) : [...list, kind];
}

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

    <template v-else>
      <AuditStatBlock
        :stat="page.stat.value"
        :window="page.statWindow.value"
        :loading="page.loadingStat.value"
        :error="page.statError.value"
        @update:window="page.setWindow"
      />

      <form class="audit__filters" @submit.prevent="page.applyFilters">
        <label class="audit__field">
          <span>{{ t('Who') }}</span>
          <input v-model="page.filters.value.username" type="text" :placeholder="t('name, email or token id')" />
        </label>
        <div class="audit__kinds">
          <button
            v-for="k in KINDS"
            :key="k.value"
            type="button"
            class="audit__kind"
            :class="{ 'audit__kind--on': page.filters.value.kind.includes(k.value) }"
            :aria-pressed="page.filters.value.kind.includes(k.value)"
            @click="toggleKind(k.value)"
          >
            {{ t(k.label) }}
          </button>
        </div>
        <div class="audit__actions">
          <button type="submit">{{ t('Apply') }}</button>
          <button type="button" @click="page.clearFilters">{{ t('Clear') }}</button>
          <button type="button" :disabled="page.loadingList.value" @click="page.refresh">
            {{ t('Refresh') }}
          </button>
        </div>
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
  </div>
</template>

<style scoped>
.audit { display: flex; flex-direction: column; gap: 16px; padding: 16px; }
.audit__head { display: flex; flex-direction: column; gap: 4px; }
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
.audit__field { display: flex; flex-direction: column; gap: 4px; }
.audit__field span {
  font-size: var(--sw-fs-xs);
  letter-spacing: var(--sw-ls-caps);
  text-transform: uppercase;
  color: var(--sw-fg-3);
}
.audit__field input,
.audit__field select {
  background: var(--sw-bg-0);
  border: 1px solid var(--sw-line);
  border-radius: 3px;
  color: var(--sw-fg-0);
  font-size: var(--sw-fs-sm);
  padding: 4px 8px;
  min-width: 180px;
}
.audit__kinds { display: flex; flex-wrap: wrap; gap: 4px; }
.audit__kind {
  background: transparent;
  border: 1px solid var(--sw-line);
  border-radius: 3px;
  color: var(--sw-fg-2);
  font-size: var(--sw-fs-xs);
  padding: 3px 8px;
  cursor: pointer;
}
.audit__kind--on { background: var(--sw-bg-2); color: var(--sw-fg-0); border-color: var(--sw-line-2); }
.audit__actions { display: flex; gap: 8px; }
.audit__actions button {
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 3px;
  color: var(--sw-fg-1);
  font-size: var(--sw-fs-xs);
  padding: 5px 12px;
  cursor: pointer;
}
.audit__foot { margin: 0; font-size: var(--sw-fs-xs); color: var(--sw-fg-3); font-variant-numeric: tabular-nums; }
</style>
