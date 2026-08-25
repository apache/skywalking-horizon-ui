/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * The Roles board states its menu matrix is every navigation entry and the
 * verb that decides who sees it. That the row LIST stays complete is held
 * statically by the BFF's `rbac/verb-enforcement.test.ts`; this holds the two
 * BEHAVIOURS against each other — the sidebar composable actually run for a
 * role, and the matrix actually rendered for the same grants. A row that reads
 * "hidden" while the entry still renders (or the reverse) is a lie an admin
 * plans access around.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { i18n } from '@/i18n';
import { useAuthStore } from '@/state/auth';
import { useSidebarMenu } from '@/shell/useSidebarMenu';
import RolesView from './RolesView.vue';

/**
 * One case per verb the static menu hides an entry by: the matrix rows that
 * name it, and the sidebar destinations it gates. Withholding the verb must
 * take away exactly these, on both surfaces.
 */
const GATES: ReadonlyArray<{ verb: string; rows: string[]; paths: string[] }> = [
  { verb: 'cluster:read', rows: ['Cluster status', 'Platform monitoring (layers)'], paths: ['/operate/cluster'] },
  { verb: 'ttl:read', rows: ['Data retention'], paths: ['/operate/ttl'] },
  { verb: 'config:read', rows: ['OAP configuration'], paths: ['/operate/config'] },
  { verb: 'alarm-rule:read', rows: ['Alerting rules'], paths: ['/operate/alerting-rules'] },
  {
    verb: 'rule:read',
    rows: ['DSL management'],
    // The expandable L1 and every sub-entry under it.
    paths: [
      '/operate/dsl/otel-rules',
      '/operate/dsl/telegraf-rules',
      '/operate/dsl/meter-analyzer-config',
      '/operate/dsl/lal',
      '/operate/dsl/log-mal-rules',
      '/operate/oal',
      '/operate/dsl/dump',
    ],
  },
  {
    verb: 'live-debug:read',
    rows: ['Live debugger · Capture history'],
    paths: ['/operate/live-debug', '/operate/live-debug/history'],
  },
  {
    verb: 'inspect:read',
    rows: ['Metrics inspect', 'Trace inspect', 'Log inspect'],
    paths: ['/operate/inspect', '/operate/trace-inspect', '/operate/log-inspect'],
  },
  {
    verb: 'overview:write',
    rows: ['Overview templates', 'Translations', '3D Infra Map setup'],
    paths: ['/admin/overview-templates', '/admin/translations', '/admin/3d-map'],
  },
  { verb: 'dashboard:read', rows: ['Layer dashboards'], paths: ['/admin/layer-dashboards'] },
  { verb: 'alarm-setup:read', rows: ['Alert page'], paths: ['/admin/alert-page-setup'] },
  { verb: 'setup:read', rows: ['Global defaults'], paths: ['/admin/global-defaults'] },
  { verb: 'user:read', rows: ['Users'], paths: ['/admin/users'] },
  { verb: 'auth:read', rows: ['Auth status'], paths: ['/admin/auth-status'] },
  { verb: 'role:read', rows: ['Roles & permissions'], paths: ['/admin/roles'] },
  { verb: 'audit:read', rows: ['Login audit'], paths: ['/admin/audit'] },
];

/** The verbs the shell's own nav blocks are gated on — no static-menu entry
 *  rides on these, so they only move check marks. */
const SHELL_ONLY = ['overview:read', 'alarms:read', 'infra-3d:read'];

const ALL_VERBS = [...GATES.map((g) => g.verb), ...SHELL_ONLY];

/** Renders the real menu registry's destinations for the signed-in grants —
 *  L1 rows and the sub-entries of an expandable one. */
const SidebarHarness = defineComponent({
  setup: () => useSidebarMenu(),
  template: `
    <ul>
      <template v-for="s in (platformSection ? [platformSection, ...menuSections] : menuSections)" :key="s.kicker">
        <li v-for="r in s.links" :key="r.to">
          <span class="entry">{{ r.to }}</span>
          <span v-for="c in (r.children ?? [])" :key="c.to" class="entry">{{ c.to }}</span>
        </li>
      </template>
    </ul>`,
});

let router: Router;
let pinia: Pinia;

