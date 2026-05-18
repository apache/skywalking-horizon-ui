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
import { computed, onMounted, ref } from 'vue';
import { bff } from '@/api/client';
import type { AuthStatus } from '@/api/scopes/admin-auth';

/**
 * Read-only permissions board. Mirrors the role policy in plain-English
 * terms — admins see "what each role can do" without having to read the
 * server config. To change the policy, an administrator edits the
 * config file and the BFF hot-reloads.
 */

const status = ref<AuthStatus | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

async function load(): Promise<void> {
  try {
    status.value = await bff.adminAuth.status();
    error.value = null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

/** Matcher mirroring the server's verb resolution. */
function hasVerb(grants: readonly string[], required: string): boolean {
  for (const g of grants) {
    if (g === '*' || g === 'admin') return true;
    if (g === required) return true;
    const gp = g.split(':', 3);
    const rp = required.split(':', 3);
    if (gp[0] === rp[0] && gp[1] === '*') return true;
    if (gp[0] === '*' && gp[1] === rp[1] && (gp[2] ?? '') === (rp[2] ?? '')) return true;
    if (gp[0] === rp[0] && gp[1] === rp[1] && (gp[2] ?? '') === (rp[2] ?? '')) return true;
  }
  return false;
}

const roleNames = computed(() => Object.keys(status.value?.rbac.roles ?? {}).sort(rolePriority));

function rolePriority(a: string, b: string): number {
  const order = ['viewer', 'maintainer', 'operator', 'admin'];
  const ia = order.indexOf(a);
  const ib = order.indexOf(b);
  if (ia === -1 && ib === -1) return a.localeCompare(b);
  if (ia === -1) return 1;
  if (ib === -1) return -1;
  return ia - ib;
}
function rolePill(role: string): string {
  if (role === 'admin') return 'pill-err';
  if (role === 'operator') return 'pill-warn';
  if (role === 'maintainer') return 'pill-cyan';
  return 'pill-info';
}
/** Short, jargon-light description of what a role is for. */
function roleBlurb(role: string): string {
  if (role === 'admin') return 'Full access including user & access management.';
  if (role === 'operator') return 'Configures alerts, dashboards, rules, and runs diagnostics.';
  if (role === 'maintainer') return 'Watches the SkyWalking platform itself (cluster, internals).';
  if (role === 'viewer') return 'Reads dashboards, traces, logs, and alarms.';
  return '';
}

/** User-facing label for each verb. We keep the verb identifier off the
 *  page entirely — admins read these as plain capabilities. */
const VERB_LABELS: Record<string, { label: string; hint?: string }> = {
  'metrics:read':           { label: 'See metric dashboards' },
  'alarms:read':            { label: 'See alarms' },
  'traces:read':            { label: 'See traces' },
  'logs:read':              { label: 'See logs' },
  'topology:read':          { label: 'See service & endpoint topology' },
  'profile:read':           { label: 'See profiling results' },
  'cluster:read':           { label: 'See OAP cluster status' },
  'inspect:read':           { label: 'Inspect OAP internals (catalog, MQE)' },
  'overview:read':          { label: 'See overview templates' },
  'overview:write':         { label: 'Edit overview templates' },
  'dashboard:read':         { label: 'See layer dashboard templates' },
  'dashboard:write':        { label: 'Edit layer dashboard templates' },
  'setup:read':             { label: 'See per-layer setup' },
  'setup:write':            { label: 'Edit per-layer setup' },
  'alarm-rule:read':        { label: 'See alarm rules' },
  'alarm-rule:write':       { label: 'Edit alarm rules' },
  'alarm-setup:read':       { label: 'See alarm-page setup' },
  'alarm-setup:write':      { label: 'Edit alarm-page setup' },
  'rule:read':              { label: 'See DSL / OAL / MQE rules' },
  'rule:write':             { label: 'Edit existing rules' },
  'rule:write:structural':  { label: 'Change rule schema (OAL files)', hint: 'schema-breaking edits' },
  'rule:delete':            { label: 'Delete rules' },
  'rule:debug':             { label: 'Test queries in the MQE sandbox' },
  'live-debug:read':        { label: 'See live-debug sessions' },
  'live-debug:write':       { label: 'Start and stop live-debug sessions' },
  'profile:enable':         { label: 'Start a profiling task on a target' },
  'user:read':              { label: 'See the user list' },
  'user:write':             { label: 'Add / remove local users' },
  'role:read':              { label: 'See this page' },
  'role:write':             { label: 'Change role grants' },
  'auth:read':              { label: 'See the auth-status page' },
  'audit:read':             { label: 'Read the audit log' },
  'admin':                  { label: 'Everything (escape hatch)' },
};
function labelFor(verb: string): { label: string; hint?: string } {
  return VERB_LABELS[verb] ?? { label: verb };
}

/** Groups verbs by feature area + supplies a scope mock-sidebar so the
 *  reader can see WHICH menu items the group governs. */
interface ScopeItem {
  label: string;
  icon?: string;
}
interface VerbGroup {
  title: string;
  blurb: string;
  scope: ScopeItem[];
  verbs: string[];
}
const VERB_GROUPS: VerbGroup[] = [
  {
    title: 'Data catalog',
    blurb: 'Read-only data screens. Everyone signed in sees these by default — they are the core observability surface.',
    scope: [
      { label: 'Glance', icon: '◧' },
      { label: 'Service dashboards', icon: '▥' },
      { label: 'Traces', icon: '↗' },
      { label: 'Logs', icon: '≡' },
      { label: 'Topology', icon: '◌' },
      { label: 'Profiling results', icon: '▦' },
      { label: 'Alarms', icon: '!' },
    ],
    verbs: ['metrics:read', 'alarms:read', 'traces:read', 'logs:read', 'topology:read', 'profile:read'],
  },
  {
    title: 'Platform monitoring',
    blurb: 'Watching SkyWalking itself: is the OAP cluster healthy, are modules loaded, what does the internal metric catalog look like.',
    scope: [
      { label: 'OAP cluster status', icon: '⌬' },
      { label: 'Module inspector', icon: '⌕' },
    ],
    verbs: ['cluster:read', 'inspect:read'],
  },
  {
    title: 'Overview templates',
    blurb: 'The per-layer landing pages users see when they pick a layer in the sidebar.',
    scope: [
      { label: 'Overview templates editor', icon: '◧' },
    ],
    verbs: ['overview:read', 'overview:write'],
  },
  {
    title: 'Layer dashboards',
    blurb: 'The dashboards and per-layer setup (slot labels, available features, term aliases) operators tune for their org.',
    scope: [
      { label: 'Layer dashboard editor', icon: '▥' },
      { label: 'Per-layer setup', icon: '⚙' },
    ],
    verbs: ['dashboard:read', 'dashboard:write', 'setup:read', 'setup:write'],
  },
  {
    title: 'Alarms',
    blurb: 'The firing rules behind the Alarms screen plus the alarm-page setup (which layers contribute to the alarm overview).',
    scope: [
      { label: 'Alarm rules', icon: '!' },
      { label: 'Alarm page setup', icon: '⚙' },
    ],
    verbs: ['alarm-rule:read', 'alarm-rule:write', 'alarm-setup:read', 'alarm-setup:write'],
  },
  {
    title: 'DSL management',
    blurb: 'The MQE, OAL and runtime-rule editing surface. Schema-breaking edits and deletes are split out so a junior operator can author rules without being able to break things irreversibly.',
    scope: [
      { label: 'Rule catalog', icon: '⌗' },
      { label: 'Rule editor', icon: '✎' },
      { label: 'OAL files', icon: '⌗' },
    ],
    verbs: ['rule:read', 'rule:write', 'rule:write:structural', 'rule:delete'],
  },
  {
    title: 'Diagnostics & debug',
    blurb: 'Interactive troubleshooting: the live debugger that streams events from a running rule, and the MQE sandbox for testing queries without saving anything.',
    scope: [
      { label: 'Live debugger', icon: '◉' },
      { label: 'MQE sandbox', icon: '▶' },
    ],
    verbs: ['rule:debug', 'live-debug:read', 'live-debug:write'],
  },
  {
    title: 'Profiling',
    blurb: 'Starting a profiling task — agent-side sampling, async-profiler, pprof, or eBPF. Reading the results is part of "Data catalog" above.',
    scope: [
      { label: 'Start a profiling task', icon: '▦' },
    ],
    verbs: ['profile:enable'],
  },
  {
    title: 'Users & access admin',
    blurb: 'The administrator surface: who can sign in, what role they have, and the live status of the auth backend.',
    scope: [
      { label: 'Users', icon: '◉' },
      { label: 'Roles & permissions', icon: '⚙' },
      { label: 'Auth status', icon: '⌬' },
    ],
    verbs: ['user:read', 'user:write', 'role:read', 'role:write', 'auth:read'],
  },
  {
    title: 'Audit',
    blurb: 'The auditable record of every sign-in, rule change, and configuration edit. Written to a file the operator can ship to an SIEM; no in-app viewer yet.',
    scope: [
      { label: 'Audit log (file)', icon: '≡' },
    ],
    verbs: ['audit:read'],
  },
  {
    title: 'Everything (escape hatch)',
    blurb: 'A sentinel granted only to the administrator role. Implies every other permission.',
    scope: [
      { label: 'All of the above', icon: '✦' },
    ],
    verbs: ['admin'],
  },
];

const groupedVerbs = computed<Array<VerbGroup & { items: string[] }>>(() => {
  const known = new Set(status.value?.rbac.knownVerbs ?? []);
  const seen = new Set<string>();
  const out: Array<VerbGroup & { items: string[] }> = [];
  for (const g of VERB_GROUPS) {
    const items = g.verbs.filter((v) => known.has(v));
    items.forEach((v) => seen.add(v));
    if (items.length) out.push({ ...g, items });
  }
  // Any verbs not categorised above land here so they aren't silently
  // dropped from the page — that's a signal to add them to a group.
  const leftover = [...known].filter((v) => !seen.has(v));
  if (leftover.length) {
    out.push({
      title: 'Other',
      blurb: 'Capabilities that have not been described yet.',
      scope: [],
      verbs: leftover,
      items: leftover,
    });
  }
  return out;
});

function grantsOf(role: string): string[] {
  return status.value?.rbac.roles[role] ?? [];
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div class="crumbs">
        <span>Admin</span><span class="sep">/</span><span class="crumb-cur">Roles &amp; permissions</span>
      </div>
      <div class="head-actions">
        <button class="sw-btn" type="button" @click="load">Refresh</button>
      </div>
    </header>

    <div v-if="loading" class="loading">Loading roles…</div>
    <div v-else-if="error" class="error">Failed to load: {{ error }}</div>
    <template v-else-if="status">
      <!-- Intro -->
      <section class="sw-card intro">
        <h2 class="intro-title">What each role can do</h2>
        <p class="intro-body">
          Your sidebar adapts to your role: anything you can't use is simply not shown. The
          sections below group SkyWalking's capabilities by feature area. For each area you'll
          see <b>Menu scope</b> (which sidebar entries fall in the area) and
          <b>Actions</b> (the concrete things you can do, marked per role). Multiple roles add up
          — a user holding more than one role gets every permission any of their roles grant.
        </p>
        <div class="role-summary">
          <div v-for="r in roleNames" :key="r" class="role-card">
            <span class="pill" :class="rolePill(r)">{{ r }}</span>
            <p class="role-blurb">{{ roleBlurb(r) }}</p>
          </div>
        </div>
      </section>

      <!-- Per-group cards: Menu scope (left) + Actions (right) -->
      <section v-for="g in groupedVerbs" :key="g.title" class="sw-card group-card">
        <header class="card-head">
          <h3>{{ g.title }}</h3>
          <span class="muted">{{ g.blurb }}</span>
        </header>
        <div class="group-body">
          <!-- Left: mock menu bar showing what this area covers -->
          <aside class="scope" aria-label="Menu scope">
            <div class="col-head">
              <span class="col-num">1</span>
              <span class="col-title">Menu scope</span>
              <span class="col-sub">items in this area</span>
            </div>
            <ul class="scope-list">
              <li v-for="item in g.scope" :key="item.label">
                <span class="scope-icon" aria-hidden="true">{{ item.icon ?? '·' }}</span>
                <span>{{ item.label }}</span>
              </li>
              <li v-if="!g.scope.length" class="scope-empty">—</li>
            </ul>
          </aside>

          <!-- Connector arrow makes the relationship visible -->
          <div class="connector" aria-hidden="true">→</div>

          <!-- Right: per-role permission grid for the actions in this area -->
          <div class="grid-wrap">
            <div class="col-head">
              <span class="col-num">2</span>
              <span class="col-title">Actions</span>
              <span class="col-sub">checked roles can perform each row</span>
            </div>
            <table class="perm">
              <colgroup>
                <col class="col-cap" />
                <col v-for="r in roleNames" :key="r" class="col-role" />
              </colgroup>
              <thead>
                <tr>
                  <th class="th-cap">What you can do</th>
                  <th v-for="r in roleNames" :key="r" class="th-role">
                    <span class="pill" :class="rolePill(r)">{{ r }}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="v in g.items" :key="v">
                  <td class="td-cap">
                    <div class="cap-label">{{ labelFor(v).label }}</div>
                    <div v-if="labelFor(v).hint" class="cap-hint">{{ labelFor(v).hint }}</div>
                  </td>
                  <td v-for="r in roleNames" :key="r" class="td-cell">
                    <span v-if="hasVerb(grantsOf(r), v)" class="check check-on" aria-label="allowed">✓</span>
                    <span v-else class="check check-off" aria-label="not allowed">·</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

    </template>
  </div>
</template>

<style scoped>
.page { padding: 18px 22px 32px; color: var(--sw-fg-0); }
.page-head { display: flex; align-items: center; margin-bottom: 16px; }
.crumbs { font-size: 12px; color: var(--sw-fg-2); }
.crumbs .sep { margin: 0 6px; color: var(--sw-fg-3); }
.crumb-cur { color: var(--sw-fg-0); font-weight: 600; }
.head-actions { margin-left: auto; display: flex; gap: 8px; }

.loading, .error { padding: 20px; text-align: center; color: var(--sw-fg-2); }
.error { color: var(--sw-err); }

.sw-card {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  margin-bottom: 14px;
  overflow: hidden;
}
.card-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-2);
}
.card-head h3 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--sw-fg-0);
}

