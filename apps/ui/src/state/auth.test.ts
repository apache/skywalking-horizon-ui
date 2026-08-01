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
 * The three ways a session ends or begins in one tab — sign out, sign in, and
 * a 401 that ends it server-side mid-flight — must each leave the query cache
 * empty. Otherwise the next operator on that tab is served the previous one's
 * services, alarms, traces and dashboards.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { bffClient, type MeResponse } from '@/api/client';
import { queryClient } from '@/api/queryClient';
import { useAuthStore } from './auth';

const USER_A: MeResponse = { username: 'alice', roles: ['admin'], verbs: ['*'] };
const USER_B: MeResponse = { username: 'bob', roles: ['viewer'], verbs: ['dashboard:read'] };

/** What user A's session left in the cache — service list, alarms, a trace. */
function seedCacheFromUserA(): void {
  queryClient.setQueryData(['layer-services', 'GENERAL'], [{ id: 'svc.1', name: 'payments' }]);
  queryClient.setQueryData(['alarms', 'GENERAL'], { msgs: [{ id: 'alarm-1' }] });
  queryClient.setQueryData(['trace', 'abc'], { spans: [{ operationName: '/checkout' }] });
}

describe('auth store — no cached data survives an identity change', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    queryClient.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logout empties the cache', async () => {
    vi.spyOn(bffClient.session, 'logout').mockResolvedValue({ status: 'ok' });
    const auth = useAuthStore();
    auth.user = USER_A;
    seedCacheFromUserA();

    await auth.logout();

    expect(auth.user).toBeNull();
    expect(queryClient.getQueryData(['layer-services', 'GENERAL'])).toBeUndefined();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it('logout empties the cache even when the BFF call fails', async () => {
    vi.spyOn(bffClient.session, 'logout').mockRejectedValue(new Error('network down'));
    const auth = useAuthStore();
    auth.user = USER_A;
    seedCacheFromUserA();

    await auth.logout();

    expect(auth.user).toBeNull();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it('a fresh login starts empty — user B never reads what user A cached', async () => {
    const auth = useAuthStore();
    // The tab still holds user A's data: a logout that never reached the BFF,
    // or a session that expired while the tab was backgrounded.
    seedCacheFromUserA();
    vi.spyOn(bffClient.session, 'login').mockImplementation(async () => {
      // By the time the new identity is established, nothing of A's is left.
      expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
      return USER_B;
    });

    await expect(auth.login('bob', 'pw')).resolves.toBe(true);

    expect(auth.user).toEqual(USER_B);
    expect(queryClient.getQueryData(['alarms', 'GENERAL'])).toBeUndefined();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it('a mid-session 401 drops the identity AND its cached data', () => {
    const auth = useAuthStore();
    auth.user = USER_A;
    seedCacheFromUserA();

    // What the BFF client's 401 hook calls.
    auth.endSession();

    expect(auth.user).toBeNull();
    expect(queryClient.getQueryData(['trace', 'abc'])).toBeUndefined();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });
});