/** Destinations the sidebar renders for a user holding exactly `verbs`. */
function sidebarEntries(verbs: string[]): string[] {
  setActivePinia(pinia);
  useAuthStore().user = { username: 'op', roles: ['test'], verbs };
  const w = mount(SidebarHarness, { global: { plugins: [pinia, router, i18n] } });
  return w.findAll('.entry').map((e) => e.text());
}

/** The board's live policy read. Two roles: one holding everything the matrix
 *  can show, one holding all of it but `without`. */
function fakeAuthStatus(without: string | null): typeof fetch {
  const limited = ALL_VERBS.filter((v) => v !== without);
  const body = {
    configPath: '/etc/horizon.yaml',
    configMtime: null,
    configSizeBytes: null,
    backend: 'local',
    bothPresent: false,
    sessions: { active: 1 },
    local: { users: 2, role: 'primary' },
    ldap: null,
    breakGlass: { configured: false, armed: false, username: null },
    rbac: {
      enabled: true,
      roles: { full: ALL_VERBS, limited },
      landingByRole: {},
      knownVerbs: ALL_VERBS,
      reservedVerbs: [],
    },
  };
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

interface MatrixRow {
  label: string;
  /** Per role column, in `roleNames` order: `full`, then `limited`. */
  visible: boolean[];
  verb: string;
}

async function matrixFor(without: string | null): Promise<MatrixRow[]> {
  vi.stubGlobal('fetch', fakeAuthStatus(without));
  const w: VueWrapper = mount(RolesView, { global: { plugins: [i18n] } });
  await flushPromises();
  const rows = w.findAll('.matrix tbody tr').map((tr) => ({
    label: tr.get('td.m-menu').text(),
    visible: tr.findAll('td.m-cell').map((td) => td.find('.yes').exists()),
    verb: tr.get('td.m-verb').text(),
  }));
  expect(rows.length, 'the menu matrix rendered no rows').toBeGreaterThan(0);
  return rows;
}

beforeEach(async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  });
  await router.push('/admin/roles');
  await router.isReady();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('menu visibility — the matrix and the sidebar answer alike', () => {
  it('renders every entry the matrix accounts for when nothing is withheld', () => {
    const shown = sidebarEntries(ALL_VERBS);
    for (const g of GATES) {
      for (const path of g.paths) expect(shown, `${path} never rendered`).toContain(path);
    }
  });

  it.each(GATES)('withholding $verb hides its entries and its rows alike', async (gate) => {
    const kept = ALL_VERBS.filter((v) => v !== gate.verb);
    const shown = sidebarEntries(kept);

    for (const path of gate.paths) {
      expect(shown, `${path} still renders without ${gate.verb}`).not.toContain(path);
    }
    // Only its own: withholding one verb must not take an unrelated entry with it.
    const others = GATES.filter((g) => g.verb !== gate.verb).flatMap((g) => g.paths);
    for (const path of others) {
      expect(shown, `${path} disappeared with ${gate.verb}, which does not gate it`).toContain(path);
    }

    const rows = await matrixFor(gate.verb);
    for (const row of rows) {
      const gatedByThis = gate.rows.includes(row.label);
      expect(row.visible[0], `${row.label}: hidden from a role holding everything`).toBe(true);
      expect(
        row.visible[1],
        `${row.label} reads ${row.visible[1] ? 'visible' : 'hidden'} for a role without ${gate.verb}`,
      ).toBe(!gatedByThis);
    }
  });

  it('labels each row with the verb the sidebar hides it by', async () => {
    const rows = await matrixFor(null);
    const verbOf = new Map(rows.map((r) => [r.label, r.verb]));
    for (const gate of GATES) {
      for (const label of gate.rows) {
        expect(verbOf.get(label), `no matrix row labelled "${label}"`).toBe(gate.verb);
      }
    }
  });

  // The four rows that carry no destination stand for nav the shell builds
  // itself; they still have to move with their verb.
  it('moves the shell rows with their own verb', async () => {
    for (const verb of SHELL_ONLY) {
      const rows = await matrixFor(verb);
      const hidden = rows.filter((r) => !r.visible[1]).map((r) => r.label);
      expect(hidden.length, `withholding ${verb} hid no row`).toBeGreaterThan(0);
      for (const label of hidden) expect(rows.find((r) => r.label === label)?.verb).toBe(verb);
    }
  });
});
