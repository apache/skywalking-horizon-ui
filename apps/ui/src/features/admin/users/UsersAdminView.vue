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
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { bff } from '@/api/client';
import type { AdminUsersResponse } from '@/api/scopes/admin-users';

const { t } = useI18n();

const data = ref<AdminUsersResponse | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const filterText = ref('');
const sourceFilter = ref<'all' | 'ldap' | 'local'>('all');
const roleFilter = ref<'all' | string>('all');

let refreshTimer: ReturnType<typeof setInterval> | null = null;

async function load(): Promise<void> {
  try {
    data.value = await bff.adminUsers.list();
    error.value = null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
  refreshTimer = setInterval(() => void load(), 15000);
});
onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});

const allRoles = computed(() => {
  const s = new Set<string>();
  data.value?.rows.forEach((r) => r.roles.forEach((x) => s.add(x)));
  return [...s].sort();
});

const filtered = computed(() => {
  if (!data.value) return [];
  const q = filterText.value.trim().toLowerCase();
  return data.value.rows.filter((r) => {
    if (q && !r.username.toLowerCase().includes(q)) return false;
    if (sourceFilter.value !== 'all') {
      if (sourceFilter.value === 'ldap' && r.source !== 'ldap') return false;
      if (sourceFilter.value === 'local' && r.source === 'ldap') return false;
    }
    if (roleFilter.value !== 'all' && !r.roles.includes(roleFilter.value)) return false;
    return true;
  });
});

