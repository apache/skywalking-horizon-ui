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
 * The TraceQL surface, asserted where it differs from every other OAP call.
 *
 * Three of these are invariants rather than behaviours, and each has a way of
 * failing silently: a window sent in milliseconds asks for 1970, an encoded
 * trace id that escapes the BFF makes a copy-paste fail somewhere else, and an
 * absent error flag rendered as `false` paints failed traces green.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import {
  buildTraceQLOpts,
  decodeNativeTraceId,
  encodeNativeTraceId,
  focusServiceOf,
  traceqlSearch,
  traceqlTraceById,
  wireTraceId,
} from '../../client/traceql.js';
import { resetTraceQLAvailability } from '../../logic/traceql/availability.js';
import { registerTraceQLRoutes } from './traceql.js';

const NATIVE_URL = 'http://oap.test:3200/skywalking';
const ZIPKIN_URL = 'http://oap.test:3200/zipkin';

/** A real id from the demo, in both shapes OAP actually emits. */
const DOTTED = '7ac11a5bf004469780c148737a161cb2.38.17897214704563381';
const UUID = 'f665e3ef-a5c9-4afe-a6be-12f92caf227a';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function cfgWith(traceql: { nativeUrl?: string; zipkinUrl?: string }): ReturnType<typeof configSchema.parse> {
  return configSchema.parse({ oap: { traceql } });
}

