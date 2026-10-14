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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { i18n } from '@/i18n';
import type { Infra3dConfig } from '@/api/client';

const editor = vi.hoisted(() => ({ draft: null as unknown, save: vi.fn() }));

vi.mock('@/components/primitives/MonacoDiff.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/features/admin/_shared/StoredTemplatesBanner.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/features/infra-3d/composables/useInfra3dConfig', () => ({ refresh: vi.fn() }));
vi.mock('@/shell/useLayers', async () => {
  const { ref: vueRef } = await import('vue');
  return { useLayers: () => ({ availableLayers: vueRef([]) }) };
});
vi.mock('@/features/admin/_shared/useSingletonTemplateEditor', async () => {
  const { computed: c, ref: r } = await import('vue');
  return {
    useSingletonTemplateEditor: () => ({
      draft: editor.draft,
      editorSource: r('remote'),
      loadError: r(false),
      ready: c(() => true),
      readOnly: c(() => false),
      hasLocalDraft: c(() => false),
      hasRemote: c(() => true),
      badge: c(() => null),
      invalid: c(() => false),
      contentInvalid: c(() => false),
      refusedImport: r(null),
      reload: vi.fn(),
      isSynced: c(() => true),
      dirty: c(() => true),
      banner: c(() => ({ severity: 'ok' })),
      pushErr: r(null),
      pushing: r(false),
      pushDiffOpen: r(false),
      resetMenuOpen: r(false),
      importMsg: r(null),
      pushLocalPretty: c(() => ''),
      pushRemotePretty: c(() => ''),
      save: editor.save,
      openPushDiff: vi.fn(),
      pushToOap: vi.fn(),
      resetTo: vi.fn(),
      onExport: vi.fn(),
      onImportFile: vi.fn(),
    }),
  };
});

import Infra3dAdminView from './Infra3dAdminView.vue';

function config(): Infra3dConfig {
  const style = { color: '#fff', style: 'solid' as const, arrow: false };
  return {
    filter: { layer: '.*' },
    edges: { hierarchy: style, crossLevelCall: style, intraCall: style },
    pipeline: { metricChunkSize: 1, topologyConcurrency: 1, templateConcurrency: 1 },
    unknownLayer: { level: 'middleware', badge: 'unclassified' },
    levels: [
      { id: 'apps', order: 0, label: 'Apps', layers: ['GENERAL'] },
      { id: 'middleware', order: 1, label: 'Middleware', layers: ['MYSQL'] },
    ],
    groups: [{ id: 'so11y', label: 'Self-Observability', level: 'middleware', color: '#a78bfa', icon: 'svc', layers: [] }],
    layers: { GENERAL: { color: '#111' }, MYSQL: { color: '#222' } },
  };
}

function mountView(cfg: Infra3dConfig = config()) {
  const draft = ref<Infra3dConfig | null>(cfg);
  editor.draft = draft;
  const w = mount(Infra3dAdminView, { global: { plugins: [i18n] } });
  return { w, draft };
}

const tierCards = (w: ReturnType<typeof mountView>['w']) => w.findAll('.tier-card');
const tierLayers = (w: ReturnType<typeof mountView>['w'], i: number) =>
  tierCards(w)[i]!.findAll('.layer-key').map((n) => n.text());

enableAutoUnmount(afterEach);
afterEach(() => vi.clearAllMocks());

describe('Infra3dAdminView — tiers', () => {
  it('renames a tier per keystroke on the same input, carrying the group and failover tier', async () => {
    const { w, draft } = mountView();
    const input = tierCards(w)[1]!.find('input.lvl-id');
    for (const v of ['middlewar', 'data']) await input.setValue(v);
    expect(tierCards(w)[1]!.find('input.lvl-id').element).toBe(input.element);
    expect(draft.value!.levels[1]!.id).toBe('data');
    expect(draft.value!.groups![0]!.level).toBe('data');
    expect(draft.value!.unknownLayer.level).toBe('data');
  });

  it('holds back a rename onto another tier\'s id and says why', async () => {
    const { w, draft } = mountView();
    const input = tierCards(w)[1]!.find('input.lvl-id');
    await input.setValue('apps');
    expect(draft.value!.levels[1]!.id).toBe('middleware');
    expect((input.element as HTMLInputElement).value).toBe('apps');
    expect(tierCards(w)[1]!.find('.id-refused').text()).toBe('duplicate');
    await input.trigger('blur');
    expect((input.element as HTMLInputElement).value).toBe('middleware');
    expect(tierCards(w)[1]!.find('.id-refused').exists()).toBe(false);
  });

  it('disables removing the last tier', async () => {
    const { w } = mountView();
    await tierCards(w)[0]!.find('button.danger').trigger('click');
    expect(tierCards(w)).toHaveLength(1);
    expect(tierCards(w)[0]!.find('button.danger').attributes('disabled')).toBeDefined();
  });
});

describe('Infra3dAdminView — groups and pins', () => {
  it('unpins a layer that joins a group and lists it under the group\'s tier', async () => {
    const { w, draft } = mountView();
    draft.value!.groups![0]!.level = 'apps';
    await w.find('.group-card select.add-layer').setValue('MYSQL');
    expect(draft.value!.levels[1]!.layers).toEqual([]);
    expect(draft.value!.groups![0]!.layers).toEqual(['MYSQL']);
    expect(tierLayers(w, 0)).toEqual(['GENERAL', 'MYSQL']);
    expect(tierLayers(w, 1)).toEqual([]);
    const row = tierCards(w)[0]!.findAll('.layer-row')[1]!;
    expect(row.find('.via-tag[data-via="group"]').text()).toContain('Self-Observability');
    expect(row.find('select.tier-select').attributes('disabled')).toBeDefined();
    expect((row.find('select.tier-select').element as HTMLSelectElement).value).toBe('apps');
  });

  it('moves a grouped layer when its group changes tier', async () => {
    const cfg = config();
    cfg.groups![0]!.layers = ['MYSQL'];
    cfg.levels[1]!.layers = [];
    const { w } = mountView(cfg);
    expect(tierLayers(w, 1)).toEqual(['MYSQL']);
    await w.find('.group-card select.inp').setValue('apps');
    expect(tierLayers(w, 0)).toEqual(['GENERAL', 'MYSQL']);
    expect(tierLayers(w, 1)).toEqual([]);
  });
});

describe('Infra3dAdminView — save', () => {
  it('drops a metric left entirely blank before saving the draft', async () => {
    const { w, draft } = mountView();
    await tierCards(w)[0]!.find('.layer-row button.ghost').trigger('click');
    expect(draft.value!.layers.GENERAL!.metric).toEqual({ mqe: '', label: '', unit: '' });
    const saveBtn = w.findAll('.hd-actions button').find((b) => b.text() === 'Save local')!;
    await saveBtn.trigger('click');
    expect(editor.save).toHaveBeenCalledTimes(1);
    expect(draft.value!.layers.GENERAL!.metric).toBeUndefined();
  });
});
