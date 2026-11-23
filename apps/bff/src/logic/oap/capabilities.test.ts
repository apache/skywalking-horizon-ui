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

// Answered by the type a probe actually asks for, so a probe that names the
// wrong type reads as an OAP without it.
const QUERY_TYPE = '__type(name: "Query")';
const TRACE_SCOPE = '__type(name: "TraceScopeCondition")';
const TAG_TYPE = '__type(name: "TagType")';

/** An OAP whose schema carries `fields` and whose storage answers
 *  `supportQueryLogsByKeywords` with `keywords`. Counts the value query so a
 *  test can prove it was skipped. */
function fakeOap(
  fields: string[],
  keywords: boolean | null,
  traceScopeFields: string[] | null = ['traceId', 'segmentId', 'spanId'],
  tagTypes: string[] | null = null,
): { fetch: FetchLike; asks: () => number; documents: string[] } {
  let asks = 0;
  const documents: string[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const query = String(JSON.parse(String(init?.body ?? '{}')).query ?? '');
    documents.push(query);
    if (query.includes(TRACE_SCOPE)) {
      return json({ data: { __type: traceScopeFields ? { inputFields: traceScopeFields.map((name) => ({ name })) } : null } });
    }
    if (query.includes(TAG_TYPE)) {
      return json({ data: { __type: tagTypes ? { enumValues: tagTypes.map((name) => ({ name })) } : null } });
    }
    if (query.includes(QUERY_TYPE)) {
      return json({ data: { __type: { fields: fields.map((name) => ({ name })) } } });
    }
    if (query.includes('supportQueryLogsByKeywords')) {
      asks += 1;
      return json({ data: { supportQueryLogsByKeywords: keywords } });
    }
    return json({ data: {} });
  };
  return { fetch, asks: () => asks, documents };
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
      aiConversations: false,
      logOtlpSpanId: false,
      logTagType: false,
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

  it('reports logs by OTLP span id only where TraceScopeCondition takes otlpSpanId', async () => {
    _resetCapabilitiesCache();
    const withIt = fakeOap(['queryAlarms'], null, ['traceId', 'segmentId', 'spanId', 'otlpSpanId']);
    expect((await getOapCapabilities(config, withIt.fetch)).logOtlpSpanId).toBe(true);
    _resetCapabilitiesCache();
    const without = fakeOap(['queryAlarms'], null);
    expect((await getOapCapabilities(config, without.fetch)).logOtlpSpanId).toBe(false);
    _resetCapabilitiesCache();
    const noType = fakeOap(['queryAlarms'], null, null);
    expect((await getOapCapabilities(config, noType.fetch)).logOtlpSpanId).toBe(false);
  });

  it('reports split log tags only where the TagType enum carries LOG and OTLP_LOG', async () => {
    const withIt = fakeOap(['queryAlarms'], null, undefined, ['LOG', 'OTLP_LOG']);
    expect((await getOapCapabilities(config, withIt.fetch)).logTagType).toBe(true);
    _resetCapabilitiesCache();
    const noType = fakeOap(['queryAlarms'], null);
    expect((await getOapCapabilities(config, noType.fetch)).logTagType).toBe(false);
    _resetCapabilitiesCache();
    const otherValues = fakeOap(['queryAlarms'], null, undefined, ['LOG']);
    expect((await getOapCapabilities(config, otherValues.fetch)).logTagType).toBe(false);
  });

  it('keeps the other capabilities when only the TagType lookup fails', async () => {
    const fetch: FetchLike = async (_url, init) => {
      const query = String(JSON.parse(String(init?.body ?? '{}')).query ?? '');
      if (query.includes(TAG_TYPE)) return new Response('nope', { status: 500 });
      if (query.includes(TRACE_SCOPE)) return json({ data: { __type: { inputFields: [{ name: 'otlpSpanId' }] } } });
      if (query.includes(QUERY_TYPE)) return json({ data: { __type: { fields: [{ name: 'queryAlarms' }] } } });
      return json({ data: {} });
    };
    await expect(getOapCapabilities(config, fetch)).resolves.toMatchObject({
      queryAlarms: true,
      logOtlpSpanId: true,
      logTagType: false,
    });
  });

  it('names __type at most once per document — OAP refuses a second as bad-faith introspection', async () => {
    const oap = fakeOap(['queryAlarms', 'supportQueryLogsByKeywords'], true);
    await getOapCapabilities(config, oap.fetch);
    for (const doc of oap.documents) expect(doc.match(/__type/g)?.length ?? 0, doc).toBeLessThanOrEqual(1);
  });

  it('keeps the other capabilities when only the TraceScopeCondition lookup fails', async () => {
    const fetch: FetchLike = async (_url, init) => {
      const query = String(JSON.parse(String(init?.body ?? '{}')).query ?? '');
      if (query.includes(TRACE_SCOPE)) return new Response('nope', { status: 500 });
      if (query.includes(QUERY_TYPE)) return json({ data: { __type: { fields: [{ name: 'queryAlarms' }] } } });
      return json({ data: {} });
    };
    await expect(getOapCapabilities(config, fetch)).resolves.toEqual({
      queryAlarms: true,
      logKeywords: false,
      aiConversations: false,
      logOtlpSpanId: false,
      logTagType: false,
    });
  });

  it('falls back to all-false when introspection fails', async () => {
    const fetch: FetchLike = async () => new Response('nope', { status: 500 });
    await expect(getOapCapabilities(config, fetch)).resolves.toEqual({
      queryAlarms: false,
      logKeywords: false,
      aiConversations: false,
      logOtlpSpanId: false,
      logTagType: false,
    });
  });

  it('shares ONE introspection between concurrent callers', async () => {
    // A round fires a dozen reads at once. Without a shared flight each probed,
    // and a slow failure landing after a fast success overwrote real
    // capabilities with the conservative all-false — hiding alarm queries and
    // content search for a minute on a backend that supports both.
    const oap = fakeOap(['queryAlarms', 'supportQueryLogsByKeywords'], true);
    const all = await Promise.all(
      Array.from({ length: 6 }, () => getOapCapabilities(config, oap.fetch)),
    );
    for (const caps of all) expect(caps).toEqual({ queryAlarms: true, logKeywords: true, aiConversations: false, logOtlpSpanId: false, logTagType: false });
    expect(oap.asks(), 'each caller ran its own keyword probe').toBe(1);
  });

  it('a cancelled caller stops waiting without poisoning the shared answer', async () => {
    // The caller's signal never reaches the shared flight — whoever arrived
    // first must not cancel a probe the others await — so a caller that gives
    // up rejects on its own while the probe completes and caches what it read.
    const ac = new AbortController();
    ac.abort();
    const oap = fakeOap(['queryAlarms', 'supportQueryLogsByKeywords'], true);
    await expect(getOapCapabilities(config, oap.fetch, ac.signal)).rejects.toThrow();
    await expect(getOapCapabilities(config, oap.fetch)).resolves.toEqual({
      queryAlarms: true,
      logKeywords: true,
      aiConversations: false,
      logOtlpSpanId: false,
      logTagType: false,
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
      if (query.includes(QUERY_TYPE)) {
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

  it.each([QUERY_TYPE, TAG_TYPE])('backs off a full minute after a %s lookup that was slow to fail', async (slow) => {
    // The lookups run one after another; a failure that took a minute to come
    // back must not be stored already expired, or the next request probes again.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    let probes = 0;
    let failing = true;
    const fetch: FetchLike = async (_url, init) => {
      const query = String(JSON.parse(String(init?.body ?? '{}')).query ?? '');
      if (query.includes(QUERY_TYPE)) probes += 1;
      if (failing && query.includes(slow)) {
        vi.setSystemTime(Date.now() + 65_000);
        throw new Error('timeout');
      }
      if (query.includes(QUERY_TYPE)) return json({ data: { __type: { fields: [] } } });
      if (query.includes(TAG_TYPE)) return json({ data: { __type: { enumValues: [{ name: 'LOG' }, { name: 'OTLP_LOG' }] } } });
      return json({ data: { __type: null } });
    };
    expect((await getOapCapabilities(config, fetch)).logTagType).toBe(false);
    vi.setSystemTime(Date.now() + 30_000);
    await getOapCapabilities(config, fetch);
    expect(probes, 'probed again inside the minute').toBe(1);
    // A minute after the failure was stored — not five — it asks again.
    failing = false;
    vi.setSystemTime(Date.now() + 31_000);
    expect((await getOapCapabilities(config, fetch)).logTagType).toBe(true);
    expect(probes).toBe(2);
  });

  it('probes the new OAP on the next request after Horizon is repointed', async () => {
    // A hot reload of `oap.queryUrl`: the old OAP's answer must not be sent to
    // the new one, which may reject what the old one accepted.
    const newer = fakeOap(['queryAlarms'], null, undefined, ['LOG', 'OTLP_LOG']);
    expect((await getOapCapabilities(config, newer.fetch)).logTagType).toBe(true);
    const older = fakeOap([], null, null, null);
    const repointed = { oap: { queryUrl: 'http://older-oap:12800' } } as unknown as HorizonConfig;
    await expect(getOapCapabilities(repointed, older.fetch)).resolves.toMatchObject({ queryAlarms: false, logTagType: false });
    expect(older.documents.length).toBeGreaterThan(0);
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
