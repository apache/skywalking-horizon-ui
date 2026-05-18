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
import { bff } from '@/api/client';
import type { AuthStatus } from '@/api/scopes/admin-auth';

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
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  return `${Math.round(diff / 3600)}h ago`;
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div class="crumbs">
        <span>Admin</span><span class="sep">/</span><span class="crumb-cur">Auth status</span>
      </div>
      <div class="head-actions">
        <button class="sw-btn" type="button" @click="load">Refresh</button>
        <button
          v-if="status?.backend === 'ldap'"
          class="sw-btn is-primary"
          type="button"
          :disabled="probing"
          @click="probeNow"
        >
          {{ probing ? 'Probing…' : 'Probe now' }}
        </button>
      </div>
    </header>

    <div v-if="loading" class="loading">Loading auth status…</div>
    <div v-else-if="probeError" class="error">Failed to load: {{ probeError }}</div>
    <template v-else-if="status">
      <!-- Headline -->
      <div class="head-card">
        <div class="head-left">
          <div class="status-glyph" :class="{ ok: healthy, err: !healthy }">
            {{ healthy ? '✓' : '!' }}
          </div>
          <div>
            <div class="status-title">
              {{ healthy ? 'Auth healthy' : 'Auth degraded' }}
            </div>
            <div class="status-sub">
              {{ status.backend === 'ldap' ? 'LDAP backend' : 'Local users backend' }}
              <template v-if="status.backend === 'ldap' && status.ldap">
                · {{ status.ldap.host }}
                ·
                <span :class="status.ldap.probe.reachable ? 'pos' : 'neg'">
                  {{ status.ldap.probe.reachable ? 'reachable' : 'unreachable' }}
                </span>
              </template>
              <template v-else> · {{ status.local.users }} user(s) defined </template>
              · break-glass
              <b class="emph">{{ status.breakGlass.armed ? 'armed' : status.breakGlass.configured ? 'configured (disarmed)' : 'disabled' }}</b>
            </div>
          </div>
        </div>
        <div class="head-kpis">
          <div class="kpi">
            <div class="kpi-label">Backend</div>
            <div class="kpi-value info">{{ status.backend }}</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">Sessions</div>
            <div class="kpi-value">{{ status.sessions.active }}</div>
          </div>
          <div v-if="status.ldap" class="kpi">
            <div class="kpi-label">LDAP latency</div>
            <div class="kpi-value">
              {{ status.ldap.probe.latencyMs !== null ? status.ldap.probe.latencyMs + 'ms' : '—' }}
            </div>
          </div>
          <div class="kpi">
            <div class="kpi-label">Group mappings</div>
            <div class="kpi-value">{{ status.ldap?.groupMappings.length ?? '—' }}</div>
          </div>
        </div>
      </div>

      <div v-if="status.bothPresent" class="hint hint-warn">
        <span class="hint-icon">⚠</span>
        <span>
          <b>Both backends present.</b>
          <code>auth.local.users</code> is populated but the active backend is LDAP — local users are
          ignored except as a break-glass source.
        </span>
      </div>

      <div class="grid-2col">
        <!-- Backend identity -->
        <section class="sw-card">
          <header class="card-head">
            <h3>Backend</h3>
            <span class="muted">GET /api/admin/auth-status</span>
          </header>
          <table class="kv">
            <tbody>
              <tr>
                <td class="k">Provider</td>
                <td class="v">
                  <span class="pill" :class="status.backend === 'ldap' ? 'pill-info' : 'pill-muted'">
                    {{ status.backend.toUpperCase() }}
                  </span>
                  <span v-if="status.bothPresent" class="muted small">
                    (local fallback armed)
                  </span>
                </td>
              </tr>
              <tr>
                <td class="k">Mode</td>
                <td class="v">
                  {{ status.backend === 'ldap' ? 'bind + search' : 'argon2id hash compare' }}
                </td>
              </tr>
              <tr>
                <td class="k">Config file</td>
                <td class="v">
                  <code>{{ status.configPath }}</code>
                  <div class="muted small mono">
                    mtime {{ fmtMtime(status.configMtime) }} · {{ fmtBytes(status.configSizeBytes) }}
                  </div>
                </td>
              </tr>
              <tr>
                <td class="k">Active sessions</td>
                <td class="v">{{ status.sessions.active }}</td>
              </tr>
              <tr>
                <td class="k">Break-glass</td>
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
                    {{ status.breakGlass.armed ? 'ARMED' : status.breakGlass.configured ? 'CONFIGURED' : 'DISABLED' }}
                  </span>
                  <div v-if="status.breakGlass.username" class="muted small">
                    username <code>{{ status.breakGlass.username }}</code>
                  </div>
                  <div v-else class="muted small">
                    add <code>auth.breakGlass</code> in horizon.yaml to arm
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <!-- Local users -->
        <section class="sw-card">
          <header class="card-head">
            <h3>Local users</h3>
            <span class="muted">
              {{ status.backend === 'local' ? 'primary backend' : 'break-glass fallback' }}
            </span>
          </header>
          <table class="kv">
            <tbody>
              <tr>
                <td class="k">Users defined</td>
                <td class="v">{{ status.local.users }}</td>
              </tr>
              <tr>
                <td class="k">Hash algo</td>
                <td class="v">argon2id</td>
              </tr>
              <tr>
                <td class="k">Source</td>
                <td class="v">
                  <code>{{ status.configPath }}</code>
                  <div class="muted small">
                    section <code>auth.local.users</code>
                  </div>
                </td>
              </tr>
              <tr>
                <td class="k">Role</td>
                <td class="v">
                  <span class="pill" :class="status.local.role === 'primary' ? 'pill-info' : 'pill-warn'">
                    {{ status.local.role === 'primary' ? 'PRIMARY' : 'BREAK-GLASS ONLY' }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>

      <!-- LDAP details -->
      <section v-if="status.ldap" class="sw-card">
        <header class="card-head">
          <h3>LDAP probe</h3>
          <span class="muted">last probe {{ fmtAgo(status.ldap.probe.at) }}</span>
        </header>
        <table class="kv">
          <tbody>
            <tr>
              <td class="k">URL</td>
              <td class="v"><code>{{ status.ldap.url }}</code></td>
            </tr>
            <tr>
              <td class="k">Service bind DN</td>
              <td class="v">
                <code v-if="status.ldap.bindDn">{{ status.ldap.bindDn }}</code>
                <span v-else class="muted">anonymous bind</span>
              </td>
            </tr>
            <tr>
              <td class="k">User base DN</td>
              <td class="v"><code>{{ status.ldap.userBaseDn }}</code></td>
            </tr>
            <tr>
              <td class="k">Group strategy</td>
              <td class="v"><code>{{ status.ldap.groupStrategy }}</code></td>
            </tr>
            <tr>
              <td class="k">Reachable</td>
              <td class="v">
                <span class="pill" :class="status.ldap.probe.reachable ? 'pill-ok' : 'pill-err'">
                  {{ status.ldap.probe.reachable ? 'YES' : 'NO' }}
                </span>
              </td>
            </tr>
            <tr v-if="status.ldap.probe.serviceBindOk !== null">
              <td class="k">Service bind</td>
              <td class="v">
                <span class="pill" :class="status.ldap.probe.serviceBindOk ? 'pill-ok' : 'pill-err'">
                  {{ status.ldap.probe.serviceBindOk ? 'OK' : 'FAIL' }}
                </span>
              </td>
            </tr>
            <tr v-if="status.ldap.probe.userSearchOk !== null">
              <td class="k">User search</td>
              <td class="v">
                <span class="pill" :class="status.ldap.probe.userSearchOk ? 'pill-ok' : 'pill-err'">
                  {{ status.ldap.probe.userSearchOk ? 'OK' : 'FAIL' }}
                </span>
                <span v-if="status.ldap.probe.userEntriesVisible !== null" class="muted small">
                  · {{ status.ldap.probe.userEntriesVisible }} entries visible
                </span>
              </td>
            </tr>
            <tr v-if="status.ldap.probe.latencyMs !== null">
              <td class="k">Latency</td>
              <td class="v"><code>{{ status.ldap.probe.latencyMs }}ms</code></td>
            </tr>
            <tr v-if="status.ldap.probe.error">
              <td class="k">Error</td>
              <td class="v err">{{ status.ldap.probe.error }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- Group -> role mapping -->
      <section v-if="status.ldap && status.ldap.groupMappings.length" class="sw-card">
        <header class="card-head">
          <h3>Group → role mapping</h3>
          <span class="muted">first match wins · "*" matches every authenticated user</span>
        </header>
        <table class="data-table">
          <thead>
            <tr>
              <th>LDAP group DN</th>
              <th>Role</th>
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

      <!-- Resolver -->
      <section v-if="status.ldap" class="sw-card">
        <header class="card-head">
          <h3>Test a username</h3>
          <span class="muted">resolves group memberships without authenticating</span>
        </header>
        <div class="resolver-row">
          <input
            v-model="testUsername"
            type="text"
            placeholder="username"
            @keydown.enter="probeNow"
          />
          <button class="sw-btn" type="button" :disabled="probing" @click="probeNow">
            Resolve
          </button>
        </div>
        <div v-if="lastResolveResult" class="resolver-result">
          <template v-if="lastResolveResult.error">
            <span class="err">Error: {{ lastResolveResult.error }}</span>
          </template>
          <template v-else-if="!lastResolveResult.found">
            <span class="muted">No user entry found for <code>{{ lastResolveResult.username }}</code></span>
          </template>
          <template v-else>
            <div>
              <span class="k-inline">DN:</span>
              <code>{{ lastResolveResult.dn }}</code>
            </div>
            <div>
              <span class="k-inline">Groups ({{ lastResolveResult.groups.length }}):</span>
              <code v-for="g in lastResolveResult.groups" :key="g" class="group-chip">{{ g }}</code>
              <span v-if="!lastResolveResult.groups.length" class="muted">none</span>
            </div>
            <div>
              <span class="k-inline">Resolved roles:</span>
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
                NONE — this user would be rejected at login (no matching mapping)
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
  font-size: 12px;
  color: var(--sw-fg-2);
}
.crumbs .sep { margin: 0 6px; color: var(--sw-fg-3); }
.crumb-cur { color: var(--sw-fg-0); font-weight: 600; }
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
  font-weight: 700; font-size: 20px;
}
.status-glyph.ok { background: rgba(34,197,94,0.16); color: var(--sw-ok); }
.status-glyph.err { background: rgba(239,68,68,0.16); color: var(--sw-err); }
.status-title { font-size: 16px; font-weight: 700; color: var(--sw-fg-0); }
.status-sub { font-size: 11.5px; color: var(--sw-fg-2); margin-top: 2px; }
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
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
}
.kpi-value { font-size: 16px; font-weight: 600; color: var(--sw-fg-0); margin-top: 2px; }
.kpi-value.info { color: var(--sw-info); }

