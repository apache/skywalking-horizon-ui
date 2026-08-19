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
 * The board reads "what each role can do", so a row that does nothing has to
 * say so on screen. Reserved-ness is served by the BFF (which owns the list);
 * these drive the rendering of it — including that a granted reserved verb
 * still shows its check mark, so an admin reviewing a config sees the grant
 * they wrote AND that it buys nothing.
 *
 * Which verbs are reserved is asserted against the policy sources in the
 * BFF's `rbac/verb-enforcement.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { i18n } from '@/i18n';
import RolesView from './RolesView.vue';

const RESERVED = 'user:write';
const ENFORCED = 'alarms:read';

function fakeAuthStatus(): typeof fetch {
  const body = {
    configPath: '/etc/horizon.yaml',
    configMtime: null,
    configSizeBytes: null,
    backend: 'local',
    bothPresent: false,
    sessions: { active: 1 },
    local: { users: 1, role: 'primary' },
    ldap: null,
    breakGlass: { configured: false, armed: false, username: null },
    rbac: {
      enabled: true,
      roles: { viewer: [ENFORCED], operator: [ENFORCED, RESERVED] },
      landingByRole: { viewer: '/' },
      knownVerbs: [ENFORCED, RESERVED],
      reservedVerbs: [RESERVED],
    },
  };
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

async function mountRoles(): Promise<VueWrapper> {
  const w = mount(RolesView, { global: { plugins: [i18n] } });
  await flushPromises();
  return w;
}

/** The capability row for a verb, found by its rendered label. */
function rowFor(w: VueWrapper, label: string): { text: string; marked: boolean } {
  const row = w.findAll('.perm tbody tr').find((tr) => tr.text().includes(label));
  if (!row) throw new Error(`no capability row rendered for ${JSON.stringify(label)}`);
  return { text: row.text(), marked: row.classes().includes('is-reserved') };
}

afterEach(() => vi.unstubAllGlobals());

describe('Roles board — reserved capabilities', () => {
  it('marks a reserved verb and says granting it does nothing', async () => {
    vi.stubGlobal('fetch', fakeAuthStatus());
    const w = await mountRoles();

    const row = rowFor(w, 'Add / remove local users');
    expect(row.marked).toBe(true);
    expect(row.text).toContain('Reserved');
    expect(row.text).toContain('granting it has no effect');
  });

  it('leaves an enforced verb unmarked', async () => {
    vi.stubGlobal('fetch', fakeAuthStatus());
    const w = await mountRoles();

    const row = rowFor(w, 'See alarms');
    expect(row.marked).toBe(false);
    expect(row.text).not.toContain('Reserved');
  });

  it('still shows the grant a role holds on a reserved verb', async () => {
    vi.stubGlobal('fetch', fakeAuthStatus());
    const w = await mountRoles();

    const row = w
      .findAll('.perm tbody tr')
      .find((tr) => tr.text().includes('Add / remove local users'))!;
    // viewer · operator, in that column order — only operator was granted it.
    const cells = row.findAll('.td-cell .check');
    expect(cells.map((c) => c.classes().includes('check-on'))).toEqual([false, true]);
  });
});
