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
import { i18n } from '@/i18n';

const api = vi.hoisted(() => ({ syncStatus: vi.fn(), save: vi.fn() }));
vi.mock('@/api/client', () => ({ bff: { templateSync: api } }));
vi.mock('@/features/admin/_shared/TemplateDiffModal.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/features/admin/_shared/StoredTemplatesBanner.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/features/admin/_shared/SyncStatusBanner.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/features/admin/_shared/useTemplateSync', async () => {
  const { computed } = await import('vue');
  return {
    useTemplateSync: () => ({
      readOnly: computed(() => false),
      banner: computed(() => null),
      status: computed(() => null),
      badgeFor: () => 'synced',
      invalidFor: () => false,
    }),
  };
});
vi.mock('@/state/theme', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/state/theme')>()),
  useThemeStore: () => ({ active: 'horizon' }),
}));

import GlobalDefaultsAdmin from './GlobalDefaultsAdmin.vue';

const row = (name: string, content: unknown) => ({
  name,
  effective: 'remote',
  remote: { configuration: JSON.stringify({ content }) },
  bundled: null,
});

async function mountPage() {
  api.syncStatus.mockResolvedValue({
    rows: [
      row('horizon.theme.active', { themeId: 'horizon' }),
      row('horizon.time-defaults.global', { defaultWindowMinutes: 60 }),
    ],
  });
  api.save.mockResolvedValue({ rows: [] });
  const w = mount(GlobalDefaultsAdmin, { global: { plugins: [i18n] } });
  await flushPromises();
  return w;
}

const saveButton = (w: Awaited<ReturnType<typeof mountPage>>) => w.find('.gd__btn--primary');

enableAutoUnmount(afterEach);
afterEach(() => vi.clearAllMocks());

describe('GlobalDefaultsAdmin — save', () => {
  it('blocks Save on a cleared minutes input and writes neither section, even with a new theme', async () => {
    const w = await mountPage();
    await w.findAll('.tpc')[1]!.trigger('click');
    await w.find('.gd__custom input').setValue('');
    expect(w.find('[data-testid="time-window-problem"]').text()).toBe('Must be 1–44640.');
    expect(saveButton(w).attributes('disabled')).toBeDefined();
    await saveButton(w).trigger('click');
    await flushPromises();
    expect(api.save).not.toHaveBeenCalled();
  });

  it('refuses a fraction of a minute', async () => {
    const w = await mountPage();
    await w.find('.gd__custom input').setValue('2.5');
    expect(w.find('[data-testid="time-window-problem"]').text()).toBe('Whole number, greater than 0.');
    expect(saveButton(w).attributes('disabled')).toBeDefined();
  });

  it('writes both rows once both sections are valid', async () => {
    const w = await mountPage();
    await w.findAll('.tpc')[1]!.trigger('click');
    await w.find('.gd__custom input').setValue('15');
    expect(w.find('[data-testid="time-window-problem"]').exists()).toBe(false);
    await saveButton(w).trigger('click');
    await flushPromises();
    expect(api.save.mock.calls).toEqual([
      ['horizon.theme.active', { themeId: 'meridian' }],
      ['horizon.time-defaults.global', { defaultWindowMinutes: 15 }],
    ]);
  });

  it('keeps only the section whose write failed unsaved', async () => {
    const w = await mountPage();
    await w.findAll('.tpc')[1]!.trigger('click');
    await w.find('.gd__custom input').setValue('15');
    api.save.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(new Error('boom'));
    await saveButton(w).trigger('click');
    await flushPromises();
    expect(api.save).toHaveBeenCalledTimes(2);
    // Saving again retries just the time window; the theme already landed.
    api.save.mockResolvedValue({ rows: [] });
    await saveButton(w).trigger('click');
    await flushPromises();
    expect(api.save.mock.calls[2]).toEqual(['horizon.time-defaults.global', { defaultWindowMinutes: 15 }]);
    expect(api.save).toHaveBeenCalledTimes(3);
  });
});
