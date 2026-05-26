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
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useOapConfig } from './useOapConfig';

// Read-only snapshot of OAP's resolved runtime config, grouped by module
// (the first dotted segment). OAP masks secret values to `******`
// server-side, so nothing sensitive is exposed here.

const { t } = useI18n({ useScope: 'global' });
const { reachable, entries, data, isLoading, refetch } = useOapConfig();

const filter = ref('');

interface Group {
  module: string;
  rows: { key: string; value: string }[];
}

const groups = computed<Group[]>(() => {
  const needle = filter.value.trim().toLowerCase();
  const byModule = new Map<string, { key: string; value: string }[]>();
  for (const e of entries.value) {
    if (needle && !e.key.toLowerCase().includes(needle) && !e.value.toLowerCase().includes(needle)) {
      continue;
    }
    const list = byModule.get(e.module) ?? [];
    list.push({ key: e.key, value: e.value });
    byModule.set(e.module, list);
  }
  return [...byModule.entries()]
    .map(([module, rows]) => ({ module, rows }))
    .sort((a, b) => a.module.localeCompare(b.module));
});

const matchCount = computed<number>(() => groups.value.reduce((n, g) => n + g.rows.length, 0));

function isMasked(v: string): boolean {
  return v === '******';
}
</script>

<template>
  <div class="cfg">
    <header class="page-head">
      <div>
        <!-- Kicker + lede each kept as ONE translation unit so non-English
             locales render coherent prose; previously the lede was split
             into three t() calls around two inline <code> elements, which
             produced "English | translated word | English" mid-sentence
             when only some fragments had non-English entries. -->
        <div class="kicker">{{ t('Operate · OAP configuration') }}</div>
        <h1>{{ t('Runtime config') }}</h1>
        <p class="lede">
          <i18n-t
            keypath="The connected OAP's resolved configuration, read from the admin port's {endpoint} and grouped by module. Secret values (passwords, tokens, access keys) are masked to {mask} by OAP itself. Read-only — change config on the OAP side and restart."
            tag="span"
            scope="global"
          >
            <template #endpoint><code>/debugging/config/dump</code></template>
            <template #mask><code>******</code></template>
          </i18n-t>
        </p>
      </div>
      <button type="button" class="refresh" @click="refetch()">{{ t('refresh') }}</button>
    </header>

    <div v-if="!reachable && data?.error" class="last-error block">
      <strong>{{ t('Admin host unreachable') }}</strong>
      <code>{{ data.error }}</code>
      <p class="hint">
        <i18n-t
          keypath="Tried {url}. Confirm the OAP {module} module is on ({env}) and the port is exposed."
          tag="span"
          scope="global"
        >
          <template #url><code>{{ data.adminUrl }}/debugging/config/dump</code></template>
          <template #module><code>admin-server</code></template>
          <template #env><code>SW_ADMIN_SERVER=default</code></template>
        </i18n-t>
      </p>
    </div>

    <div v-else-if="isLoading && !data" class="empty">{{ t('Reading data…') }}</div>

    <template v-else>
      <div class="toolbar">
        <input
          v-model="filter"
          type="text"
          class="filter"
          :placeholder="t('Filter keys or values…')"
          spellcheck="false"
        />
        <span class="count">{{ t('{matched} of {total} keys', { matched: matchCount, total: entries.length }) }}</span>
      </div>

      <div v-if="groups.length === 0" class="empty">{{ t('No keys match “{q}”.', { q: filter }) }}</div>

      <section v-for="g in groups" :key="g.module" class="modblock">
        <header class="modblock-head">
          <code class="modname">{{ g.module }}</code>
          <span class="modcount">{{ g.rows.length }}</span>
        </header>
        <table class="cfg-table">
          <tbody>
            <tr v-for="row in g.rows" :key="row.key">
              <td class="ckey"><code>{{ row.key }}</code></td>
              <td class="cval" :class="{ empty: row.value === '', masked: isMasked(row.value) }">
                <code>{{ row.value === '' ? t('(empty)') : row.value }}</code>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>
  </div>
</template>

<style scoped>
.cfg {
  padding: 20px 20px 60px;
  max-width: 1440px;
  margin: 0 auto;
}
.page-head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 22px;
}
.page-head > div {
  flex: 1;
}
.kicker {
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-semibold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-accent);
  margin-bottom: 6px;
}
.page-head h1 {
  font-size: var(--sw-fs-2xl);
  font-weight: var(--sw-fw-semibold);
  letter-spacing: -0.02em;
  color: var(--sw-fg-0);
  margin: 0 0 8px;
}
.lede {
  font-size: var(--sw-fs-base);
  color: var(--sw-fg-1);
  line-height: var(--sw-lh-relaxed);
  margin: 0;
  max-width: 760px;
}
.lede code {
  font-family: var(--sw-mono);
  background: var(--sw-bg-1);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: var(--sw-fs-sm);
}
.refresh {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-1);
  font-size: var(--sw-fs-sm);
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.refresh:hover {
  background: var(--sw-bg-2);
  color: var(--sw-fg-0);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.filter {
  flex: 1;
  max-width: 420px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  color: var(--sw-fg-0);
  font-size: var(--sw-fs-base);
  padding: 7px 10px;
  font-family: var(--sw-mono);
}
.filter:focus {
  outline: none;
  border-color: var(--sw-accent);
}
.count {
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-3);
  font-variant-numeric: tabular-nums;
}

.modblock {
  margin-bottom: 18px;
}
.modblock-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.modblock-head .modname {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-base);
  font-weight: var(--sw-fw-semibold);
  color: var(--sw-accent);
}
.modblock-head .modcount {
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-3);
  background: var(--sw-bg-1);
  border-radius: 999px;
  padding: 1px 7px;
  font-variant-numeric: tabular-nums;
}

.cfg-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  overflow: hidden;
  font-size: var(--sw-fs-sm);
  table-layout: fixed;
}
.cfg-table td {
  padding: 6px 12px;
  border-bottom: 1px solid var(--sw-line);
  vertical-align: top;
  word-break: break-all;
}
.cfg-table tr:last-child td {
  border-bottom: none;
}
.ckey {
  width: 44%;
}
.ckey code {
  font-family: var(--sw-mono);
  color: var(--sw-fg-1);
}
.cval code {
  font-family: var(--sw-mono);
  color: var(--sw-fg-0);
}
.cval.empty code {
  color: var(--sw-fg-3);
  font-style: italic;
}
.cval.masked code {
  color: var(--sw-warn);
  letter-spacing: var(--sw-ls-caps);
}

.empty {
  padding: 14px;
  color: var(--sw-fg-3);
  font-size: var(--sw-fs-base);
  background: var(--sw-bg-1);
  border: 1px dashed var(--sw-line-2);
  border-radius: 6px;
}

.last-error {
  margin-bottom: 22px;
  padding: 10px 12px;
  background: var(--sw-err-soft);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-1);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}
.last-error strong {
  color: var(--sw-err);
  font-weight: var(--sw-fw-semibold);
  text-transform: uppercase;
  font-size: var(--sw-fs-xs);
  letter-spacing: var(--sw-ls-caps);
}
.last-error code {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-0);
  word-break: break-all;
}
.last-error .hint {
  margin: 6px 0 0;
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-1);
  line-height: var(--sw-lh-relaxed);
}
.last-error .hint code {
  background: rgba(0, 0, 0, 0.25);
  padding: 1px 4px;
  border-radius: 3px;
}
</style>
