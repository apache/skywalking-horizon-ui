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
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import type { HorizonConfig } from '../../config/schema.js';
import { _resetBackendCache, getOapBackend } from './backend.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const at = (queryUrl: string) => ({ oap: { queryUrl } }) as unknown as HorizonConfig;

/** A TTL answer that reads as BanyanDB (per-class TTLs differ) or not. */
function ttlOap(banyandb: boolean): { fetch: FetchLike; asks: () => number } {
  let asks = 0;
  const fetch: FetchLike = async () => {
    asks += 1;
    const t = banyandb ? 3 : 7;
    return json({
      data: {
        records: { normal: 7, trace: t, zipkinTrace: 7, log: 7, browserErrorLog: 7, coldNormal: -1, coldTrace: -1, coldZipkinTrace: -1, coldLog: -1, coldBrowserErrorLog: -1 },
        metrics: { metadata: 7, minute: 7, hour: 7, day: 7, coldMinute: -1, coldHour: -1, coldDay: -1 },
      },
    });
  };
  return { fetch, asks: () => asks };
}

describe('OAP storage backend probe', () => {
  beforeEach(() => _resetBackendCache());
  afterEach(() => vi.useRealTimers());

  it('probes the new OAP on the next request after Horizon is repointed', async () => {
    const first = ttlOap(true);
    expect(await getOapBackend(at('http://oap-a:12800'), first.fetch)).toBe('banyandb');
    expect(await getOapBackend(at('http://oap-a:12800'), first.fetch)).toBe('banyandb');
    expect(first.asks()).toBe(1);
    const second = ttlOap(false);
    expect(await getOapBackend(at('http://oap-b:12800'), second.fetch)).toBe('other');
    expect(second.asks()).toBe(1);
  });

  it('backs off a full minute after a probe that was slow to fail, then asks again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    let asks = 0;
    const recovered = ttlOap(true);
    let failing = true;
    const slow: FetchLike = async (url, init) => {
      asks += 1;
      if (!failing) return recovered.fetch(url, init);
      vi.setSystemTime(Date.now() + 65_000);
      throw new Error('timeout');
    };
    expect(await getOapBackend(at('http://oap-a:12800'), slow)).toBe('unknown');
    vi.setSystemTime(Date.now() + 30_000);
    await getOapBackend(at('http://oap-a:12800'), slow);
    expect(asks, 'probed again inside the minute').toBe(1);
    failing = false;
    vi.setSystemTime(Date.now() + 31_000);
    expect(await getOapBackend(at('http://oap-a:12800'), slow)).toBe('banyandb');
    expect(asks).toBe(2);
  });

  it('shares one probe between concurrent callers', async () => {
    // Each poll probing on its own let a slow failure from one node replace
    // the answer another had just given.
    const oap = ttlOap(true);
    const all = await Promise.all(Array.from({ length: 5 }, () => getOapBackend(at('http://oap-a:12800'), oap.fetch)));
    expect(all).toEqual(Array(5).fill('banyandb'));
    expect(oap.asks()).toBe(1);
  });
});
