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
import { useI18n } from 'vue-i18n';
import { bff } from '@/api/client';
import type { AuthStatus } from '@/api/scopes/admin-auth';

const { t } = useI18n();

const status = ref<AuthStatus | null>(null);
const loading = ref(true);
const probing = ref(false);
const probeError = ref<string | null>(null);
const testUsername = ref('');
const lastResolveResult = ref<{
  username: string;
  found: boolean;
  dn: string | null;
  groups: string[];
  roles: string[];
  error?: string;
} | null>(null);

let refreshTimer: ReturnType<typeof setInterval> | null = null;

async function load(): Promise<void> {
  try {
    status.value = await bff.adminAuth.status();
    probeError.value = null;
  } catch (err) {
    probeError.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function probeNow(): Promise<void> {
  if (probing.value) return;
  probing.value = true;
  try {
    const result = await bff.adminAuth.probe(testUsername.value || undefined);
    lastResolveResult.value = result.resolved;
    await load();
  } catch (err) {
    probeError.value = err instanceof Error ? err.message : String(err);
  } finally {
    probing.value = false;
  }
}

onMounted(() => {
  void load();
  refreshTimer = setInterval(() => void load(), 30000);
});
onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});

const healthy = computed(() => {
  const s = status.value;
  if (!s) return null;
  if (s.backend === 'local') return s.local.users > 0;
  return s.ldap?.probe.reachable && s.ldap.probe.userSearchOk !== false;
});

