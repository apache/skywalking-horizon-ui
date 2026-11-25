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
 * The TAL rules page sits under DSL management, gated on `rule:read` like the other rule catalogs, and the OTLP
 * pairing page beside the Live debugger, gated on `live-debug:read`: the sidebar shows each only to a role holding its
 * verb. The menu matrix side of these rows is held by `menuVisibility.test.ts`.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { defineComponent } from 'vue';
import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { i18n } from '@/i18n';
import { useAuthStore } from '@/state/auth';
import { useSidebarMenu } from '@/shell/useSidebarMenu';

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

function sidebarEntries(verbs: string[]): string[] {
  setActivePinia(pinia);
  useAuthStore().user = { username: 'op', roles: ['test'], verbs };
  const w = mount(SidebarHarness, { global: { plugins: [pinia, router, i18n] } });
  return w.findAll('.entry').map((e) => e.text());
}

beforeEach(async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  });
  await router.push('/');
  await router.isReady();
});

describe('menu visibility — the TAL rules and OTLP pairing entries', () => {
  const both = ['rule:read', 'live-debug:read'];

  it('shows both entries to a role holding their verbs', () => {
    const shown = sidebarEntries(both);
    expect(shown).toContain('/operate/tal');
    expect(shown).toContain('/operate/otlp-pairing');
  });

  it.each([
    { verb: 'rule:read', path: '/operate/tal', other: '/operate/otlp-pairing' },
    { verb: 'live-debug:read', path: '/operate/otlp-pairing', other: '/operate/tal' },
  ])('withholding $verb hides $path and nothing of the other', ({ verb, path, other }) => {
    const shown = sidebarEntries(both.filter((v) => v !== verb));
    expect(shown, `${path} still renders without ${verb}`).not.toContain(path);
    expect(shown, `${other} went with it`).toContain(other);
  });
});
