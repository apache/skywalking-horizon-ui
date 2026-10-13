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
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { i18n } from '@/i18n';
import type { TemplateSyncRow } from '@/api/scopes/template-sync';

const { api, bundle } = vi.hoisted(() => ({
  api: { syncStatus: vi.fn(), disable: vi.fn(), enable: vi.fn(), deleteTranslation: vi.fn() },
  bundle: { value: null as unknown },
}));
vi.mock('@/api/client', () => ({ bff: { templateSync: api } }));
vi.mock('@/controls/configBundle', async () => {
  const { ref: vueRef } = await import('vue');
  const b = vueRef<unknown>(null);
  bundle.value = b;
  return { useConfigBundle: () => ({ bundle: b }), refreshConfigBundle: vi.fn(async () => undefined) };
});

import StoredTemplatesBanner from './StoredTemplatesBanner.vue';

const row = (name: string, extra: Partial<TemplateSyncRow> = {}): TemplateSyncRow => ({
  name,
  kind: 'layer',
  key: name.split('.')[2]!,
  status: 'invalid',
  effective: null,
  problems: [{ path: ['components'], message: 'Required' }],
  remote: { id: name, configuration: '{"name":"x"}', disabled: false },
  bundled: null,
  ...extra,
});

const ownsLayer = (r: { kind: string; locale?: string }): boolean => r.kind === 'layer' && r.locale === undefined;

function mountBanner(readOnly = false) {
  return mount(StoredTemplatesBanner, {
    props: { owns: ownsLayer, readOnly },
    global: { plugins: [i18n] },
  });
}

enableAutoUnmount(afterEach);
afterEach(() => {
  vi.clearAllMocks();
  (bundle.value as ReturnType<typeof ref>).value = null;
});

describe('StoredTemplatesBanner — enabled and invalid', () => {
  it('lists only the invalid rows the page owns', async () => {
    api.syncStatus.mockResolvedValue({
      rows: [
        row('horizon.layer.FLINK'),
        row('horizon.layer.GENERAL', { status: 'synced', problems: undefined }),
        row('horizon.overview.services', { kind: 'overview' }),
        row('horizon.layer.MESH.i18n.zh-CN', { locale: 'zh-CN' }),
      ],
    });
    const w = mountBanner();
    await flushPromises();
    expect(w.findAll('.itb__name').map((n) => n.text())).toEqual(['horizon.layer.FLINK']);
  });

  it('renders nothing when the page owns no invalid row', async () => {
    api.syncStatus.mockResolvedValue({ rows: [row('horizon.layer.GENERAL', { status: 'synced', problems: undefined })] });
    const w = mountBanner();
    await flushPromises();
    expect(w.find('[data-testid="invalid-templates-banner"]').exists()).toBe(false);
  });

  it('disables a record only after it is confirmed, then reads the store again', async () => {
    api.syncStatus.mockResolvedValueOnce({ rows: [row('horizon.layer.FLINK')] }).mockResolvedValue({ rows: [] });
    api.disable.mockResolvedValue({ rows: [] });
    const w = mountBanner();
    await flushPromises();

    const disable = () => w.findAll('button').find((b) => b.text() === 'Disable')!;
    await disable().trigger('click');
    expect(api.disable).not.toHaveBeenCalled();
    await disable().trigger('click');
    await flushPromises();

    expect(api.disable).toHaveBeenCalledWith('horizon.layer.FLINK');
    expect(w.emitted('changed')).toEqual([['horizon.layer.FLINK']]);
    expect(w.find('[data-testid="invalid-templates-banner"]').exists()).toBe(false);
  });

  it('disables a translation by its own record name — a language Horizon does not offer included', async () => {
    const overlay = row('horizon.layer.MESH.i18n.en', { locale: 'en', key: 'MESH' });
    api.syncStatus.mockResolvedValueOnce({ rows: [overlay] }).mockResolvedValue({ rows: [] });
    api.disable.mockResolvedValue({ rows: [] });
    const w = mount(StoredTemplatesBanner, {
      props: { owns: (r: { locale?: string }) => r.locale !== undefined, readOnly: false },
      global: { plugins: [i18n] },
    });
    await flushPromises();
    for (let i = 0; i < 2; i++) await w.findAll('button').find((b) => b.text() === 'Disable')!.trigger('click');
    await flushPromises();
    expect(api.disable).toHaveBeenCalledWith('horizon.layer.MESH.i18n.en');
    expect(api.deleteTranslation).not.toHaveBeenCalled();
  });

  it('offers no Disable to a page that cannot write', async () => {
    api.syncStatus.mockResolvedValue({ rows: [row('horizon.layer.FLINK')] });
    const w = mountBanner(true);
    await flushPromises();
    expect(w.findAll('button').map((b) => b.text())).toEqual(['Show problems', 'Download']);
  });

  it('reads the store again when the bundle reports a different set', async () => {
    api.syncStatus.mockResolvedValue({ rows: [] });
    mountBanner();
    await flushPromises();
    expect(api.syncStatus).toHaveBeenCalledTimes(1);
    (bundle.value as ReturnType<typeof ref>).value = {
      syncStatus: { invalid: [{ name: 'horizon.layer.FLINK', kind: 'layer', key: 'FLINK' }] },
    };
    await flushPromises();
    expect(api.syncStatus).toHaveBeenCalledTimes(2);
  });

  it('reloads the records on a new read of the store, though the set is unchanged', async () => {
    api.syncStatus.mockResolvedValue({ rows: [row('horizon.layer.FLINK')] });
    const b = bundle.value as ReturnType<typeof ref>;
    b.value = { syncStatus: { generatedAt: 1, invalid: [{ name: 'horizon.layer.FLINK', kind: 'layer', key: 'FLINK' }] } };
    mountBanner();
    await flushPromises();
    const calls = api.syncStatus.mock.calls.length;
    b.value = { syncStatus: { generatedAt: 2, invalid: [{ name: 'horizon.layer.FLINK', kind: 'layer', key: 'FLINK' }] } };
    await flushPromises();
    expect(api.syncStatus.mock.calls.length).toBe(calls + 1);
  });
});

