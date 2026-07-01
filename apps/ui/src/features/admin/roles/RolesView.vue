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
import { useI18n } from 'vue-i18n';
import { bff } from '@/api/client';
import type { AuthStatus } from '@/api/scopes/admin-auth';

/**
 * Read-only permissions board. Mirrors the role policy in plain-English
 * terms — admins see "what each role can do" without having to read the
 * server config. To change the policy, an administrator edits the
 * config file and the BFF hot-reloads.
 */

const { t } = useI18n({ useScope: 'global' });

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

/** Grants for a role from the live policy. */
function grantsFor(role: string): readonly string[] {
  return status.value?.rbac.roles?.[role] ?? [];
}
/** Sidebar menu → the read verb that gates its visibility (mirrors
 *  AppSidebar.vue). Drives the visibility matrix so operators can read,
 *  per role, exactly which navigation items appear. `null` verb = shown
 *  to any signed-in user (the core data layers, cap-gated only). */
const MENU_GATES = computed<ReadonlyArray<{ label: string; verb: string | null }>>(() => [
  { label: t('Layers (per-layer data)'), verb: null },
  { label: t('Alarms'), verb: 'alarms:read' },
  { label: t('Overviews'), verb: 'overview:read' },
  { label: t('3D infrastructure map'), verb: 'infra-3d:read' },
  { label: t('Cluster status'), verb: 'cluster:read' },
  { label: t('Platform monitoring (layers)'), verb: 'cluster:read' },
  { label: t('Metrics inspect'), verb: 'inspect:read' },
  { label: t('Data retention'), verb: 'ttl:read' },
  { label: t('OAP configuration'), verb: 'config:read' },
  { label: t('Alerting rules'), verb: 'alarm-rule:read' },
  { label: t('Live debugger · Capture history'), verb: 'live-debug:read' },
  { label: t('DSL management'), verb: 'rule:read' },
  { label: t('Overview templates'), verb: 'overview:write' },
  { label: t('Layer dashboards'), verb: 'dashboard:read' },
  { label: t('Alert page'), verb: 'alarm-setup:read' },
  { label: t('Global defaults'), verb: 'setup:read' },
  { label: t('Users'), verb: 'user:read' },
  { label: t('Auth status'), verb: 'auth:read' },
  { label: t('Roles & permissions'), verb: 'role:read' },
]);
/** Is the menu row visible to the role? `null` verb ⇒ any signed-in user. */
function menuVisible(role: string, verb: string | null): boolean {
  return verb === null ? true : hasVerb(grantsFor(role), verb);
}

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
  if (role === 'admin') return t('Full access including user & access management.');
  if (role === 'operator') return t('Configures alerts, dashboards, rules, and runs diagnostics.');
  if (role === 'maintainer') return t('Watches the SkyWalking platform itself (cluster, internals).');
  if (role === 'viewer') return t('Reads dashboards, traces, logs, alarms, and events.');
  return '';
}

/** User-facing label for each verb. We keep the verb identifier off the
 *  page entirely — admins read these as plain capabilities. */