/* ── Intro ───────────────────────────────────────────────────────── */
.intro { padding: 14px 18px; }
.intro-title { margin: 0; font-size: 14px; color: var(--sw-fg-0); font-weight: 600; }
.intro-body {
  margin: 8px 0 14px;
  color: var(--sw-fg-2);
  font-size: 12px;
  line-height: 1.55;
  max-width: 920px;
}
.role-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}
.role-card {
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  padding: 10px 12px;
}
.role-blurb {
  margin: 6px 0 0;
  font-size: 11.5px;
  color: var(--sw-fg-2);
  line-height: 1.45;
}

/* ── Group card ──────────────────────────────────────────────────── */
.muted { color: var(--sw-fg-3); font-size: 11px; font-weight: 400; }
.card-head h3 + .muted { margin-left: 6px; }

.group-body {
  display: grid;
  grid-template-columns: minmax(200px, 240px) 28px 1fr;
  gap: 0;
  align-items: stretch;
}
.scope {
  padding: 14px;
  border-right: 1px solid var(--sw-line);
  background: var(--sw-bg-2);
}

.col-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 10px;
}
.col-num {
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
  font-size: 11px;
  font-weight: 700;
  flex: 0 0 18px;
}
.col-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-0);
}
.col-sub {
  font-size: 10.5px;
  color: var(--sw-fg-3);
}

