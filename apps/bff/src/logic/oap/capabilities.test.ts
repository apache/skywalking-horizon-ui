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
import { getOapCapabilities, _resetCapabilitiesCache } from './capabilities.js';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** An OAP whose schema carries `fields` and whose storage answers
 *  `supportQueryLogsByKeywords` with `keywords`. Counts the value query so a
 *  test can prove it was skipped. */
function fakeOap(fields: string[], keywords: boolean | null): { fetch: FetchLike; asks: () => number } {
  let asks = 0;
  const fetch: FetchLike = async (_url, init) => {
    const query = String(JSON.parse(String(init?.body ?? '{}')).query ?? '');
    if (query.includes('__type')) {
      return json({ data: { __type: { fields: fields.map((name) => ({ name })) } } });
    }
    if (query.includes('supportQueryLogsByKeywords')) {
      asks += 1;
      return json({ data: { supportQueryLogsByKeywords: keywords } });
    }
    return json({ data: {} });
  };
  return { fetch, asks: () => asks };
}

const config = { oap: { queryUrl: 'http://oap:12800' } } as unknown as HorizonConfig;

describe('OAP capability probe', () => {
  beforeEach(() => _resetCapabilitiesCache());
  afterEach(() => vi.useRealTimers());

  it('reports content search on a storage that answers yes', async () => {
    const oap = fakeOap(['queryAlarms', 'supportQueryLogsByKeywords'], true);
    await expect(getOapCapabilities(config, oap.fetch)).resolves.toEqual({
      queryAlarms: true,
      logKeywords: true,
    });
  });

  it('reports no content search on a storage that answers no', async () => {
    // BanyanDB: the field is in the schema, the answer is false. Offering the
    // input here would send a condition OAP accepts and ignores.
    const oap = fakeOap(['queryAlarms', 'supportQueryLogsByKeywords'], false);
    const caps = await getOapCapabilities(config, oap.fetch);
    expect(caps.logKeywords).toBe(false);
    expect(oap.asks()).toBe(1);
  });

  it('never asks an OAP whose schema lacks the field', async () => {
    // Naming an unknown field fails the whole document, so the value query is
    // guarded by the schema result rather than tried and caught.
    const oap = fakeOap(['queryAlarms'], true);
    const caps = await getOapCapabilities(config, oap.fetch);
    expect(caps.logKeywords).toBe(false);
    expect(oap.asks()).toBe(0);
  });

  it('falls back to all-false when introspection fails', async () => {
    const fetch: FetchLike = async () => new Response('nope', { status: 500 });
    await expect(getOapCapabilities(config, fetch)).resolves.toEqual({
      queryAlarms: false,
      logKeywords: false,
    });
  });

  it('re-probes soon after a FAILED keyword read, not in five minutes', async () => {
    // A false that came from a timeout must not hide content search for the
    // whole success TTL — one slow reply would cost an ElasticSearch operator
    // five minutes of a missing input.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    let failing = true;
    const fetch: FetchLike = async (_url, init) => {
      const query = String(JSON.parse(String(init?.body ?? '{}')).query ?? '');
      if (query.includes('__type')) {
        return json({ data: { __type: { fields: [{ name: 'supportQueryLogsByKeywords' }] } } });
      }
      if (failing) throw new Error('timeout');
      return json({ data: { supportQueryLogsByKeywords: true } });
    };

    expect((await getOapCapabilities(config, fetch)).logKeywords).toBe(false);

    // Still inside the failure TTL: the cached false stands.
    vi.setSystemTime(new Date('2026-01-01T00:00:30Z'));
    failing = false;
    expect((await getOapCapabilities(config, fetch)).logKeywords).toBe(false);

    // Past it, and well short of the five-minute success TTL.
    vi.setSystemTime(new Date('2026-01-01T00:01:30Z'));
    expect((await getOapCapabilities(config, fetch)).logKeywords).toBe(true);
  });

  it('does not re-probe a storage that ANSWERED no', async () => {
    // A definite no is durable — it changes only when OAP restarts.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const oap = fakeOap(['supportQueryLogsByKeywords'], false);
    await getOapCapabilities(config, oap.fetch);
    vi.setSystemTime(new Date('2026-01-01T00:02:00Z'));
    await getOapCapabilities(config, oap.fetch);
    expect(oap.asks()).toBe(1);
  });

  it('treats a null answer as no', async () => {
    const oap = fakeOap(['supportQueryLogsByKeywords'], null);
    const caps = await getOapCapabilities(config, oap.fetch);
    expect(caps.logKeywords).toBe(false);
  });
});