function fmtSeen(ms: number | null): string {
  if (ms === null) return t('never');
  const diff = Math.round((Date.now() - ms) / 1000);
  if (diff < 60) return diff <= 5 ? t('now') : t('{n}s ago', { n: diff });
  if (diff < 3600) return t('{n}m ago', { n: Math.round(diff / 60) });
  if (diff < 24 * 3600) return t('{n}h ago', { n: Math.round(diff / 3600) });
  return t('{n}d ago', { n: Math.round(diff / (24 * 3600)) });
}
function initials(u: string): string {
  return u.slice(0, 2).toUpperCase();
}
function rolePill(role: string): string {
  if (role === 'admin') return 'pill-err';
  if (role === 'operator') return 'pill-warn';
  if (role === 'maintainer') return 'pill-cyan';
  return 'pill-info';
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div class="crumbs">
        <span>{{ t('Admin') }}</span><span class="sep">/</span><span class="crumb-cur">{{ t('Users') }}</span>
      </div>
      <div class="head-actions">
        <button class="sw-btn" type="button" @click="load">{{ t('Refresh') }}</button>
      </div>
    </header>

    <div v-if="loading" class="loading">{{ t('Loading users…') }}</div>
    <div v-else-if="error" class="error">{{ t('Failed to load: {msg}', { msg: error }) }}</div>
    <template v-else-if="data">
      <div v-if="data.backend === 'ldap'" class="hint hint-info">
        <span class="hint-icon">ⓘ</span>
        <div class="hint-body">
          <b>{{ t('Users come from LDAP.') }}</b>
          <i18n-t
            keypath="This list is read-only. Roles are resolved from LDAP group membership via {groupMappings} in horizon.yaml. To add or remove a user, change their group in the directory — they'll appear here on next login. Local accounts shown below are break-glass only and ignored while LDAP is reachable."
            tag="span"
            scope="global"
          >
            <template #groupMappings><code>auth.ldap.groupMappings</code></template>
          </i18n-t>
        </div>
      </div>
      <div v-else class="hint hint-info">
        <span class="hint-icon">ⓘ</span>
        <div class="hint-body">
          <b>{{ t('Local users backend.') }}</b>
          <i18n-t
            keypath="This list mirrors {localUsers} in horizon.yaml. Edits to the file are picked up on hot-reload. Add users via the YAML + {hashCli} for password hashes."
            tag="span"
            scope="global"
          >
            <template #localUsers><code>auth.local.users</code></template>
            <template #hashCli><code>pnpm --filter bff cli:hash</code></template>
          </i18n-t>
        </div>
      </div>

      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">{{ t('Total') }}</div>
          <div class="kpi-value">{{ data.counts.total }}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">{{ t('From LDAP') }}</div>
          <div class="kpi-value info">{{ data.counts.fromLdap }}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">{{ t('Local / break-glass') }}</div>
          <div class="kpi-value">{{ data.counts.local }}</div>
        </div>
        <div class="kpi-card">
          <div
            class="kpi-label"
            :title="t('Last-seen activity is tracked in each BFF replica\'s own memory and is NOT shared across the cluster. This count reflects only the node that served this page.')"
          >
            {{ t('Active (24h)') }} <span class="kpi-scope">· {{ t('this node') }}</span>
          </div>
          <div class="kpi-value ok">{{ data.counts.activeLast24h }}</div>
        </div>
      </div>
      <i18n-t
        keypath="Last-seen & Active (24h) are tracked per BFF node (in-memory, not cluster-shared) — served by {node}. In a multi-replica deploy these reflect this node only."
        tag="p"
        class="node-note"
        scope="global"
      >
        <template #node><code>{{ data.node }}</code></template>
      </i18n-t>

      <section class="sw-card">
        <header class="card-head">
          <h3>{{ t('Users') }}</h3>
          <span class="muted">{{ t('read-only') }} · {{ data.backend === 'ldap' ? t('LDAP + local fallback') : t('local file') }}</span>
          <div class="card-actions">
            <input
              v-model="filterText"
              type="text"
              class="filter-input"
              :placeholder="t('filter username…')"
            />
            <select v-model="sourceFilter" class="filter-select">
              <option value="all">{{ t('Source: All') }}</option>
              <option value="ldap">{{ t('Source: LDAP') }}</option>
              <option value="local">{{ t('Source: Local') }}</option>
            </select>
            <select v-model="roleFilter" class="filter-select">
              <option value="all">{{ t('Role: All') }}</option>
              <option v-for="r in allRoles" :key="r" :value="r">{{ t('Role: {role}', { role: r }) }}</option>
            </select>
          </div>
        </header>
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t('Username') }}</th>
              <th>{{ t('Source') }}</th>
              <th>{{ t('Roles') }}</th>
              <th :title="t('Per-node: tracked in this BFF replica\'s memory only, not shared across the cluster.')">{{ t('Last seen') }} <span class="th-scope">· {{ t('this node') }}</span></th>
              <th>{{ t('IP') }}</th>
              <th>{{ t('Note') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!filtered.length">
              <td colspan="6" class="empty">{{ t('No users match the current filter.') }}</td>
            </tr>
            <tr v-for="u in filtered" :key="u.username">
              <td>
                <div class="user-cell">
                  <span class="avatar" :class="u.source === 'ldap' ? 'avatar-ldap' : 'avatar-local'">
                    {{ initials(u.username) }}
                  </span>
                  <span class="mono">{{ u.username }}</span>
                </div>
              </td>
              <td>
                <span
                  class="pill"
                  :class="
                    u.source === 'ldap'
                      ? 'pill-info'
                      : u.source === 'break-glass'
                        ? 'pill-warn'
                        : 'pill-muted'
                  "
                >
                  {{ u.source }}
                </span>
              </td>
              <td>
                <div class="role-row">
                  <span v-for="r in u.roles" :key="r" class="pill" :class="rolePill(r)">{{ r }}</span>
                  <span v-if="!u.roles.length" class="muted">{{ t('none') }}</span>
                </div>
              </td>
              <td class="mono" :class="{ 'muted-cell': u.lastSeenAt === null }">
                {{ fmtSeen(u.lastSeenAt) }}
              </td>
              <td class="mono">{{ u.lastIp ?? '—' }}</td>
              <td class="muted small">
                <template v-if="u.fallbackOnly">{{ t('break-glass · file fallback') }}</template>
                <template v-else-if="u.staticOnly">{{ t('never signed in') }}</template>
              </td>
            </tr>
          </tbody>
        </table>
        <footer class="table-foot">
          <span>
            {{ t('{shown} shown of {total} total · {ldap} from LDAP, {local} local · refreshed {when}', { shown: filtered.length, total: data.counts.total, ldap: data.counts.fromLdap, local: data.counts.local, when: fmtSeen(data.generatedAt) }) }}
          </span>
          <i18n-t
            keypath="See what each role can do → {link}"
            tag="span"
            class="muted small"
            scope="global"
          >
            <template #link><RouterLink to="/admin/roles" class="foot-link">{{ t('Roles & permissions') }}</RouterLink></template>
          </i18n-t>
        </footer>
      </section>
    </template>
  </div>
</template>

<style scoped>
.page {
  padding: 18px 22px 32px;
  color: var(--sw-fg-0);
}
.page-head {
  display: flex;
  align-items: center;
  margin-bottom: 16px;
}
.crumbs { font-size: var(--sw-fs-base); color: var(--sw-fg-2); }
.crumbs .sep { margin: 0 6px; color: var(--sw-fg-3); }
.crumb-cur { color: var(--sw-fg-0); font-weight: var(--sw-fw-semibold); }
.head-actions { margin-left: auto; display: flex; gap: 8px; }

.loading, .error {
  padding: 20px; text-align: center; color: var(--sw-fg-2);
}
.error { color: var(--sw-err); }

.hint {
  display: flex; gap: 10px;
  padding: 12px 14px;
  border-radius: 6px;
  font-size: var(--sw-fs-sm);
  margin-bottom: 14px;
  /* Align the leading icon to the first line of the body text (the two
   * differ in size/weight, so `start` left them on different baselines). */
  align-items: baseline;
}
.hint-body { line-height: var(--sw-lh-relaxed); }
.hint-info {
  background: rgba(56,189,248,0.06);
  border: 1px solid rgba(56,189,248,0.3);
  color: var(--sw-fg-1);
}
.hint-icon { color: var(--sw-info); font-size: var(--sw-fs-lg); font-weight: var(--sw-fw-bold); }
.hint-body b { color: var(--sw-fg-0); }
.hint-body code { font-family: var(--sw-mono); color: var(--sw-fg-0); }

.kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 14px;
}
.kpi-card {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  padding: 12px 14px;
}
.kpi-label {
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
}
.kpi-scope {
  text-transform: none;
  letter-spacing: 0;
  color: var(--sw-warn);
  cursor: help;
}
.node-note {
  margin: -4px 0 14px;
  font-size: var(--sw-fs-sm);
  line-height: 1.5;
  color: var(--sw-fg-3);
}
.node-note code {
  font-family: var(--sw-mono);
  color: var(--sw-fg-1);
}
.th-scope {
  text-transform: none;
  letter-spacing: 0;
  font-weight: var(--sw-fw-regular);
  color: var(--sw-warn);
  cursor: help;
}
.kpi-value {
  font-size: var(--sw-fs-2xl);
  font-weight: var(--sw-fw-bold);
  color: var(--sw-fg-0);
  margin-top: 4px;
}
.kpi-value.info { color: var(--sw-info); }
.kpi-value.ok { color: var(--sw-ok); }

.sw-card {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  overflow: hidden;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-2);
}
.card-head h3 { margin: 0; font-size: var(--sw-fs-base); font-weight: var(--sw-fw-semibold); color: var(--sw-fg-0); }
.muted { color: var(--sw-fg-3); font-size: var(--sw-fs-sm); }
.muted.small { font-size: var(--sw-fs-xs); }
.card-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}
.filter-input {
  height: 24px;
  padding: 0 10px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 5px;
  color: var(--sw-fg-0);
  font-size: var(--sw-fs-sm);
  outline: none;
  width: 180px;
}
.filter-input:focus { border-color: var(--sw-accent-line); }
.filter-select {
  height: 24px;
  padding: 0 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 5px;
  color: var(--sw-fg-0);
  font-size: var(--sw-fs-sm);
  cursor: pointer;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
}
.data-table th {
  text-align: left;
  padding: 8px 14px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-3);
  font-size: var(--sw-fs-xs);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  font-weight: var(--sw-fw-bold);
  border-bottom: 1px solid var(--sw-line);
}
.data-table td {
  padding: 8px 14px;
  border-bottom: 1px solid var(--sw-line);
  font-size: var(--sw-fs-base);
  color: var(--sw-fg-1);
}
.data-table tr:last-child td { border-bottom: none; }
.data-table .mono { font-family: var(--sw-mono); }
.data-table .muted-cell { color: var(--sw-fg-3); }
.data-table code { font-family: var(--sw-mono); color: var(--sw-fg-0); }
.empty {
  text-align: center;
  color: var(--sw-fg-3);
  padding: 20px;
}