describe('StoredTemplatesBanner — disabled, valid or not', () => {
  const disabledRow = (name: string, problems?: TemplateSyncRow['problems']) =>
    row(name, {
      status: 'disabled',
      problems,
      remote: { id: name, configuration: '{"name":"x"}', disabled: true },
    });

  it('lists disabled records apart from invalid ones, collapsed until opened', async () => {
    api.syncStatus.mockResolvedValue({
      rows: [row('horizon.layer.FLINK'), disabledRow('horizon.layer.MESH'), disabledRow('horizon.layer.K8S', [{ path: ['components'], message: 'Required' }])],
    });
    const w = mountBanner();
    await flushPromises();

    expect(w.findAll('[data-testid="invalid-templates-banner"] .itb__name').map((n) => n.text())).toEqual(['horizon.layer.FLINK']);
    const disabled = w.find('[data-testid="disabled-templates"]');
    expect(disabled.text()).toContain('2 disabled templates stored on OAP');
    expect(disabled.findAll('.itb__name')).toHaveLength(0);

    await disabled.find('.dtb__head').trigger('click');
    expect(disabled.findAll('.itb__name').map((n) => n.text())).toEqual(['horizon.layer.MESH', 'horizon.layer.K8S']);
    // Only the invalid one offers its problems.
    const buttonsOf = (name: string) =>
      disabled.findAll('.itb__row').find((r) => r.text().includes(name))!.findAll('button').map((b) => b.text());
    expect(buttonsOf('horizon.layer.MESH')).toEqual(['Enable']);
    expect(buttonsOf('horizon.layer.K8S')).toEqual(['Show problems', 'Download', 'Enable']);
  });

  it('enables a record only after it is confirmed — saying an invalid one comes back invalid', async () => {
    api.syncStatus
      .mockResolvedValueOnce({ rows: [disabledRow('horizon.layer.K8S', [{ path: ['components'], message: 'Required' }])] })
      .mockResolvedValue({ rows: [] });
    api.enable.mockResolvedValue({ rows: [] });
    const w = mountBanner();
    await flushPromises();
    await w.find('.dtb__head').trigger('click');

    const enable = () => w.findAll('button').find((b) => b.text() === 'Enable')!;
    await enable().trigger('click');
    expect(api.enable).not.toHaveBeenCalled();
    expect(w.text()).toContain('It comes back invalid.');
    await enable().trigger('click');
    await flushPromises();

    expect(api.enable).toHaveBeenCalledWith('horizon.layer.K8S');
    expect(w.emitted('changed')).toEqual([['horizon.layer.K8S']]);
  });

  it('offers no Enable to a page that cannot write', async () => {
    api.syncStatus.mockResolvedValue({ rows: [disabledRow('horizon.layer.MESH')] });
    const w = mountBanner(true);
    await flushPromises();
    await w.find('.dtb__head').trigger('click');
    expect(w.findAll('button').map((b) => b.text()).filter((t) => t === 'Enable')).toEqual([]);
  });
});
