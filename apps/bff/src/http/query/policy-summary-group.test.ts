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
 * The continuous-profiling picker of a split layer's entry lists that entry's
 * services: the summary narrows to the `group` it is asked for.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { serviceIdOf } from '../../logic/services/service-identity.js';
import { resetServiceLayerCatalog } from '../../logic/services/service-layer-catalog.js';
import { registerContinuousProfilingRoutes } from './continuous-profiling.js';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const svc = (name: string, group: string) => ({ id: serviceIdOf(name, true), name, normal: true, group });
const oap: FetchLike = async (_url, init) => {
  const { query = '' } = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
  if (query.includes('HorizonServiceCatalogLayers')) return json({ data: { layers: ['GENERAL'] } });
  if (query.includes('HorizonServiceCatalogServices')) {
    return json({ data: { _0: [svc('payments::checkout', 'payments'), svc('risk::scorer', 'risk'), svc('audit', '')] } });
  }
  if (query.includes('HorizonContinuousProfilingPolicyTypes')) return json({ data: { targets: [] } });
  return json({ data: {} });
};

afterEach(() => resetServiceLayerCatalog());

async function summary(query: string): Promise<string[]> {
  resetServiceLayerCatalog();
  const cfg = configSchema.parse({});
  const config: ConfigSource = { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const app = Fastify();
  await app.register(cookie);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
  registerContinuousProfilingRoutes(app, { config, sessions, fetch: oap });
  await app.ready();
  const sid = sessions.create('op', ['admin']).sid;
  const res = await app.inject({ method: 'GET', url: `/api/continuous-profiling/policy-summary?${query}`, headers: { cookie: `horizon_sid=${sid}` } });
  await app.close();
  return (res.json() as { services: Array<{ name: string }> }).services.map((s) => s.name).sort();
}

describe('the continuous-profiling policy summary of a split layer', () => {
  it('lists one group\'s services, the services with no group, or the whole layer', async () => {
    expect(await summary('layer=GENERAL&group=payments')).toEqual(['payments::checkout']);
    expect(await summary('layer=GENERAL&group=')).toEqual(['audit']);
    expect(await summary('layer=GENERAL')).toEqual(['audit', 'payments::checkout', 'risk::scorer']);
  });
});