.user-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}
.avatar {
  width: 22px; height: 22px;
  border-radius: 50%;
  display: grid; place-items: center;
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  color: #0a0d12;
}
.avatar-ldap {
  background: linear-gradient(135deg, var(--sw-info), var(--sw-purple, #a855f7));
}
.avatar-local {
  background: linear-gradient(135deg, var(--sw-fg-3), var(--sw-fg-2));
}

.role-row { display: flex; gap: 4px; flex-wrap: wrap; }

.pill {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  height: 18px;
  border-radius: 4px;
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-semibold);
  border: 1px solid;
}
.pill-ok    { color: var(--sw-ok);    background: rgba(34,197,94,0.14);  border-color: rgba(34,197,94,0.33); }
.pill-warn  { color: var(--sw-warn);  background: rgba(234,179,8,0.16);  border-color: rgba(234,179,8,0.33); }
.pill-err   { color: var(--sw-err);   background: rgba(239,68,68,0.16);  border-color: rgba(239,68,68,0.33); }
.pill-info  { color: var(--sw-info);  background: rgba(56,189,248,0.16); border-color: rgba(56,189,248,0.33); }
.pill-cyan  { color: var(--sw-cyan, #22d3ee); background: rgba(34,211,238,0.14); border-color: rgba(34,211,238,0.33); }
.pill-muted { color: var(--sw-fg-3);  background: var(--sw-bg-2);        border-color: var(--sw-line-2); }

.table-foot {
  display: flex;
  align-items: center;
  padding: 8px 14px;
  border-top: 1px solid var(--sw-line);
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-2);
}
.table-foot .muted {
  margin-left: auto;
  color: var(--sw-fg-3);
}
.table-foot code { font-family: var(--sw-mono); color: var(--sw-fg-1); }
.foot-link { color: var(--sw-accent-2); text-decoration: none; }
.foot-link:hover { text-decoration: underline; }
</style>
