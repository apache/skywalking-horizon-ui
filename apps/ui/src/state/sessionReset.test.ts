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
 * Nothing an operator's session read may outlive that session. Every
 * registrant is exercised through the ONE seam the auth store calls, because
 * a cache that forgets to register is exactly the failure this guards.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { queryClient } from '@/api/queryClient';
import { pushEvent, useEventLog } from '@/controls/eventLog';
import { ensureConfigBundle, useConfigBundle } from '@/controls/configBundle';
import { useAiConversations } from '@/ai/useAiConversations';
import { onSessionReset, resetSessionState } from './sessionReset';

describe('resetSessionState — the Vue Query cache', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    queryClient.clear();
  });

  it('REMOVES cached responses rather than marking them stale', () => {
    queryClient.setQueryData(['services', 'GENERAL'], [{ name: 'payments' }]);
    queryClient.setQueryData(['alarms'], { msgs: [{ id: 'a1' }] });

    resetSessionState();

    expect(queryClient.getQueryData(['services', 'GENERAL'])).toBeUndefined();
    expect(queryClient.getQueryData(['alarms'])).toBeUndefined();
    // Not merely invalidated: an invalidated `staleTime: Infinity` query would
    // still hand its data to the next observer that mounts.
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it('a request in flight under the old identity cannot repopulate the cache', async () => {
    let release: (rows: unknown) => void = () => {};
    const inFlight = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const fetching = queryClient
      .fetchQuery({ queryKey: ['traces'], queryFn: () => inFlight })
      .catch(() => undefined);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(1);

    resetSessionState();
    // The old session's response lands AFTER the identity changed.
    release([{ traceId: 'user-a-trace' }]);
    await fetching;

    expect(queryClient.getQueryData(['traces'])).toBeUndefined();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it('drops the debug event log (the previous session\'s routes and API errors)', () => {
    pushEvent('route', 'info', 'Navigated to /layer/GENERAL/trace');
    expect(useEventLog().all.value).not.toHaveLength(0);

    resetSessionState();

    expect(useEventLog().all.value).toHaveLength(0);
  });

  it('runs every registered module reset', () => {
    const spy = vi.fn();
    onSessionReset(spy);

    resetSessionState();
    resetSessionState();

    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('resetSessionState — the config bundle', () => {
  const bundle = {
    etag: 'W/"1"',
    generatedAt: 1,
    layers: { general: { service: [] } },
    overviews: [],
    syncStatus: {
      mode: 'live',
      unreachable: false,
      lastSuccessfulSyncAt: 1,
      generatedAt: 1,
      badges: [],
      conflicts: [],
    },
  };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    fetchMock = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => bundle,
    }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drops the loaded bundle AND its one-shot load, so the next session re-reads it', async () => {
    await ensureConfigBundle();
    expect(useConfigBundle().bundle.value).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resetSessionState();
    expect(useConfigBundle().bundle.value).toBeNull();
    expect(useConfigBundle().loaded.value).toBe(false);

    await ensureConfigBundle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('resetSessionState — the AI transcript', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('drops the in-memory conversations the previous operator was reading', () => {
    const conv = useAiConversations();
    conv.newChat();
    expect(conv.conversations.value).toHaveLength(1);
    expect(conv.currentId.value).not.toBeNull();

    resetSessionState();

    expect(conv.conversations.value).toHaveLength(0);
    expect(conv.currentId.value).toBeNull();
    expect(conv.current.value).toBeNull();
  });
});
