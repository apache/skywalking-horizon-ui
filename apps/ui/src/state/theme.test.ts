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
 * Where the org-default theme comes from. Every signed-in user loads it at
 * boot, so it reads the auth-gated org settings — not the admin template
 * rows, which need `overview:read` and carry every template's bundled copy.
 * No value means no org default: the in-code theme renders.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { bff } from '@/api/client';
import { useThemeStore } from './theme';

describe('theme store — org default', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('reads the theme the BFF resolved, without touching the admin template rows', async () => {
    const settings = vi
      .spyOn(bff.configs, 'settings')
      .mockResolvedValue({ theme: { themeId: 'obsidian' }, timeDefaults: null, alert: null });
    const syncStatus = vi.spyOn(bff.templateSync, 'syncStatus');

    const store = useThemeStore();
    await store.loadOrgDefault();

    expect(store.orgDefault).toBe('obsidian');
    expect(store.active).toBe('obsidian');
    expect(settings).toHaveBeenCalledTimes(1);
    expect(syncStatus).not.toHaveBeenCalled();
  });

  it('has no org default when the BFF resolved no value', async () => {
    vi.spyOn(bff.configs, 'settings')
      .mockResolvedValue({ theme: null, timeDefaults: null, alert: null });

    const store = useThemeStore();
    await store.loadOrgDefault();

    expect(store.orgDefault).toBeNull();
    expect(store.active).toBe('horizon');
  });

  it('ignores a themeId this build does not ship', async () => {
    vi.spyOn(bff.configs, 'settings')
      .mockResolvedValue({ theme: { themeId: 'retired-theme' }, timeDefaults: null, alert: null });

    const store = useThemeStore();
    await store.loadOrgDefault();

    expect(store.orgDefault).toBeNull();
  });

  it('keeps the user override above the org default', async () => {
    localStorage.setItem('horizon:theme:user', 'daybreak');
    vi.spyOn(bff.configs, 'settings')
      .mockResolvedValue({ theme: { themeId: 'obsidian' }, timeDefaults: null, alert: null });

    const store = useThemeStore();
    await store.loadOrgDefault();

    expect(store.orgDefault).toBe('obsidian');
    expect(store.active).toBe('daybreak');
    expect(store.hasUserOverride).toBe(true);
  });
});
