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
 * `GET /api/layer/:key/services` through the real gate: a group entry of a
 * layer split by service group is refused, as a layer is, when the grant does
 * not reach it — the layer page tells "no access" from "not found" by that.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { ServiceIdentityResolver } from '../../logic/services/service-identity.js';
import { resetServiceLayerCatalog, serviceLayerCatalog } from '../../logic/services/service-layer-catalog.js';
import { registerLayerServicesRoute } from './services.js';

const ROLES = {
  viewer: ['metrics:read'],
  payments: ['metrics:read@GENERAL[payments]'],
};

const SERVICES = [
  { id: 'a.1', name: 'payments::a', normal: true, group: 'payments' },
  { id: 'c.1', name: 'risk::c', normal: true, group: 'risk' },
];

const oap: FetchLike = async (_url, init) => {
  const { query = '' } = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
  const data = query.includes('HorizonServiceCatalogLayers') ? { layers: ['GENERAL'] } : { _0: SERVICES };
  return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
};

let app: FastifyInstance | null = null;
beforeEach(() => resetServiceLayerCatalog());
afterEach(async () => {
  await app?.close();
  app = null;
  resetServiceLayerCatalog();
});

async function roster(role: keyof typeof ROLES, query: string) {
  const cfg = configSchema.parse({ rbac: { roles: ROLES } });
  const config: ConfigSource = { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const catalog = serviceLayerCatalog({ config, fetch: oap });
  app = Fastify();
  await app.register(cookie);
  app.addHook(
    'onRoute',
    makeRouteAuthHook({
      config,
      sessions,
      access: { services: new ServiceIdentityResolver({ config, catalog, fetch: oap }), classify: async () => ({ isOperate: () => false }) },
    }),
  );
  registerLayerServicesRoute(app, { config, sessions, fetch: oap });
  await app.ready();
  const sid = sessions.create(role, [role]).sid;
  const res = await app.inject({ method: 'GET', url: `/api/layer/general/services${query}`, headers: { cookie: `horizon_sid=${sid}` } });
  return { status: res.statusCode, body: res.json() as { services?: Array<{ name: string }>; reason?: string; group?: string } };
}

describe('a group entry of a split layer', () => {
  it('lists the group\'s services to a role whose grant reaches it', async () => {
    const res = await roster('payments', '?group=payments');
    expect(res.status).toBe(200);
    expect(res.body.services?.map((s) => s.name)).toEqual(['payments::a']);
  });

  it('refuses a group the grant does not reach, rather than listing nothing', async () => {
    const res = await roster('payments', '?group=risk');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'permission_denied', reason: 'group_not_granted', group: 'risk' });
  });

  it('lists any group to a role that reads the whole layer', async () => {
    const res = await roster('viewer', '?group=risk');
    expect(res.status).toBe(200);
    expect(res.body.services?.map((s) => s.name)).toEqual(['risk::c']);
  });

  it('keeps the whole-layer read narrowed to the grant\'s groups', async () => {
    const res = await roster('payments', '');
    expect(res.status).toBe(200);
    expect(res.body.services?.map((s) => s.name)).toEqual(['payments::a']);
  });
});
