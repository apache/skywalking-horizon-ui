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
 * Where the org-default time window comes from — same contract as the theme:
 * an auth-gated org-settings read every signed-in user can make, and the
 * in-code 60 minutes when the BFF resolved no value.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { bff } from '@/api/client';
import { useTimeDefaultsStore } from './timeDefaults';

describe('time-defaults store — org default', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('reads the window the BFF resolved, without touching the admin template rows', async () => {
    const settings = vi
      .spyOn(bff.configs, 'settings')
      .mockResolvedValue({ theme: null, timeDefaults: { defaultWindowMinutes: 15 }, alert: null });
    const syncStatus = vi.spyOn(bff.templateSync, 'syncStatus');

    const store = useTimeDefaultsStore();
    await store.loadOrgDefault();

    expect(store.orgDefault).toBe(15);
    expect(store.defaultWindowMinutes).toBe(15);
    expect(settings).toHaveBeenCalledTimes(1);
    expect(syncStatus).not.toHaveBeenCalled();
  });

  it('has no org default when the BFF resolved no value', async () => {
    vi.spyOn(bff.configs, 'settings')
      .mockResolvedValue({ theme: null, timeDefaults: null, alert: null });

    const store = useTimeDefaultsStore();
    await store.loadOrgDefault();

    expect(store.orgDefault).toBeNull();
    expect(store.defaultWindowMinutes).toBe(60);
  });

  it('ignores a window that is not a positive integer', async () => {
    vi.spyOn(bff.configs, 'settings')
      .mockResolvedValue({ theme: null, timeDefaults: { defaultWindowMinutes: -5 }, alert: null });

    const store = useTimeDefaultsStore();
    await store.loadOrgDefault();

    expect(store.orgDefault).toBeNull();
  });

  it('keeps the user override above the org default', async () => {
    localStorage.setItem('horizon:time-defaults:user', '240');
    vi.spyOn(bff.configs, 'settings')
      .mockResolvedValue({ theme: null, timeDefaults: { defaultWindowMinutes: 15 }, alert: null });

    const store = useTimeDefaultsStore();
    await store.loadOrgDefault();

    expect(store.defaultWindowMinutes).toBe(240);
    expect(store.hasUserOverride).toBe(true);
  });
});