const VERB_LABELS = computed<Record<string, { label: string; hint?: string }>>(() => ({
  'metrics:read':           { label: t('See metric dashboards') },
  'alarms:read':            { label: t('See alarms') },
  'events:read':            { label: t('See service events') },
  'traces:read':            { label: t('See traces') },
  'logs:read':              { label: t('See logs') },
  'topology:read':          { label: t('See service & endpoint topology') },
  'profile:read':           { label: t('See profiling results') },
  'infra-3d:read':          { label: t('See the 3D infrastructure map') },
  'cluster:read':           { label: t('See OAP cluster status') },
  'inspect:read':           { label: t('Inspect OAP internals (catalog, MQE)') },
  'overview:read':          { label: t('See overview templates') },
  'overview:write':         { label: t('Edit overview templates') },
  'dashboard:read':         { label: t('See layer dashboard templates') },
  'dashboard:write':        { label: t('Edit layer dashboard templates') },
  'setup:read':             { label: t('See per-layer setup') },
  'setup:write':            { label: t('Edit per-layer setup') },
  'alarm-rule:read':        { label: t('See alarm rules') },
  'alarm-rule:write':       { label: t('Edit alarm rules') },
  'alarm-setup:read':       { label: t('See alarm-page setup') },
  'alarm-setup:write':      { label: t('Edit alarm-page setup') },
  'rule:read':              { label: t('See DSL / OAL / MQE rules') },
  'rule:write':             { label: t('Edit existing rules') },
  'rule:write:structural':  { label: t('Change rule schema (OAL files)'), hint: t('schema-breaking edits') },
  'rule:delete':            { label: t('Delete rules') },
  'rule:debug':             { label: t('Test queries in the MQE sandbox') },
  'live-debug:read':        { label: t('See live-debug sessions') },
  'live-debug:write':       { label: t('Start and stop live-debug sessions') },
  'profile:enable':         { label: t('Start a profiling task on a target') },
  'user:read':              { label: t('See the user list') },
  'user:write':             { label: t('Add / remove local users') },
  'role:read':              { label: t('See this page') },
  'role:write':             { label: t('Change role grants') },
  'auth:read':              { label: t('See the auth-status page') },
  'audit:read':             { label: t('Read the audit log') },
  'admin':                  { label: t('Everything (escape hatch)') },
}));
function labelFor(verb: string): { label: string; hint?: string } {
  return VERB_LABELS.value[verb] ?? { label: verb };
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
const VERB_GROUPS = computed<VerbGroup[]>(() => [
  {
    title: t('Data catalog'),
    blurb: t('Read-only data screens. Everyone signed in sees these by default — they are the core observability surface.'),
    scope: [
      { label: t('Glance'), icon: '◧' },
      { label: t('Service dashboards'), icon: '▥' },
      { label: t('Traces'), icon: '↗' },
      { label: t('Logs'), icon: '≡' },
      { label: t('Topology'), icon: '◌' },
      { label: t('Profiling results'), icon: '▦' },
      { label: t('3D infrastructure map'), icon: '⬡' },
      { label: t('Alarms'), icon: '!' },
      { label: t('Service events'), icon: '◔' },
    ],
    verbs: ['metrics:read', 'alarms:read', 'events:read', 'traces:read', 'logs:read', 'topology:read', 'profile:read', 'infra-3d:read'],
  },
  {
    title: t('Platform monitoring'),
    blurb: t('Watching SkyWalking itself: is the OAP cluster healthy, are modules loaded, what does the internal metric catalog look like.'),
    scope: [
      { label: t('OAP cluster status'), icon: '⌬' },
      { label: t('Module inspector'), icon: '⌕' },
    ],
    verbs: ['cluster:read', 'inspect:read'],
  },
  {
    title: t('Overview templates'),
    blurb: t('The per-layer landing pages users see when they pick a layer in the sidebar.'),
    scope: [
      { label: t('Overview templates editor'), icon: '◧' },
    ],
    verbs: ['overview:read', 'overview:write'],
  },
  {
    title: t('Layer dashboards'),
    blurb: t('The dashboards and per-layer setup (slot labels, available features, term aliases) operators tune for their org.'),
    scope: [
      { label: t('Layer dashboard editor'), icon: '▥' },
      { label: t('Per-layer setup'), icon: '⚙' },
    ],
    verbs: ['dashboard:read', 'dashboard:write', 'setup:read', 'setup:write'],
  },
  {
    title: t('Alarms'),
    blurb: t('The firing rules behind the Alarms screen plus the alarm-page setup (which layers contribute to the alarm overview).'),
    scope: [
      { label: t('Alarm rules'), icon: '!' },
      { label: t('Alarm page setup'), icon: '⚙' },
    ],
    verbs: ['alarm-rule:read', 'alarm-rule:write', 'alarm-setup:read', 'alarm-setup:write'],
  },
  {
    title: t('DSL management'),
    blurb: t('The MQE, OAL and runtime-rule editing surface. Schema-breaking edits and deletes are split out so a junior operator can author rules without being able to break things irreversibly.'),
    scope: [
      { label: t('Rule catalog'), icon: '⌗' },
      { label: t('Rule editor'), icon: '✎' },
      { label: t('OAL files'), icon: '⌗' },
    ],
    verbs: ['rule:read', 'rule:write', 'rule:write:structural', 'rule:delete'],
  },
  {
    title: t('Diagnostics & debug'),
    blurb: t('Interactive troubleshooting: the live debugger that streams events from a running rule, and the MQE sandbox for testing queries without saving anything.'),
    scope: [
      { label: t('Live debugger'), icon: '◉' },
      { label: t('MQE sandbox'), icon: '▶' },
    ],
    verbs: ['rule:debug', 'live-debug:read', 'live-debug:write'],
  },
  {
    title: t('Profiling'),
    blurb: t('Starting a profiling task — agent-side sampling, async-profiler, pprof, or eBPF. Reading the results is part of "Data catalog" above.'),
    scope: [
      { label: t('Start a profiling task'), icon: '▦' },
    ],
    verbs: ['profile:enable'],
  },
  {
    title: t('Users & access admin'),
    blurb: t('The administrator surface: who can sign in, what role they have, and the live status of the auth backend.'),
    scope: [
      { label: t('Users'), icon: '◉' },
      { label: t('Roles & permissions'), icon: '⚙' },
      { label: t('Auth status'), icon: '⌬' },
    ],
    verbs: ['user:read', 'user:write', 'role:read', 'role:write', 'auth:read'],
  },
  {
    title: t('Audit'),
    blurb: t('The auditable record of every sign-in, rule change, and configuration edit. Written to a file the operator can ship to an SIEM; no in-app viewer yet.'),
    scope: [
      { label: t('Audit log (file)'), icon: '≡' },
    ],
    verbs: ['audit:read'],
  },
  {
    title: t('Everything (escape hatch)'),
    blurb: t('A sentinel granted only to the administrator role. Implies every other permission.'),
    scope: [
      { label: t('All of the above'), icon: '✦' },
    ],
    verbs: ['admin'],
  },
]);

const groupedVerbs = computed<Array<VerbGroup & { items: string[] }>>(() => {
  const known = new Set(status.value?.rbac.knownVerbs ?? []);
  const seen = new Set<string>();
  const out: Array<VerbGroup & { items: string[] }> = [];
  for (const g of VERB_GROUPS.value) {
    const items = g.verbs.filter((v) => known.has(v));
    items.forEach((v) => seen.add(v));
    if (items.length) out.push({ ...g, items });
  }
  // Any verbs not categorised above land here so they aren't silently
  // dropped from the page — that's a signal to add them to a group.
  const leftover = [...known].filter((v) => !seen.has(v));
  if (leftover.length) {
    out.push({
      title: t('Other'),
      blurb: t('Capabilities that have not been described yet.'),
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
        <span>{{ t('Admin') }}</span><span class="sep">/</span><span class="crumb-cur">{{ t('Roles & permissions') }}</span>
      </div>
      <div class="head-actions">
        <button class="sw-btn" type="button" @click="load">{{ t('Refresh') }}</button>
      </div>
    </header>

    <div v-if="loading" class="loading">{{ t('Loading roles…') }}</div>
    <div v-else-if="error" class="error">{{ t('Failed to load:') }} {{ error }}</div>
    <template v-else-if="status">
      <section class="sw-card intro">
        <h2 class="intro-title">{{ t('What each role can do') }}</h2>
        <i18n-t
          keypath="Your sidebar adapts to your role: anything you can't use is simply not shown. The sections below group SkyWalking's capabilities by feature area. For each area you'll see {menuScope} (which sidebar entries fall in the area) and {actions} (the concrete things you can do, marked per role). Multiple roles add up — a user holding more than one role gets every permission any of their roles grant."
          tag="p"
          class="intro-body"
          scope="global"
        >
          <template #menuScope><b>{{ t('Menu scope') }}</b></template>
          <template #actions><b>{{ t('Actions') }}</b></template>
        </i18n-t>
        <div class="role-summary">
          <div v-for="r in roleNames" :key="r" class="role-card">
            <span class="pill" :class="rolePill(r)">{{ r }}</span>
            <p class="role-blurb">{{ roleBlurb(r) }}</p>
          </div>
        </div>
      </section>

      <!-- Menu visibility matrix: which sidebar items each role sees.
           Computed live from the policy via the same verb gates the
           sidebar uses, so it stays honest if roles are reconfigured. -->
      <section class="sw-card menu-matrix">
        <header class="card-head">
          <h3>{{ t('Menu visibility') }}</h3>
          <span class="muted">{{ t('which sidebar items each role sees · gated by the read verb in the last column (UI hides; the BFF enforces the same server-side)') }}</span>
        </header>
        <div class="matrix-scroll">
          <table class="matrix">
            <thead>
              <tr>
                <th class="m-menu">{{ t('Menu') }}</th>
                <th v-for="r in roleNames" :key="r" class="m-role">
                  <span class="pill" :class="rolePill(r)">{{ r }}</span>
                </th>
                <th class="m-verb">{{ t('Read verb') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in MENU_GATES" :key="row.label">
                <td class="m-menu">{{ row.label }}</td>
                <td v-for="r in roleNames" :key="r" class="m-cell">
                  <span v-if="menuVisible(r, row.verb)" class="yes" :title="t('visible')">✔</span>
                  <span v-else class="no" :title="t('hidden')">—</span>
                </td>
                <td class="m-verb"><code>{{ row.verb ?? t('any signed-in') }}</code></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-for="g in groupedVerbs" :key="g.title" class="sw-card group-card">
        <header class="card-head">
          <h3>{{ g.title }}</h3>
          <span class="muted">{{ g.blurb }}</span>
        </header>
        <div class="group-body">
          <aside class="scope" :aria-label="t('Menu scope')">
            <div class="col-head">
              <span class="col-num">1</span>
              <span class="col-title">{{ t('Menu scope') }}</span>
              <span class="col-sub">{{ t('items in this area') }}</span>
            </div>
            <ul class="scope-list">
              <li v-for="item in g.scope" :key="item.label">
                <span class="scope-icon" aria-hidden="true">{{ item.icon ?? '·' }}</span>
                <span>{{ item.label }}</span>
              </li>
              <li v-if="!g.scope.length" class="scope-empty">—</li>
            </ul>
          </aside>

          <div class="connector" aria-hidden="true">→</div>

          <div class="grid-wrap">
            <div class="col-head">
              <span class="col-num">2</span>
              <span class="col-title">{{ t('Actions') }}</span>
              <span class="col-sub">{{ t('checked roles can perform each row') }}</span>
            </div>
            <table class="perm">
              <colgroup>
                <col class="col-cap" />
                <col v-for="r in roleNames" :key="r" class="col-role" />
              </colgroup>
              <thead>
                <tr>
                  <th class="th-cap">{{ t('What you can do') }}</th>
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
                    <span v-if="hasVerb(grantsOf(r), v)" class="check check-on" :aria-label="t('allowed')">✓</span>
                    <span v-else class="check check-off" :aria-label="t('not allowed')">·</span>
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
.crumbs { font-size: var(--sw-fs-base); color: var(--sw-fg-2); }
.crumbs .sep { margin: 0 6px; color: var(--sw-fg-3); }
.crumb-cur { color: var(--sw-fg-0); font-weight: var(--sw-fw-semibold); }
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
  font-size: var(--sw-fs-base);
  font-weight: var(--sw-fw-semibold);
  color: var(--sw-fg-0);
}

.intro { padding: 14px 18px; }
.intro-title { margin: 0; font-size: var(--sw-fs-lg); color: var(--sw-fg-0); font-weight: var(--sw-fw-semibold); }
.intro-body {
  margin: 8px 0 14px;
  color: var(--sw-fg-2);
  font-size: var(--sw-fs-base);
  line-height: var(--sw-lh-relaxed);
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
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-2);
  line-height: var(--sw-lh-normal);
}

.muted { color: var(--sw-fg-3); font-size: var(--sw-fs-sm); font-weight: var(--sw-fw-regular); }
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
  font-size: var(--sw-fs-sm);
  font-weight: var(--sw-fw-bold);
  flex: 0 0 18px;
}
.col-title {
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
}
.col-sub {
  font-size: var(--sw-fs-xs);
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
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-1);
  font-weight: var(--sw-fw-medium);
}
.scope-list li + li { margin-top: 1px; }
.scope-list li:hover { background: var(--sw-bg-3, rgba(255,255,255,0.03)); }
.scope-icon {
  display: inline-block;
  width: 14px;
  text-align: center;
  color: var(--sw-fg-3);
  font-size: var(--sw-fs-base);
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
  font-size: var(--sw-fs-xl);
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
  color: var(--sw-fg-3);
  font-size: var(--sw-fs-xs);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  font-weight: var(--sw-fw-bold);
  border-bottom: 1px solid var(--sw-line);
}
.perm th.th-role {
  padding: 10px 12px;
  text-align: center;
  border-bottom: 1px solid var(--sw-line);
  font-weight: var(--sw-fw-semibold);
  width: 84px;
}
.perm td {
  border-bottom: 1px solid var(--sw-line);
  font-size: var(--sw-fs-base);
  color: var(--sw-fg-1);
}
.perm tr:last-child td { border-bottom: none; }
.perm tbody tr:hover { background: rgba(255,255,255,0.02); }
.td-cap { padding: 8px 14px; vertical-align: top; }
.cap-label { color: var(--sw-fg-0); font-weight: var(--sw-fw-medium); }
.cap-hint { color: var(--sw-fg-3); font-size: var(--sw-fs-xs); margin-top: 2px; }
.td-cell { text-align: center; padding: 8px 12px; }
.check {
  display: inline-block;
  width: 18px;
  height: 18px;
  line-height: 18px;
  border-radius: 50%;
  font-size: var(--sw-fs-sm);
  font-weight: var(--sw-fw-bold);
}
.check-on {
  background: rgba(34, 197, 94, 0.16);
  color: var(--sw-ok);
}
.check-off {
  color: var(--sw-fg-3);
  background: transparent;
  font-weight: var(--sw-fw-regular);
  font-size: var(--sw-fs-lg);
}

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
.rule-k { font-size: var(--sw-fs-sm); font-weight: var(--sw-fw-semibold); color: var(--sw-fg-0); }
.rule-v { font-size: var(--sw-fs-sm); color: var(--sw-fg-2); margin-top: 4px; line-height: var(--sw-lh-relaxed); }

.menu-matrix { margin-bottom: 14px; }
.matrix-scroll { overflow-x: auto; }
.matrix {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--sw-fs-sm);
}
.matrix th,
.matrix td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--sw-line);
  text-align: center;
  white-space: nowrap;
}
.matrix thead th { border-bottom: 2px solid var(--sw-line); }
.matrix .m-menu { text-align: left; color: var(--sw-fg-0); }
.matrix .m-verb { text-align: left; }
.matrix .m-verb code {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-3);
}
.matrix tbody tr:hover { background: var(--sw-bg-2); }
.matrix .yes { color: var(--sw-ok, #34d399); font-weight: var(--sw-fw-bold); }
.matrix .no { color: var(--sw-fg-3); }
</style>
