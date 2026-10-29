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

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { resetTraceQLAvailability } from '../../logic/traceql/availability.js';
import { resolveEffectiveLayer } from '../../logic/layers/effective.js';
import { registerTraceQLRoutes } from './traceql.js';

vi.mock('../../logic/layers/effective.js', () => ({ resolveEffectiveLayer: vi.fn() }));

/**
 * The OTLP service picker of a layer whose template names a `serviceLayer`: OAP's
 * service catalog narrows it, asked through the TraceQL filter it answers in full.
 */
describe('the OTLP service picker of a layer', () => {
  const WINDOW = 'startMs=1700000000000&endMs=1700000900000';
  let asked: URL[];

  beforeEach(() => {
    resetTraceQLAvailability();
    asked = [];
  });

  async function build(names: string[]) {
    const cfg = configSchema.parse({ oap: { traceql: { url: 'http://oap.test:3200', otlpPath: '/otlp' } } });
    const config: ConfigSource = { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
    const sessions = new SessionStore({ ttlMinutes: 60 });
    const fetchImpl: FetchLike = async (input) => {
      asked.push(new URL(String(input)));
      return new Response(JSON.stringify({ tagValues: names.map((value) => ({ type: 'string', value })) }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };
    const app: FastifyInstance = Fastify();
    await app.register(cookie);
    app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
    registerTraceQLRoutes(app, { config, sessions, fetch: fetchImpl } as unknown as Parameters<typeof registerTraceQLRoutes>[1]);
    await app.ready();
    const sid = sessions.create('op', ['admin']).sid;
    return async (query: string, ds = 'otlp') =>
      (await app.inject({ method: 'GET', url: `/api/traceql/${ds}/tag-values?${WINDOW}&${query}`, headers: { cookie: `horizon_sid=${sid}` } })).json();
  }

  function layerWith(traces: unknown) {
    vi.mocked(resolveEffectiveLayer).mockResolvedValue({ blocked: false, template: { traces } } as never);
  }

  it('asks OAP for the services of the layer the template names', async () => {
    layerWith({ sources: ['traceql-otlp'], stores: { 'traceql-otlp': { serviceLayer: 'OTLP_GENERAL' } } });
    const tagValues = await build(['otel-demo::cart', 'otel-demo::frontend']);

    const body = await tagValues('tag=resource.service.name&layer=OTLP_GENERAL');

    expect(asked[0].searchParams.get('q')).toBe('{resource.service.layer="OTLP_GENERAL"}');
    expect(body.values).toEqual(['otel-demo::cart', 'otel-demo::frontend']);
  });

  it('lists every service of the store when the template names no layer', async () => {
    layerWith({ sources: ['traceql-otlp'] });
    const tagValues = await build(['otel-demo::cart', 'mesh-svr::songs.sample-services']);

    await tagValues('tag=resource.service.name&layer=MESH');

    expect(asked[0].searchParams.get('q')).toBeNull();
  });

  it('narrows the unscoped service tags OAP answers alike', async () => {
    layerWith({ stores: { 'traceql-otlp': { serviceLayer: 'OTLP_GENERAL' } } });
    const tagValues = await build(['otel-demo::cart']);

    for (const tag of ['service.name', '.service.name', '.service', 'resource.service']) {
      await tagValues(`tag=${encodeURIComponent(tag)}&layer=OTLP_GENERAL`);
    }

    expect(asked.map((u) => u.searchParams.get('q'))).toEqual(Array(4).fill('{resource.service.layer="OTLP_GENERAL"}'));
  });

  it('reads the plain service.name as a tag on the other stores, whose catalogs do not answer it', async () => {
    layerWith({ stores: { 'traceql-zipkin': { serviceFilter: { pattern: '^shop-' } } } });
    const tagValues = await build(['shop-cart', 'GET']);

    expect((await tagValues('tag=service.name&layer=GENERAL', 'zipkin')).values).toEqual(['shop-cart', 'GET']);
    expect((await tagValues('tag=.service.name&layer=GENERAL', 'zipkin')).values).toEqual(['shop-cart']);
  });

  it('keeps narrowing by the pattern after the layer', async () => {
    layerWith({ stores: { 'traceql-otlp': { serviceLayer: 'OTLP_GENERAL', serviceFilter: { pattern: '::cart$' } } } });
    const tagValues = await build(['otel-demo::cart', 'otel-demo::frontend']);

    expect((await tagValues('tag=resource.service.name&layer=OTLP_GENERAL')).values).toEqual(['otel-demo::cart']);
  });

  it('leaves other tags and a caller\'s own expression as asked', async () => {
    layerWith({ stores: { 'traceql-otlp': { serviceLayer: 'OTLP_GENERAL' } } });
    const tagValues = await build(['GET /']);

    await tagValues(`tag=name&layer=OTLP_GENERAL&q=${encodeURIComponent('{resource.service.name="otel-demo::cart"}')}`);

    expect(asked[0].searchParams.get('q')).toBe('{resource.service.name="otel-demo::cart"}');
  });

  it('narrows a caller\'s own expression by the layer, and a blank one like none', async () => {
    layerWith({ stores: { 'traceql-otlp': { serviceLayer: 'OTLP_GENERAL' } } });
    const tagValues = await build(['otel-demo::cart']);

    await tagValues(`tag=resource.service.name&layer=OTLP_GENERAL&q=${encodeURIComponent('{ span.http.method="GET" }')}`);
    await tagValues('tag=resource.service.name&layer=OTLP_GENERAL&q=%20');
    await tagValues(`tag=resource.service.name&layer=OTLP_GENERAL&q=${encodeURIComponent('{}')}`);

    expect(asked.map((u) => u.searchParams.get('q'))).toEqual([
      '{span.http.method="GET" && resource.service.layer="OTLP_GENERAL"}',
      '{resource.service.layer="OTLP_GENERAL"}',
      '{resource.service.layer="OTLP_GENERAL"}',
    ]);
  });

  it('serves nothing for a caller\'s expression it cannot narrow, rather than every service', async () => {
    layerWith({ stores: { 'traceql-otlp': { serviceLayer: 'OTLP_GENERAL' } } });
    const tagValues = await build(['otel-demo::cart', 'mesh-svr::songs.sample-services']);

    for (const q of ['{a="1"} && {b="2"}', 'a="1"', '{a="1"']) {
      const body = await tagValues(`tag=resource.service.name&layer=OTLP_GENERAL&q=${encodeURIComponent(q)}`);
      expect(body.values, q).toEqual([]);
    }
    expect(asked).toHaveLength(0);

    await tagValues(`tag=resource.service.name&layer=OTLP_GENERAL&q=${encodeURIComponent('{ name="a}b{" }')}`);
    expect(asked[0].searchParams.get('q')).toBe('{name="a}b{" && resource.service.layer="OTLP_GENERAL"}');

    // OAP's only literal is double-quoted, with backslash escapes; a quote of another kind is not one.
    await tagValues(`tag=resource.service.name&layer=OTLP_GENERAL&q=${encodeURIComponent('{ name="a\\"}" }')}`);
    expect(asked[1].searchParams.get('q')).toBe('{name="a\\"}" && resource.service.layer="OTLP_GENERAL"}');
    const single = await tagValues(`tag=resource.service.name&layer=OTLP_GENERAL&q=${encodeURIComponent("{ name='}' }")}`);
    expect(single.values).toEqual([]);
    expect(asked).toHaveLength(2);
  });

  it('keeps the template\'s layer over one the caller names', async () => {
    layerWith({ stores: { 'traceql-otlp': { serviceLayer: 'OTLP_GENERAL' } } });
    const tagValues = await build(['otel-demo::cart']);

    await tagValues(`tag=resource.service.name&layer=OTLP_GENERAL&q=${encodeURIComponent('{resource.service.layer="OTLP_MESH"}')}`);

    // OAP keeps the last condition on an attribute.
    expect(asked[0].searchParams.get('q'))
      .toBe('{resource.service.layer="OTLP_MESH" && resource.service.layer="OTLP_GENERAL"}');
  });

  it('serves nothing, and asks nothing, when the layer\'s configuration cannot be read', async () => {
    vi.mocked(resolveEffectiveLayer).mockResolvedValue({ blocked: true, template: null } as never);
    const tagValues = await build(['otel-demo::cart']);

    expect((await tagValues('tag=resource.service.name&layer=OTLP_GENERAL')).values).toEqual([]);
    expect(asked).toEqual([]);
  });
});