.hint {
  padding: 10px 14px;
  border-radius: 6px;
  margin-bottom: 14px;
  font-size: 11.5px;
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
.hint-warn .hint-icon { color: var(--sw-warn); font-weight: 700; }

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
.card-head h3 { margin: 0; font-size: 12px; font-weight: 600; color: var(--sw-fg-0); }
.muted { color: var(--sw-fg-3); font-size: 11px; }
.muted.small { font-size: 10.5px; }
.mono { font-family: var(--sw-mono); }

table { width: 100%; border-collapse: collapse; }
.kv .k {
  width: 32%;
  padding: 8px 14px;
  color: var(--sw-fg-2);
  font-size: 11.5px;
  vertical-align: top;
  border-bottom: 1px solid var(--sw-line);
}
.kv .v {
  padding: 8px 14px;
  color: var(--sw-fg-0);
  font-size: 12px;
  border-bottom: 1px solid var(--sw-line);
}
.kv tr:last-child .k, .kv tr:last-child .v { border-bottom: none; }
.kv code, .data-table code { font-family: var(--sw-mono); font-size: 11px; color: var(--sw-fg-0); }
.v.err { color: var(--sw-err); }

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
  font-size: 12px;
  outline: none;
}
.resolver-row input:focus { border-color: var(--sw-accent-line); }
.resolver-result {
  padding: 12px 14px;
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  color: var(--sw-fg-1);
}
.k-inline {
  display: inline-block;
  width: 130px;
  color: var(--sw-fg-2);
  font-size: 11px;
}
.group-chip {
  display: inline-block;
  margin: 2px 6px 2px 0;
  padding: 1px 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  font-size: 10.5px;
}
.err { color: var(--sw-err); }
</style>
