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
 * Who is allowed to end an OAP request.
 *
 * Two parties, and the mistake in either direction costs something real. If the
 * caller's cancellation is ignored, the BFF finishes reads nobody is listening
 * to — a refresh round that gave up after its cap cancelled the browser's
 * socket while the queries it started ran on, and on a cluster fan-out that is
 * one abandoned request multiplied by the node count. If the caller's signal
 * REPLACES the client's own timeout, a slow OAP has nothing cutting it off at
 * all whenever a caller happens to supply one.
 */

import { describe, expect, it, vi } from 'vitest';
import { buildOapOpts, graphqlPost } from './graphql.js';
import type { HorizonConfig } from '../config/schema.js';

/** A fetch that never answers until the request is aborted. */
function hangingFetch(): typeof globalThis.fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        return;
      }
      signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    })) as unknown as typeof globalThis.fetch;
}

const opts = (timeoutMs: number, signal?: AbortSignal) => ({
  queryUrl: 'http://oap.test:12800',
  timeoutMs,
  fetch: hangingFetch(),
  ...(signal ? { signal } : {}),
});

describe('a caller can cancel an OAP read', () => {
  it('ends the request when the caller gives up', async () => {
    const ac = new AbortController();
    const inFlight = graphqlPost(opts(60_000, ac.signal), '{ ping }');

    ac.abort();

    await expect(inFlight, 'the caller gave up and the read carried on').rejects.toThrow();
  });

  it('still enforces its OWN timeout when a caller signal is present', async () => {
    vi.useFakeTimers();
    try {
      // A caller that never cancels must not disarm the timeout protecting
      // against a slow OAP.
      const never = new AbortController();
      const inFlight = graphqlPost(opts(50, never.signal), '{ ping }');
      const settled = expect(inFlight).rejects.toThrow();

      await vi.advanceTimersByTimeAsync(60);

      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it('enforces its own timeout when there is no caller signal at all', async () => {
    vi.useFakeTimers();
    try {
      const inFlight = graphqlPost(opts(50), '{ ping }');
      const settled = expect(inFlight).rejects.toThrow();

      await vi.advanceTimersByTimeAsync(60);

      await settled;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('buildOapOpts carries the caller through', () => {
  const cfg = {
    oap: { queryUrl: 'http://oap.test:12800', timeoutMs: 1234, auth: undefined },
  } as unknown as HorizonConfig;

  it('passes a signal when a read route supplies one', () => {
    const ac = new AbortController();
    expect(buildOapOpts(cfg, undefined, ac.signal).signal).toBe(ac.signal);
  });

  // Background timers and anything that MUTATES pass nothing: a closed tab must
  // not be able to cancel a profiling task half-created, or a template push
  // half-applied.
  it('leaves it absent otherwise', () => {
    expect(buildOapOpts(cfg).signal).toBeUndefined();
  });
});
