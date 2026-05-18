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
import { bff } from '@/api/client';
import type { AdminUsersResponse } from '@/api/scopes/admin-users';

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
  if (ms === null) return 'never';
  const diff = Math.round((Date.now() - ms) / 1000);
  if (diff < 60) return diff <= 5 ? 'now' : `${diff}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 24 * 3600) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / (24 * 3600))}d ago`;
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
        <span>Admin</span><span class="sep">/</span><span class="crumb-cur">Users</span>
      </div>
      <div class="head-actions">
        <button class="sw-btn" type="button" @click="load">Refresh</button>
      </div>
    </header>

    <div v-if="loading" class="loading">Loading users…</div>
    <div v-else-if="error" class="error">Failed to load: {{ error }}</div>
    <template v-else-if="data">
      <!-- LDAP hint banner -->
      <div v-if="data.backend === 'ldap'" class="hint hint-info">
        <span class="hint-icon">ⓘ</span>
        <div class="hint-body">
          <b>Users come from LDAP.</b>
          This list is read-only. Roles are resolved from LDAP group membership via
          <code>auth.ldap.groupMappings</code> in horizon.yaml. To add or remove a user, change
          their group in the directory — they'll appear here on next login. Local accounts shown
          below are break-glass only and ignored while LDAP is reachable.
        </div>
      </div>
      <div v-else class="hint hint-info">
        <span class="hint-icon">ⓘ</span>
        <div class="hint-body">
          <b>Local users backend.</b>
          This list mirrors <code>auth.local.users</code> in horizon.yaml. Edits to the file
          are picked up on hot-reload. Add users via the YAML +
          <code>pnpm --filter bff cli:hash</code> for password hashes.
        </div>
      </div>

      <!-- KPI cards -->
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">Total</div>
          <div class="kpi-value">{{ data.counts.total }}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">From LDAP</div>
          <div class="kpi-value info">{{ data.counts.fromLdap }}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Local / break-glass</div>
          <div class="kpi-value">{{ data.counts.local }}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Active (24h)</div>
          <div class="kpi-value ok">{{ data.counts.activeLast24h }}</div>
        </div>
      </div>

      <!-- Users table -->
      <section class="sw-card">
        <header class="card-head">
          <h3>Users</h3>
          <span class="muted">read-only · {{ data.backend === 'ldap' ? 'LDAP + local fallback' : 'local file' }}</span>
          <div class="card-actions">
            <input
              v-model="filterText"
              type="text"
              class="filter-input"
              placeholder="filter username…"
            />
            <select v-model="sourceFilter" class="filter-select">
              <option value="all">Source: All</option>
              <option value="ldap">Source: LDAP</option>
              <option value="local">Source: Local</option>
            </select>
            <select v-model="roleFilter" class="filter-select">
              <option value="all">Role: All</option>
              <option v-for="r in allRoles" :key="r" :value="r">Role: {{ r }}</option>
            </select>
          </div>
        </header>
        <table class="data-table">
          <thead>
            <tr>
              <th>Username</th>
              <th>Source</th>
              <th>Roles</th>
              <th>Last seen</th>
              <th>IP</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!filtered.length">
              <td colspan="6" class="empty">No users match the current filter.</td>
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
                  <span v-if="!u.roles.length" class="muted">none</span>
                </div>
              </td>
              <td class="mono" :class="{ 'muted-cell': u.lastSeenAt === null }">
                {{ fmtSeen(u.lastSeenAt) }}
              </td>
              <td class="mono">{{ u.lastIp ?? '—' }}</td>
              <td class="muted small">
                <template v-if="u.fallbackOnly">break-glass · file fallback</template>
                <template v-else-if="u.staticOnly">never signed in</template>
              </td>
            </tr>
          </tbody>
        </table>
        <footer class="table-foot">
          <span>
            {{ filtered.length }} shown of {{ data.counts.total }} total ·
            {{ data.counts.fromLdap }} from LDAP, {{ data.counts.local }} local · refreshed
            {{ fmtSeen(data.generatedAt) }}
          </span>
          <span class="muted small">
            See what each role can do →
            <RouterLink to="/admin/roles" class="foot-link">Roles &amp; permissions</RouterLink>
          </span>
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
.crumbs { font-size: 12px; color: var(--sw-fg-2); }
.crumbs .sep { margin: 0 6px; color: var(--sw-fg-3); }
.crumb-cur { color: var(--sw-fg-0); font-weight: 600; }
.head-actions { margin-left: auto; display: flex; gap: 8px; }

.loading, .error {
  padding: 20px; text-align: center; color: var(--sw-fg-2);
}
.error { color: var(--sw-err); }

.hint {
  display: flex; gap: 10px;
  padding: 12px 14px;
  border-radius: 6px;
  font-size: 11.5px;
  margin-bottom: 14px;
  align-items: start;
}
.hint-info {
  background: rgba(56,189,248,0.06);
  border: 1px solid rgba(56,189,248,0.3);
  color: var(--sw-fg-1);
}
.hint-icon { color: var(--sw-info); font-size: 14px; font-weight: 700; }
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
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
}
.kpi-value {
  font-size: 22px;
  font-weight: 700;
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
.card-head h3 { margin: 0; font-size: 12px; font-weight: 600; color: var(--sw-fg-0); }
.muted { color: var(--sw-fg-3); font-size: 11px; }
.muted.small { font-size: 10.5px; }
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
  font-size: 11px;
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
  font-size: 11px;
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
  color: var(--sw-fg-2);
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 600;
  border-bottom: 1px solid var(--sw-line);
}
.data-table td {
  padding: 8px 14px;
  border-bottom: 1px solid var(--sw-line);
  font-size: 12px;
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
  font-size: 10px;
  font-weight: 700;
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
  font-size: 10px;
  font-weight: 600;
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
  font-size: 11px;
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