.scope-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.scope-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 4px;
  font-size: 11.5px;
  color: var(--sw-fg-1);
  font-weight: 500;
}
.scope-list li + li { margin-top: 1px; }
.scope-list li:hover { background: var(--sw-bg-3, rgba(255,255,255,0.03)); }
.scope-icon {
  display: inline-block;
  width: 14px;
  text-align: center;
  color: var(--sw-fg-3);
  font-size: 12px;
}
.scope-empty {
  color: var(--sw-fg-3);
  font-style: italic;
  padding-left: 8px;
}

.connector {
  display: grid;
  place-items: center;
  color: var(--sw-fg-3);
  font-size: 18px;
  background: var(--sw-bg-2);
  border-right: 1px solid var(--sw-line);
}

.grid-wrap {
  overflow-x: auto;
  padding: 14px 14px 0;
}
.perm {
  width: 100%;
  /* Fixed layout + explicit column widths makes every card render the
     same column geometry, so the role columns line up vertically when
     scanning across cards. */
  table-layout: fixed;
  border-collapse: collapse;
}
.perm col.col-cap   { width: auto; }
.perm col.col-role  { width: 84px; }

.perm th.th-cap {
  text-align: left;
  padding: 10px 14px;
  color: var(--sw-fg-2);
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 600;
  border-bottom: 1px solid var(--sw-line);
}
.perm th.th-role {
  padding: 10px 12px;
  text-align: center;
  border-bottom: 1px solid var(--sw-line);
  font-weight: 600;
  width: 84px;
}
.perm td {
  border-bottom: 1px solid var(--sw-line);
  font-size: 12px;
  color: var(--sw-fg-1);
}
.perm tr:last-child td { border-bottom: none; }
.perm tbody tr:hover { background: rgba(255,255,255,0.02); }
.td-cap { padding: 8px 14px; vertical-align: top; }
.cap-label { color: var(--sw-fg-0); font-weight: 500; }
.cap-hint { color: var(--sw-fg-3); font-size: 10.5px; margin-top: 2px; }
.td-cell { text-align: center; padding: 8px 12px; }
.check {
  display: inline-block;
  width: 18px;
  height: 18px;
  line-height: 18px;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 700;
}
.check-on {
  background: rgba(34, 197, 94, 0.16);
  color: var(--sw-ok);
}
.check-off {
  color: var(--sw-fg-3);
  background: transparent;
  font-weight: 400;
  font-size: 14px;
}

/* ── Pills ───────────────────────────────────────────────────────── */
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

/* ── Rules card ──────────────────────────────────────────────────── */
.rules-card { padding: 0; }
.rules-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
  padding: 14px;
}
.rule {
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  padding: 10px 12px;
}
.rule-k { font-size: 11.5px; font-weight: 600; color: var(--sw-fg-0); }
.rule-v { font-size: 11.5px; color: var(--sw-fg-2); margin-top: 4px; line-height: 1.55; }
</style>
