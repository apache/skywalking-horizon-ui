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
 * The sign-in list. Newest first, 50 a page.
 *
 * There is no total and never will be: the page contract reports only whether
 * more exists, never how much more. Investigation fields live in the expanded
 * row rather than the scan — they are what you need when a row is the subject,
 * and noise when you are reading fifty.
 */
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AuditEntry } from '@/api/scopes/admin-audit';

defineProps<{
  rows: AuditEntry[];
  loading: boolean;
  error: string | null;
  pageNum: number;
  hasNext: boolean;
}>();
const emit = defineEmits<{ (e: 'go', delta: number): void }>();

const { t } = useI18n();
const open = ref<string | null>(null);

/** Translated labels; the enum value itself stays verbatim in the wire, the
 *  filters and the URL. */
const KIND_LABELS: Record<string, string> = {
  local: 'Password',
  ldap: 'LDAP',
  'break-glass': 'Break-glass',
  sso: 'Single sign-on',
  'api-token': 'API token',
  'oauth-token': 'OAuth token',
};
const REASON_LABELS: Record<string, string> = {
  no_roles: 'No roles for this account',
  zero_group_mappings: 'No group mapped to a role',
};

/** yyyyMMddHH is a UTC label; render it in the reader's zone like every other
 *  time on the page, rather than showing the raw integer. */
function hourLabel(bucket: number): string {
  const hour = bucket % 100;
  const day = Math.floor(bucket / 100) % 100;
  const month = Math.floor(bucket / 10_000) % 100;
  const year = Math.floor(bucket / 1_000_000);
  return new Date(Date.UTC(year, month - 1, day, hour)).toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  });
}

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}
</script>

<template>
  <section class="list">
    <p v-if="loading" class="list__note">{{ t('Reading data…') }}</p>
    <p v-else-if="error" class="list__note list__note--bad">{{ error }}</p>
    <p v-else-if="rows.length === 0" class="list__note">
      {{ t('No sign-ins match these filters.') }}
    </p>

    <div v-else class="list__scroll">
      <table class="list__table">
        <thead>
          <tr>
            <th>{{ t('When') }}</th>
            <th>{{ t('How') }}</th>
            <th>{{ t('Who') }}</th>
            <th>{{ t('Result') }}</th>
            <th>{{ t('Client address') }}</th>
            <th class="list__num">{{ t('Uses') }}</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="row in rows" :key="row.id">
            <tr
              class="list__row"
              tabindex="0"
              role="button"
              :aria-expanded="open === row.id"
              @click="open = open === row.id ? null : row.id"
              @keydown.enter.prevent="open = open === row.id ? null : row.id"
              @keydown.space.prevent="open = open === row.id ? null : row.id"
            >
              <td class="list__when">{{ when(row.at) }}</td>
              <td>{{ t(KIND_LABELS[row.kind] ?? row.kind) }}</td>
              <td class="list__who">{{ row.username }}</td>
              <td>
                <span class="list__pill" :class="row.outcome === 1 ? 'list__pill--ok' : 'list__pill--no'">
                  {{ row.outcome === 1 ? t('Accepted') : t('Refused') }}
                </span>
                <span v-if="row.reason" class="list__reason">
                  {{ t(REASON_LABELS[row.reason] ?? row.reason) }}
                </span>
              </td>
              <!-- Blank on an aggregate row, where it means "not applicable"
                   rather than "unknown": a credential-hour has no one address. -->
              <td class="list__ip">{{ row.clientIp ?? '—' }}</td>
              <td class="list__num">{{ row.count > 1 ? row.count : '' }}</td>
            </tr>
            <tr v-if="open === row.id" class="list__detail">
              <td colspan="6">
                <dl class="list__dl">
                  <template v-if="row.mail">
                    <dt>{{ t('Verified email') }}</dt><dd>{{ row.mail }}</dd>
                  </template>
                  <template v-if="row.provider">
                    <dt>{{ t('Provider') }}</dt><dd>{{ row.provider }}</dd>
                  </template>
                  <template v-if="row.roles">
                    <dt>{{ t('Roles granted') }}</dt><dd>{{ row.roles }}</dd>
                  </template>
                  <template v-if="row.hourBucket">
                    <dt>{{ t('Counted for the hour') }}</dt><dd>{{ hourLabel(row.hourBucket) }}</dd>
                  </template>
                  <dt>{{ t('Recorded by') }}</dt>
                  <dd>{{ row.horizonNode }}<template v-if="row.horizonIp"> ({{ row.horizonIp }})</template></dd>
                </dl>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <footer class="list__pager">
      <button type="button" :disabled="pageNum <= 1 || loading" @click="emit('go', -1)">
        {{ t('Previous') }}
      </button>
      <span class="list__page">{{ t('Page {n}', { n: pageNum }) }}</span>
      <button type="button" :disabled="!hasNext || loading" @click="emit('go', 1)">
        {{ t('Next') }}
      </button>
    </footer>
  </section>
</template>

<style scoped>
.list { display: flex; flex-direction: column; gap: 10px; }
.list__scroll { overflow-x: auto; }
.list__table { width: 100%; border-collapse: collapse; font-size: var(--sw-fs-sm); }
.list__table th {
  text-align: left;
  font-size: var(--sw-fs-xs);
  letter-spacing: var(--sw-ls-caps);
  text-transform: uppercase;
  color: var(--sw-fg-3);
  font-weight: var(--sw-fw-semibold);
  padding: 6px 10px;
  border-bottom: 1px solid var(--sw-line);
  white-space: nowrap;
}
.list__table td { padding: 6px 10px; border-bottom: 1px solid var(--sw-line); color: var(--sw-fg-1); }
.list__row { cursor: pointer; }
.list__row:focus-visible { outline: 2px solid var(--sw-accent); outline-offset: -2px; }
.list__row:hover { background: var(--sw-bg-2); }
.list__when, .list__ip, .list__num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.list__who { font-family: var(--sw-mono); color: var(--sw-fg-0); }
.list__num { text-align: right; }
.list__pill {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: var(--sw-fs-xs);
  border: 1px solid transparent;
}
.list__pill--ok { color: var(--sw-ok); border-color: var(--sw-ok); }
.list__pill--no { color: var(--sw-err); border-color: var(--sw-err); }
.list__reason { margin-left: 8px; font-size: var(--sw-fs-xs); color: var(--sw-fg-2); }
.list__detail td { background: var(--sw-bg-2); }
.list__dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 16px;
  margin: 0;
  font-size: var(--sw-fs-xs);
}
.list__dl dt { color: var(--sw-fg-3); }
.list__dl dd { margin: 0; color: var(--sw-fg-1); font-family: var(--sw-mono); }
.list__pager { display: flex; align-items: center; gap: 12px; }
.list__pager button {
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  color: var(--sw-fg-1);
  font-size: var(--sw-fs-xs);
  padding: 4px 10px;
  border-radius: 3px;
  cursor: pointer;
}
.list__pager button:disabled { opacity: 0.4; cursor: default; }
.list__page { font-size: var(--sw-fs-xs); color: var(--sw-fg-2); font-variant-numeric: tabular-nums; }
.list__note { margin: 0; font-size: var(--sw-fs-xs); color: var(--sw-fg-2); }
.list__note--bad { color: var(--sw-err); }
</style>