function attr(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

/** One trace, three spans, two services — the shape `/api/search` returns. */
function searchBody() {
  const t0 = 1_700_000_000_000;
  const span = (svc: string, offsetMs: number, durMs: number, extra: Array<{ key: string; value: { stringValue: string } }> = []) => ({
    spanID: `${svc}-${offsetMs}`,
    startTimeUnixNano: String((t0 + offsetMs) * 1e6),
    durationNanos: String(durMs * 1e6),
    attributes: [attr('service.name', svc), attr('span.kind', 'SPAN_KIND_SERVER'), ...extra],
  });
  return {
    traces: [
      {
        traceID: encodeNativeTraceId(DOTTED),
        rootServiceName: 'agent::ui',
        rootTraceName: '/homepage',
        startTimeUnixNano: String(t0 * 1e6),
        durationMs: 74,
        spanSets: [{ spans: [span('agent::ui', 0, 74), span('agent::songs', 16, 7), span('agent::songs', 40, 2)], matched: 3 }],
      },
    ],
  };
}

describe('trace ids: the encoded form never crosses the BFF boundary', () => {
  it('round-trips both id shapes OAP emits', () => {
    for (const id of [DOTTED, UUID]) {
      expect(decodeNativeTraceId(encodeNativeTraceId(id))).toBe(id);
    }
  });

  it('always encodes on the way out, without guessing at the input', () => {
    // A heuristic that tried to spot an already-encoded id both corrupted
    // valid ids that happened to look hex and missed ids outside its
    // invented alphabet. Encoding unconditionally is the contract: the
    // caller holds a real id.
    expect(wireTraceId('native', DOTTED)).toBe(encodeNativeTraceId(DOTTED));
    expect(wireTraceId('native', '31323334353637383930616263646566')).toBe(
      encodeNativeTraceId('31323334353637383930616263646566'),
    );
  });

  it('leaves Zipkin ids untouched — they are already hex', () => {
    const zipkinId = '439af3ead82dff2f0e6aa92ed7167090';
    expect(wireTraceId('zipkin', zipkinId)).toBe(zipkinId);
    expect(decodeNativeTraceId('not-hex-at-all')).toBe('not-hex-at-all');
  });

  it('sends the encoded id and answers with the real one', async () => {
    let asked = '';
    const fetch: FetchLike = async (url) => {
      asked = String(url);
      return json({
        trace: {
          resourceSpans: [
            {
              resource: { attributes: [attr('service.name', 'agent::songs')] },
              scopeSpans: [
                {
                  spans: [
                    {
                      // OAP stamps the ENCODED id on every span, while the span
                      // id beside it stays raw.
                      traceId: encodeNativeTraceId(DOTTED),
                      spanId: `${DOTTED}S0`,
                      name: 'GET:/songs',
                      kind: 'SPAN_KIND_SERVER',
                      startTimeUnixNano: '1700000000000000000',
                      endTimeUnixNano: '1700000000004000000',
                      status: { code: 'STATUS_CODE_OK' },
                    },
                  ],
                },
              ],
            },
          ],
        },
      });
    };
    const opts = buildTraceQLOpts(cfgWith({ nativeUrl: NATIVE_URL }), 'native', fetch)!;
    const detail = await traceqlTraceById(opts, DOTTED);
    expect(asked).toContain(encodeNativeTraceId(DOTTED));
    expect(asked).not.toContain(DOTTED);
    expect(detail?.traceId).toBe(DOTTED);
    expect(detail?.spans[0]?.spanId).toBe(`${DOTTED}S0`);
    expect(detail?.spans[0]?.durationUs).toBe(4000);
  });

  it('reads a 404 as "not there" rather than as a failure', async () => {
    const fetch: FetchLike = async () => new Response('', { status: 404 });
    const opts = buildTraceQLOpts(cfgWith({ nativeUrl: NATIVE_URL }), 'native', fetch)!;
    await expect(traceqlTraceById(opts, DOTTED)).resolves.toBeNull();
  });
});

describe('search: the window is seconds, and the rows are reduced', () => {
  it('converts the window to seconds', async () => {
    let asked: URL | null = null;
    const fetch: FetchLike = async (url) => {
      asked = new URL(String(url));
      return json({ traces: [] });
    };
    const opts = buildTraceQLOpts(cfgWith({ nativeUrl: NATIVE_URL }), 'native', fetch)!;
    await traceqlSearch(opts, { q: '{}', startMs: 1_700_000_000_000, endMs: 1_700_000_600_000, limit: 20 });
    expect(asked!.searchParams.get('start')).toBe('1700000000');
    expect(asked!.searchParams.get('end')).toBe('1700000600');
  });

  it('keeps the summary and drops the spans, which have no cap upstream', async () => {
    const fetch: FetchLike = async () => json(searchBody());
    const opts = buildTraceQLOpts(cfgWith({ nativeUrl: NATIVE_URL }), 'native', fetch)!;
    const [row] = await traceqlSearch(opts, {
      q: '{resource.service.name="agent::songs"}',
      startMs: 1,
      endMs: 2,
      limit: 20,
    });
    expect(row!.traceId).toBe(DOTTED);
    expect(row!.rootService).toBe('agent::ui');
    expect(row!.spanCount).toBe(3);
    expect(row!.services).toEqual(['agent::ui', 'agent::songs']);
    expect(row).not.toHaveProperty('spans');
  });

  it('reports the queried service’s FIRST span, not a sum of its spans', async () => {
    const fetch: FetchLike = async () => json(searchBody());
    const opts = buildTraceQLOpts(cfgWith({ nativeUrl: NATIVE_URL }), 'native', fetch)!;
    const [row] = await traceqlSearch(opts, {
      q: '{resource.service.name="agent::songs"}',
      startMs: 1,
      endMs: 2,
      limit: 20,
    });
    expect(row!.serviceEntry).toEqual({
      service: 'agent::songs',
      offsetMs: 16,
      durationMs: 7,
      kind: 'SPAN_KIND_SERVER',
    });
  });

  it('has no service entry when the query names no service', async () => {
    const fetch: FetchLike = async () => json(searchBody());
    const opts = buildTraceQLOpts(cfgWith({ nativeUrl: NATIVE_URL }), 'native', fetch)!;
    const [row] = await traceqlSearch(opts, { q: '{duration>1ms}', startMs: 1, endMs: 2, limit: 20 });
    expect(row!.serviceEntry).toBeUndefined();
  });

  it('reads the service out of either spelling the backend honours', () => {
    expect(focusServiceOf('{resource.service.name="a"}')).toBe('a');
    expect(focusServiceOf('{.service.name="b" && duration>1ms}')).toBe('b');
    expect(focusServiceOf('{resource.service="c"}')).toBe('c');
    expect(focusServiceOf('{duration>1ms}')).toBeNull();
    expect(focusServiceOf(undefined)).toBeNull();
  });

  it('leaves the error flag ABSENT on native, and answers it on Zipkin', async () => {
    const fetch: FetchLike = async () => json(searchBody());
    const native = buildTraceQLOpts(cfgWith({ nativeUrl: NATIVE_URL }), 'native', fetch)!;
    const [nativeRow] = await traceqlSearch(native, { startMs: 1, endMs: 2, limit: 5 });
    // The native search carries no failure marker at all. Rendering `false`
    // here would paint every failed trace as a success.
    expect(nativeRow!.isError).toBeUndefined();

    const withError: FetchLike = async () => {
      const body = searchBody();
      body.traces[0]!.spanSets[0]!.spans[0]!.attributes.push(attr('error', 'true'));
      return json(body);
    };
    const zipkin = buildTraceQLOpts(cfgWith({ zipkinUrl: ZIPKIN_URL }), 'zipkin', withError)!;
    const [zipkinRow] = await traceqlSearch(zipkin, { startMs: 1, endMs: 2, limit: 5 });
    expect(zipkinRow!.isError).toBe(true);
  });
});

describe('the routes', () => {
  beforeEach(() => resetTraceQLAvailability());

  async function build(fetchImpl: FetchLike, traceql: { nativeUrl?: string; zipkinUrl?: string }) {
    const cfg = cfgWith(traceql);
    const config: ConfigSource = {
      current: cfg,
      current_: () => cfg,
      path: '',
      onChange: () => () => {},
      close: async () => {},
    };
    const sessions = new SessionStore({ ttlMinutes: 60 });
    const app: FastifyInstance = Fastify();
    await app.register(cookie);
    app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
    registerTraceQLRoutes(app, { config, sessions, fetch: fetchImpl } as unknown as Parameters<typeof registerTraceQLRoutes>[1]);
    await app.ready();
    return { app, sid: sessions.create('op', ['admin']).sid };
  }

  const get = async (app: FastifyInstance, sid: string, url: string) =>
    (await app.inject({ method: 'GET', url, headers: { cookie: `horizon_sid=${sid}` } })).json();

  it('reports an unconfigured source instead of omitting it', async () => {
    const { app, sid } = await build(async () => json({}), { nativeUrl: NATIVE_URL });
    const sources = await get(app, sid, '/api/traceql/sources');
    expect(sources).toMatchObject([
      { ds: 'native', configured: true },
      { ds: 'zipkin', configured: false, reachable: false },
    ]);
  });

  it('serves nothing, reachable false, when the source has no URL', async () => {
    const { app, sid } = await build(async () => json({}), {});
    const out = await get(app, sid, '/api/traceql/native/search?startMs=1&endMs=2');
    expect(out).toMatchObject({ ds: 'native', traces: [], reachable: false });
  });

  it('passes OAP’s own message through when it refuses an expression', async () => {
    const fetch: FetchLike = async () => json({ error: 'maxDuration is only valid with minDuration' }, 400);
    const { app, sid } = await build(fetch, { zipkinUrl: ZIPKIN_URL });
    const out = await get(app, sid, '/api/traceql/zipkin/search?startMs=1&endMs=2&q=%7Bduration%3C1s%7D');
    // A refused expression is an answer, not an outage: the source is up and
    // the editor shows what it said.
    expect(out.reachable).toBe(true);
    expect(out.error).toContain('maxDuration is only valid with minDuration');
  });

  it('flags a full page as capped, because there is no paging to offer', async () => {
    const rows = (n: number) => ({
      traces: Array.from({ length: n }, (_, i) => ({
        traceID: encodeNativeTraceId(`${DOTTED}${i}`),
        rootServiceName: 's',
        rootTraceName: 'n',
        startTimeUnixNano: '1700000000000000000',
        durationMs: 1,
        spanSets: [{ spans: [], matched: 0 }],
      })),
    });
    const { app, sid } = await build(async () => json(rows(3)), { nativeUrl: NATIVE_URL });
    expect(await get(app, sid, '/api/traceql/native/search?startMs=1&endMs=2&limit=3')).toMatchObject({ capped: true });
    expect(await get(app, sid, '/api/traceql/native/search?startMs=1&endMs=2&limit=4')).toMatchObject({ capped: false });
  });

  it('refuses a datasource it does not serve', async () => {
    const { app, sid } = await build(async () => json({}), { nativeUrl: NATIVE_URL });
    const res = await app.inject({
      method: 'GET',
      url: '/api/traceql/otlp/search?startMs=1&endMs=2',
      headers: { cookie: `horizon_sid=${sid}` },
    });
    expect(res.statusCode).toBe(400);
  });
});
