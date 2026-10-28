// Licensed to the Apache Software Foundation (ASF) under one or more
// contributor license agreements.  See the NOTICE file distributed with
// this work for additional information regarding copyright ownership.
// The ASF licenses this file to You under the Apache License, Version 2.0
// (the "License"); you may not use this file except in compliance with
// the License.  You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { afterEach, describe, expect, it } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { ProfileAnalyzationTree } from '@/api/client';
import { i18n } from '@/i18n';
import ProfileStackPanel from './ProfileStackPanel.vue';

const TREE: ProfileAnalyzationTree = {
  elements: [
    { id: '1', parentId: '0', codeSignature: 'runtime.goexit:1695', duration: 10, durationChildExcluded: 0, count: 2 },
    { id: '2', parentId: '1', codeSignature: 'main.handler:30', duration: 10, durationChildExcluded: 10, count: 2 },
  ],
};

function mountPanel(views?: ('tree' | 'flame')[]) {
  return mount(ProfileStackPanel, {
    props: {
      trees: [TREE],
      views,
      displayMode: views?.[0] ?? 'tree',
      hidePatterns: [],
      search: '',
      popoutTitle: 'pprof · go-service',
    },
    attachTo: document.body,
    // d3-flame-graph needs a real layout engine; the panel is what is tested.
    global: { plugins: [i18n], stubs: { ProfileFlameGraph: true } },
  });
}

// Unmounted after each test: a mounted floating panel keeps a click listener
// on document, which a later test's clicks would wake against a wiped body.
enableAutoUnmount(afterEach);
afterEach(() => {
  document.body.innerHTML = '';
});

describe('ProfileStackPanel', () => {
  it('offers the Tree | Flame switch only when the page has both views', () => {
    expect(mountPanel().findAll('.seg button').map((b) => b.text())).toEqual(['Tree', 'Flame']);
    expect(mountPanel(['flame', 'tree']).findAll('.seg button').map((b) => b.text())).toEqual(['Flame', 'Tree']);
    expect(mountPanel(['flame']).find('.seg').exists()).toBe(false);
  });

  it('keeps top slow to the Tree', () => {
    expect(mountPanel(['flame']).find('.psp-joined').exists()).toBe(false);
    expect(mountPanel(['tree']).find('.psp-joined').exists()).toBe(true);
  });

  it('pops out into a dialog with the same controls and no Pop out of its own', async () => {
    const w = mountPanel(['flame']);
    await w.find('.psp-pop').trigger('click');
    await nextTick();
    const dialog = document.body.querySelector('.modal');
    expect(dialog?.querySelector('.modal__title')?.textContent).toBe('pprof · go-service');
    expect(dialog?.querySelector('.psp-bar')).not.toBeNull();
    expect(dialog?.querySelector('.psp-pop')).toBeNull();
  });

  it('closes the pop-out when the result goes away', async () => {
    const w = mountPanel(['flame']);
    await w.find('.psp-pop').trigger('click');
    await nextTick();
    await w.setProps({ trees: [] });
    await nextTick();
    expect(document.body.querySelector('.modal')).toBeNull();
  });
});
