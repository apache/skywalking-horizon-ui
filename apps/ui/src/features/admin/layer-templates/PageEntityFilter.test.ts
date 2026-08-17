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
 * The preview's paging past its first page, which no fixture reaches: the
 * e2e layers report two services, so an assertion there is satisfied by a
 * component that never pages at all.
 */

import { describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { i18n } from '@/i18n';

vi.mock('@/layer/useLayerInstances', () => ({
  useLayerInstances: () => ({ instances: computed(() => []), isFetching: ref(false) }),
}));
vi.mock('@/layer/useLayerEndpoints', () => ({
  useLayerEndpoints: () => ({ endpoints: computed(() => []), isFetching: ref(false) }),
}));

const PageEntityFilter = (await import('./PageEntityFilter.vue')).default;

const roster = (n: number): Array<{ id: string; name: string }> =>
  Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, name: `svc-${String(i).padStart(3, '0')}` }));

async function openPreview(services: Array<{ id: string; name: string }>, serviceFilter = ''): Promise<VueWrapper> {
  const w = mount(PageEntityFilter, {
    props: { mode: 'service', layerKey: 'GENERAL', serviceFilter, services },
    // Modal teleports to <body>, which the wrapper cannot see. The stub
    // keeps the `open` gate so the popout is still something that opens.
    global: {
      plugins: [i18n],
      stubs: {
        TypeaheadSelect: true,
        Modal: { props: ['open'], template: '<div v-if="open"><slot /></div>' },
      },
    },
  });
  await w.get('.pef-check .sw-btn').trigger('click');
  return w;
}

const rows = (w: VueWrapper): string[] => w.findAll('.pef-list li').map((li) => li.text());
const pager = (w: VueWrapper) => w.find('.pef-pager');

describe('the preview pages through a long roster', () => {
  it('shows twenty at a time and says which twenty', async () => {
    const w = await openPreview(roster(45));
    expect(rows(w)).toHaveLength(20);
    expect(rows(w)[0]).toContain('svc-000');
    expect(pager(w).text()).toContain('1–20 of 45');
  });

  it('walks forward to a short last page and back again', async () => {
    const w = await openPreview(roster(45));
    const next = () => pager(w).findAll('button')[1]!.trigger('click');
    const prev = () => pager(w).findAll('button')[0]!.trigger('click');

    await next();
    expect(rows(w)[0]).toContain('svc-020');
    expect(pager(w).text()).toContain('21–40 of 45');

    await next();
    // The tail is short, and the label must not promise rows that are
    // not there — `41–60 of 45` is the arithmetic bug this pins.
    expect(rows(w)).toHaveLength(5);
    expect(pager(w).text()).toContain('41–45 of 45');
    expect(pager(w).findAll('button')[1]!.attributes('disabled')).toBeDefined();

    await prev();
    expect(pager(w).text()).toContain('21–40 of 45');
  });

  it('still shows the range when the roster fits one page', async () => {
    const w = await openPreview(roster(20));
    expect(rows(w)).toHaveLength(20);
    // Visible, not hidden: the pager is how the operator learns the list
    // is paged at all, and a roster that fits still says how many it has.
    expect(pager(w).text()).toContain('1–20 of 20');
    expect(pager(w).findAll('button')[0]!.attributes('disabled')).toBeDefined();
    expect(pager(w).findAll('button')[1]!.attributes('disabled')).toBeDefined();
  });

  it('re-pages when Filtered shrinks the set under a later page', async () => {
    // Page 3 of 45, then narrow to a set with a single page: the operator
    // must not be left staring at a page that no longer exists.
    const w = await openPreview(roster(45), 'svc-00');
    await pager(w).findAll('button')[1]!.trigger('click');
    await pager(w).findAll('button')[1]!.trigger('click');
    expect(pager(w).text()).toContain('41–45 of 45');

    await w.findAll('.pef-seg button')[1]!.trigger('click'); // Filtered
    expect(rows(w)).toHaveLength(10); // svc-000 … svc-009
    expect(pager(w).text()).toContain('1–10 of 10');
    expect(rows(w)[0]).toContain('svc-000');
  });
});
