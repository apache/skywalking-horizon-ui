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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from './runtime-rule.js';
import { TracePairingDebuggingClient } from './trace-pairing-debugging.js';
import { RuntimeRuleApiError } from './types.js';

/** A body that never arrives unless the request is aborted. */
function stalledBody(init: RequestInit | undefined): Response {
  return {
    ok: true,
    status: 200,
    json: () =>
      new Promise((_, reject) => {
        if (init?.signal?.aborted) reject(new Error('aborted'));
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    text: async () => '',
  } as unknown as Response;
}

describe('TracePairingDebuggingClient', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads the pairings with the limit asked for', async () => {
    const urls: string[] = [];
    const fetch: FetchLike = async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ state: 'off' }), { status: 200 });
    };
    const client = new TracePairingDebuggingClient({ adminUrl: 'http://oap:17128/', fetch });
    expect(await client.getPairings(5)).toEqual({ state: 'off' });
    expect(urls).toEqual(['http://oap:17128/trace-pairing-debugging/pairings?limit=5']);
  });

  it('turns an error answer into an API error with its body', async () => {
    const fetch: FetchLike = async () => new Response(JSON.stringify({ code: 'invalid_param', message: 'limit' }), { status: 400 });
    const client = new TracePairingDebuggingClient({ adminUrl: 'http://oap:17128', fetch });
    await expect(client.getPairings(0)).rejects.toBeInstanceOf(RuntimeRuleApiError);
  });

  it('times out a body that stalls, not only a request that does not answer', async () => {
    const fetch: FetchLike = async (_url, init) => stalledBody(init);
    const client = new TracePairingDebuggingClient({ adminUrl: 'http://oap:17128', fetch, timeoutMs: 1000 });
    const read = client.getPairings();
    const settled = expect(read).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(1000);
    await settled;
  });

  it('stops a read its caller abandons, the timeout joined with the caller signal', async () => {
    const fetch: FetchLike = async (_url, init) => stalledBody(init);
    const client = new TracePairingDebuggingClient({ adminUrl: 'http://oap:17128', fetch, timeoutMs: 60_000 });
    const left = new AbortController();
    const read = client.getPairings(undefined, left.signal);
    const settled = expect(read).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(0);
    left.abort();
    await settled;
  });
});