function fmtMtime(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' Z';
}
function fmtBytes(n: number | null): string {
  if (n === null) return '—';
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}
function fmtAgo(ms: number | null): string {
  if (!ms) return '—';
  const diff = Math.round((Date.now() - ms) / 1000);
  if (diff < 60) return t('{n}s ago', { n: diff });
  if (diff < 3600) return t('{n}m ago', { n: Math.round(diff / 60) });
  return t('{n}h ago', { n: Math.round(diff / 3600) });
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div class="crumbs">
        <span>{{ t('Admin') }}</span><span class="sep">/</span><span class="crumb-cur">{{ t('Auth status') }}</span>
      </div>
      <div class="head-actions">
        <button class="sw-btn" type="button" @click="load">{{ t('Refresh') }}</button>
        <button
          v-if="status?.backend === 'ldap'"
          class="sw-btn is-primary"
          type="button"
          :disabled="probing"
          @click="probeNow"
        >
          {{ probing ? t('Probing…') : t('Probe now') }}
        </button>
      </div>
    </header>

    <div v-if="loading" class="loading">{{ t('Loading auth status…') }}</div>
    <div v-else-if="probeError" class="error">{{ t('Failed to load: {err}', { err: probeError }) }}</div>
    <template v-else-if="status">
      <div class="head-card">
        <div class="head-left">
          <div class="status-glyph" :class="{ ok: healthy, err: !healthy }">
            {{ healthy ? '✓' : '!' }}
          </div>
          <div>
            <div class="status-title">
              {{ healthy ? t('Auth healthy') : t('Auth degraded') }}
            </div>
            <div class="status-sub">
              {{ status.backend === 'ldap' ? t('LDAP backend') : t('Local users backend') }}
              <template v-if="status.backend === 'ldap' && status.ldap">
                · {{ status.ldap.host }}
                ·
                <span :class="status.ldap.probe.reachable ? 'pos' : 'neg'">
                  {{ status.ldap.probe.reachable ? t('reachable') : t('unreachable') }}
                </span>
              </template>
              <template v-else> · {{ t('{n} user(s) defined', { n: status.local.users }) }} </template>
              · {{ t('break-glass') }}
              <b class="emph">{{ status.breakGlass.armed ? t('armed') : status.breakGlass.configured ? t('configured (disarmed)') : t('disabled') }}</b>
            </div>
          </div>
        </div>
        <div class="head-kpis">
          <div class="kpi">
            <div class="kpi-label">{{ t('Backend') }}</div>
            <div class="kpi-value info">{{ status.backend }}</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">{{ t('Sessions') }}</div>
            <div class="kpi-value">{{ status.sessions.active }}</div>
          </div>
          <div v-if="status.ldap" class="kpi">
            <div class="kpi-label">{{ t('LDAP latency') }}</div>
            <div class="kpi-value">
              {{ status.ldap.probe.latencyMs !== null ? status.ldap.probe.latencyMs + 'ms' : '—' }}
            </div>
          </div>
          <div class="kpi">
            <div class="kpi-label">{{ t('Group mappings') }}</div>
            <div class="kpi-value">{{ status.ldap?.groupMappings.length ?? '—' }}</div>
          </div>
        </div>
      </div>

      <div v-if="status.bothPresent" class="hint hint-warn">
        <span class="hint-icon">⚠</span>
        <i18n-t
          keypath="{title} {localUsers} is populated but the active backend is LDAP — local users are ignored except as a break-glass source."
          tag="span"
          scope="global"
        >
          <template #title><b>{{ t('Both backends present.') }}</b></template>
          <template #localUsers><code>auth.local.users</code></template>
        </i18n-t>
      </div>

      <div class="grid-2col">
        <section class="sw-card">
          <header class="card-head">
            <h3>{{ t('Backend') }}</h3>
            <span class="muted">GET /api/admin/auth-status</span>
          </header>
          <table class="kv">
            <tbody>
              <tr>
                <td class="k">{{ t('Provider') }}</td>
                <td class="v">
                  <span class="pill" :class="status.backend === 'ldap' ? 'pill-info' : 'pill-muted'">
                    {{ status.backend.toUpperCase() }}
                  </span>
                  <span v-if="status.bothPresent" class="muted small">
                    {{ t('(local fallback armed)') }}
                  </span>
                </td>
              </tr>
              <tr>
                <td class="k">{{ t('Mode') }}</td>
                <td class="v">
                  {{ status.backend === 'ldap' ? t('bind + search') : t('argon2id hash compare') }}
                </td>
              </tr>
              <tr>
                <td class="k">{{ t('Config file') }}</td>
                <td class="v">
                  <code>{{ status.configPath }}</code>
                  <div class="muted small mono">
                    {{ t('mtime') }} {{ fmtMtime(status.configMtime) }} · {{ fmtBytes(status.configSizeBytes) }}
                  </div>
                </td>
              </tr>
              <tr>
                <td class="k">{{ t('Active sessions') }}</td>
                <td class="v">{{ status.sessions.active }}</td>
              </tr>
              <tr>
                <td class="k">{{ t('Break-glass') }}</td>
                <td class="v">
                  <span
                    class="pill"
                    :class="
                      status.breakGlass.armed
                        ? 'pill-warn'
                        : status.breakGlass.configured
                          ? 'pill-muted'
                          : 'pill-muted'
                    "
                  >
                    {{ status.breakGlass.armed ? t('ARMED') : status.breakGlass.configured ? t('CONFIGURED') : t('DISABLED') }}
                  </span>
                  <i18n-t
                    v-if="status.breakGlass.username"
                    keypath="username {name}"
                    tag="div"
                    class="muted small"
                    scope="global"
                  >
                    <template #name><code>{{ status.breakGlass.username }}</code></template>
                  </i18n-t>
                  <i18n-t
                    v-else
                    keypath="add {key} in horizon.yaml to arm"
                    tag="div"
                    class="muted small"
                    scope="global"
                  >
                    <template #key><code>auth.breakGlass</code></template>
                  </i18n-t>
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section class="sw-card">
          <header class="card-head">
            <h3>{{ t('Local users') }}</h3>
            <span class="muted">
              {{ status.backend === 'local' ? t('primary backend') : t('break-glass fallback') }}
            </span>
          </header>
          <table class="kv">
            <tbody>
              <tr>
                <td class="k">{{ t('Users defined') }}</td>
                <td class="v">{{ status.local.users }}</td>
              </tr>
              <tr>
                <td class="k">{{ t('Hash algo') }}</td>
                <td class="v">argon2id</td>
              </tr>
              <tr>
                <td class="k">{{ t('Source') }}</td>
                <td class="v">
                  <code>{{ status.configPath }}</code>
                  <i18n-t
                    keypath="section {key}"
                    tag="div"
                    class="muted small"
                    scope="global"
                  >
                    <template #key><code>auth.local.users</code></template>
                  </i18n-t>
                </td>
              </tr>
              <tr>
                <td class="k">{{ t('Role') }}</td>
                <td class="v">
                  <span class="pill" :class="status.local.role === 'primary' ? 'pill-info' : 'pill-warn'">
                    {{ status.local.role === 'primary' ? t('PRIMARY') : t('BREAK-GLASS ONLY') }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>

      <section v-if="status.ldap" class="sw-card">
        <header class="card-head">
          <h3>{{ t('LDAP probe') }}</h3>
          <span class="muted">{{ t('last probe {ago}', { ago: fmtAgo(status.ldap.probe.at) }) }}</span>
        </header>
        <table class="kv">
          <tbody>
            <tr>
              <td class="k">{{ t('URL') }}</td>
              <td class="v"><code>{{ status.ldap.url }}</code></td>
            </tr>
            <tr>
              <td class="k">{{ t('Service bind DN') }}</td>
              <td class="v">
                <code v-if="status.ldap.bindDn">{{ status.ldap.bindDn }}</code>
                <span v-else class="muted">{{ t('anonymous bind') }}</span>
              </td>
            </tr>
            <tr>
              <td class="k">{{ t('User base DN') }}</td>
              <td class="v"><code>{{ status.ldap.userBaseDn }}</code></td>
            </tr>
            <tr>
              <td class="k">{{ t('Group strategy') }}</td>
              <td class="v"><code>{{ status.ldap.groupStrategy }}</code></td>
            </tr>
            <tr>
              <td class="k">{{ t('Reachable') }}</td>
              <td class="v">
                <span class="pill" :class="status.ldap.probe.reachable ? 'pill-ok' : 'pill-err'">
                  {{ status.ldap.probe.reachable ? t('YES') : t('NO') }}
                </span>
              </td>
            </tr>
            <tr v-if="status.ldap.probe.serviceBindOk !== null">
              <td class="k">{{ t('Service bind') }}</td>
              <td class="v">
                <span class="pill" :class="status.ldap.probe.serviceBindOk ? 'pill-ok' : 'pill-err'">
                  {{ status.ldap.probe.serviceBindOk ? t('OK') : t('FAIL') }}
                </span>
              </td>
            </tr>
            <tr v-if="status.ldap.probe.userSearchOk !== null">
              <td class="k">{{ t('User search') }}</td>
              <td class="v">
                <span class="pill" :class="status.ldap.probe.userSearchOk ? 'pill-ok' : 'pill-err'">
                  {{ status.ldap.probe.userSearchOk ? t('OK') : t('FAIL') }}
                </span>
                <span v-if="status.ldap.probe.userEntriesVisible !== null" class="muted small">
                  · {{ t('{n} entries visible', { n: status.ldap.probe.userEntriesVisible }) }}
                </span>
              </td>
            </tr>
            <tr v-if="status.ldap.probe.latencyMs !== null">
              <td class="k">{{ t('Latency') }}</td>
              <td class="v"><code>{{ status.ldap.probe.latencyMs }}ms</code></td>
            </tr>
            <tr v-if="status.ldap.probe.error">
              <td class="k">{{ t('Error') }}</td>
              <td class="v err">{{ status.ldap.probe.error }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section v-if="status.ldap && status.ldap.groupMappings.length" class="sw-card">
        <header class="card-head">
          <h3>{{ t('Group → role mapping') }}</h3>
          <span class="muted">{{ t('first match wins · "*" matches every authenticated user') }}</span>
        </header>
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t('LDAP group DN') }}</th>
              <th>{{ t('Role') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in status.ldap.groupMappings" :key="m.group + '|' + m.role">
              <td><code>{{ m.group }}</code></td>
              <td>
                <span
                  class="pill"
                  :class="
                    m.role === 'admin'
                      ? 'pill-err'
                      : m.role === 'operator'
                        ? 'pill-warn'
                        : m.role === 'maintainer'
                          ? 'pill-cyan'
                          : 'pill-info'
                  "
                >
                  {{ m.role }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section v-if="status.ldap" class="sw-card">
        <header class="card-head">
          <h3>{{ t('Test a username') }}</h3>
          <span class="muted">{{ t('resolves group memberships without authenticating') }}</span>
        </header>
        <div class="resolver-row">
          <input
            v-model="testUsername"
            type="text"
            :placeholder="t('username')"
            @keydown.enter="probeNow"
          />
          <button class="sw-btn" type="button" :disabled="probing" @click="probeNow">
            {{ t('Resolve') }}
          </button>
        </div>
        <div v-if="lastResolveResult" class="resolver-result">
          <template v-if="lastResolveResult.error">
            <span class="err">{{ t('Error: {msg}', { msg: lastResolveResult.error }) }}</span>
          </template>
          <template v-else-if="!lastResolveResult.found">
            <i18n-t
              keypath="No user entry found for {username}"
              tag="span"
              class="muted"
              scope="global"
            >
              <template #username><code>{{ lastResolveResult.username }}</code></template>
            </i18n-t>
          </template>
          <template v-else>
            <div>
              <span class="k-inline">{{ t('DN:') }}</span>
              <code>{{ lastResolveResult.dn }}</code>
            </div>
            <div>
              <span class="k-inline">{{ t('Groups ({n}):', { n: lastResolveResult.groups.length }) }}</span>
              <code v-for="g in lastResolveResult.groups" :key="g" class="group-chip">{{ g }}</code>
              <span v-if="!lastResolveResult.groups.length" class="muted">{{ t('none') }}</span>
            </div>
            <div>
              <span class="k-inline">{{ t('Resolved roles:') }}</span>
              <span v-if="lastResolveResult.roles.length">
                <span
                  v-for="r in lastResolveResult.roles"
                  :key="r"
                  class="pill"
                  :class="
                    r === 'admin'
                      ? 'pill-err'
                      : r === 'operator'
                        ? 'pill-warn'
                        : r === 'maintainer'
                          ? 'pill-cyan'
                          : 'pill-info'
                  "
                >
                  {{ r }}
                </span>
              </span>
              <span v-else class="err">
                {{ t('NONE — this user would be rejected at login (no matching mapping)') }}
              </span>
            </div>
          </template>
        </div>
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
.crumbs {
  font-size: var(--sw-fs-base);
  color: var(--sw-fg-2);
}
.crumbs .sep { margin: 0 6px; color: var(--sw-fg-3); }
.crumb-cur { color: var(--sw-fg-0); font-weight: var(--sw-fw-semibold); }
.head-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

.loading,
.error {
  padding: 20px;
  text-align: center;
  color: var(--sw-fg-2);
}
.error { color: var(--sw-err); }

.head-card {
  display: flex;
  align-items: center;
  padding: 14px 18px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  margin-bottom: 14px;
  gap: 16px;
}
.head-left { display: flex; align-items: center; gap: 12px; }
.status-glyph {
  width: 40px; height: 40px;
  border-radius: 8px;
  display: grid; place-items: center;
  font-weight: var(--sw-fw-bold); font-size: var(--sw-fs-2xl);
}
.status-glyph.ok { background: rgba(34,197,94,0.16); color: var(--sw-ok); }
.status-glyph.err { background: rgba(239,68,68,0.16); color: var(--sw-err); }
.status-title { font-size: 16px; font-weight: var(--sw-fw-bold); color: var(--sw-fg-0); }
.status-sub { font-size: var(--sw-fs-sm); color: var(--sw-fg-2); margin-top: 2px; }
.status-sub .emph { color: var(--sw-fg-1); }
.status-sub .pos { color: var(--sw-ok); }
.status-sub .neg { color: var(--sw-err); }

.head-kpis {
  margin-left: auto;
  display: flex;
  gap: 22px;
}
.kpi { text-align: right; }
.kpi-label {
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
}
.kpi-value { font-size: 16px; font-weight: var(--sw-fw-semibold); color: var(--sw-fg-0); margin-top: 2px; }
.kpi-value.info { color: var(--sw-info); }

.hint {
  padding: 10px 14px;
  border-radius: 6px;
  margin-bottom: 14px;
  font-size: var(--sw-fs-sm);
  display: flex;
  gap: 10px;
  align-items: start;
}
.hint code { font-family: var(--sw-mono); color: var(--sw-fg-0); }
.hint-warn {
  background: rgba(234,179,8,0.08);
  border: 1px solid rgba(234,179,8,0.3);
  color: var(--sw-fg-1);
}
.hint-warn .hint-icon { color: var(--sw-warn); font-weight: var(--sw-fw-bold); }

.grid-2col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-bottom: 14px;
}

.sw-card {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 14px;
}
.card-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-2);
}
.card-head h3 { margin: 0; font-size: var(--sw-fs-base); font-weight: var(--sw-fw-semibold); color: var(--sw-fg-0); }
.muted { color: var(--sw-fg-3); font-size: var(--sw-fs-sm); }
.muted.small { font-size: var(--sw-fs-xs); }
.mono { font-family: var(--sw-mono); }

table { width: 100%; border-collapse: collapse; }
.kv .k {
  width: 32%;
  padding: 8px 14px;
  color: var(--sw-fg-2);
  font-size: var(--sw-fs-sm);
  vertical-align: top;
  border-bottom: 1px solid var(--sw-line);
}
.kv .v {
  padding: 8px 14px;
  color: var(--sw-fg-0);
  font-size: var(--sw-fs-base);
  border-bottom: 1px solid var(--sw-line);
}
.kv tr:last-child .k, .kv tr:last-child .v { border-bottom: none; }
.kv code, .data-table code { font-family: var(--sw-mono); font-size: var(--sw-fs-sm); color: var(--sw-fg-0); }
.v.err { color: var(--sw-err); }

.data-table th {
  text-align: left;
  padding: 8px 14px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-3);
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  border-bottom: 1px solid var(--sw-line);
}
.data-table td {
  padding: 8px 14px;
  border-bottom: 1px solid var(--sw-line);
  font-size: var(--sw-fs-base);
  color: var(--sw-fg-1);
}
.data-table tr:last-child td { border-bottom: none; }

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

.resolver-row {
  display: flex;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--sw-line);
}
.resolver-row input {
  flex: 1;
  height: 32px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  color: var(--sw-fg-0);
  padding: 0 10px;
  font: inherit;
  font-size: var(--sw-fs-base);
  outline: none;
}
.resolver-row input:focus { border-color: var(--sw-accent-line); }
.resolver-result {
  padding: 12px 14px;
  font-size: var(--sw-fs-base);
  display: flex;
  flex-direction: column;
  gap: 8px;
  color: var(--sw-fg-1);
}
.k-inline {
  display: inline-block;
  width: 130px;
  color: var(--sw-fg-2);
  font-size: var(--sw-fs-sm);
}
.group-chip {
  display: inline-block;
  margin: 2px 6px 2px 0;
  padding: 1px 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  font-size: var(--sw-fs-xs);
}
.err { color: var(--sw-err); }
</style>
