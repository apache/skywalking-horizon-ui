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
 * The TAL rules page puts a rule's ▶ on the line of the shown file that declares it. The listing and the file are two
 * reads, so the listing's line can be of another version of the file than the one on screen.
 */

import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { i18n } from '@/i18n';

/** The file as OAP has it now: a comment added above the rule since the listing was read. */
const TEXT = ['rules:', '  # added after the listing', '  - name: demo', '    layer: GENERAL', '    dsl: |'].join('\n');
/** The file OAP serves; a test may swap it. */
let served = TEXT;

vi.mock('@/api/client', () => ({
  BffApiError: class BffApiError extends Error {},
  bff: {
    dsl: {
      talFiles: async () => ({
        // The listing names the rule's line before the comment was added.
        files: [{ name: 'demo', list: 'talFiles', inputType: 'otlp', rules: [{ name: 'demo', layer: 'GENERAL', line: 2, debuggable: true }] }],
      }),
      talFileContent: async () => served,
    },
  },
}));
vi.mock('@/shell/useAdminFeatures', () => ({
  useAdminFeatures: () => ({
    result: ref({}),
    adminReachable: ref(true),
    adminError: ref(null),
    adminUrl: ref(''),
    moduleByName: () => ({ value: { name: 'dsl-debugging', status: 'present' } }),
    refetch: vi.fn(),
  }),
}));

const { default: TalCatalogView } = await import('./TalCatalogView.vue');

async function markedLines(): Promise<string[]> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  });
  await router.push('/operate/tal');
  await router.isReady();
  const w = mount(TalCatalogView, {
    global: { plugins: [i18n, router, [VueQueryPlugin, { queryClient: new QueryClient() }]] },
  });
  await flushPromises();
  await w.find('button.tal__file').trigger('click');
  await flushPromises();
  const marked = w.findAll('.tal__line').filter((l) => l.find('button.tal__dbg').exists()).map((l) => l.text());
  w.unmount();
  return marked;
}

describe('TalCatalogView', () => {
  it('puts a rule’s ▶ on the line declaring it in the file on screen, whatever line the listing read', async () => {
    served = TEXT;
    const marked = await markedLines();
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain('- name: demo');
  });

  it('reads a file saved with Windows line endings as any other', async () => {
    served = TEXT.split('\n').join('\r\n') + '\r\n';
    const marked = await markedLines();
    expect(marked, 'the rule keeps its ▶').toHaveLength(1);
    expect(marked[0]).toContain('- name: demo');
  });
});
