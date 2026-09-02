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

/**
 * The same table `apps/bff/src/rbac/verbs.test.ts` asserts, run through the
 * UI's copy of the matcher. Three copies of it exist — this store, the Roles
 * board, and the BFF — and they diverged together once: a malformed grant
 * (`rule:*:typo`) read as the area wildcard on all three, so the sidebar
 * offered pages the server would have allowed too. Pin them to one answer.
 */
const MATCHER_CASES: ReadonlyArray<[string, string, boolean]> = [
  ['rule:*:typo', 'rule:delete', false],
  ['rule:*:typo', 'rule:write:structural', false],
  ['rule:write:structural:extra', 'rule:write:structural', false],
  ['metrics:read:typo', 'metrics:read', false],
  ['*:read:typo', 'metrics:read', false],
  ['rule:*', 'rule:delete', true],
  ['rule:*', 'rule:write:structural', true],
  ['rule:write:structural', 'rule:write:structural', true],
  ['rule:write:structural', 'rule:write', false],
  ['*:read', 'metrics:read', true],
  ['metrics:*', 'metrics:read', true],
  ['metrics:read', 'metrics:read', true],
  ['*:read', 'audit:read', false],
  ['audit:*', 'audit:read', false],
  ['audit:read', 'audit:read', true],
  ['*', 'audit:read', true],
  ['admin', 'audit:read', true],
];

describe('the auth store answers the verb grammar exactly as the BFF does', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it.each(MATCHER_CASES)('%s grants %s → %s', (grant, required, expected) => {
    const auth = useAuthStore();
    auth.user = { username: 'u', roles: ['r'], verbs: [grant] } as MeResponse;
    expect(auth.hasVerb(required)).toBe(expected);
  });
});
