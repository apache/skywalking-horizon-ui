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
 * A native trace list that names no service reads every service's traces, so
 * a role that does not read every layer must name one — decided where the
 * layer's stores are known. The Zipkin search is never narrowed.
 */

import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { ServiceIdentityResolver, serviceIdOf } from '../../logic/services/service-identity.js';
import type { ServiceCatalog, ServiceLayerCatalog } from '../../logic/services/service-layer-catalog.js';
import { registerTraceRoutes } from './trace.js';

const PAY = { id: serviceIdOf('payments::checkout', true), name: 'payments::checkout', normal: true, group: 'payments' };
const ROLES = {
  admin: ['*'],
  viewer: ['traces:read'],
  payments: ['traces:read@GENERAL[payments]', 'traces:read@MESH[payments]'],
};
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const oap: FetchLike = async (rawUrl, init) => {
  if (String(rawUrl).includes('/api/v2/')) return json([]);
  const { query = '' } = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
  if (query.includes('getTimeInfo')) return json({ data: { getTimeInfo: { timezone: '+0000', currentTimestamp: Date.now() } } });
  if (query.includes('hasQueryTracesV2Support')) return json({ data: { hasQueryTracesV2Support: false } });
  return json({ data: { data: { traces: [] } } });
};
const snapshot: ServiceCatalog = { layers: ['GENERAL', 'MESH'], byLayer: new Map([['GENERAL', [PAY]], ['MESH', [PAY]]]), byName: new Map() };

async function list(role: keyof typeof ROLES, layer: string, body: Record<string, unknown>) {
  const cfg = configSchema.parse({ rbac: { roles: ROLES } });
  const config: ConfigSource = { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const catalog = { get: async () => snapshot } as unknown as ServiceLayerCatalog;
  const app = Fastify();
  await app.register(cookie);
  app.addHook(
    'onRoute',
    makeRouteAuthHook({
      config,
      sessions,
      access: { services: new ServiceIdentityResolver({ config, catalog, fetch: oap }), classify: async () => ({ isOperate: () => false }) },
    }),
  );
  registerTraceRoutes(app, { config, sessions, fetch: oap, serviceLayer: catalog } as unknown as Parameters<typeof registerTraceRoutes>[1]);
  await app.ready();
  const sid = sessions.create(role, [role]).sid;
  const res = await app.inject({ method: 'POST', url: `/api/layer/${layer}/traces`, payload: body, headers: { cookie: `horizon_sid=${sid}` } });
  await app.close();
  return { status: res.statusCode, reason: (res.json() as { reason?: string }).reason };
}

describe('a native trace list that names no service', () => {
  it('is read for a role that reads every layer', async () => {
    expect((await list('admin', 'general', { source: 'native' })).status).toBe(200);
  });

  it('is refused a role limited to layers, and one without cluster:read', async () => {
    expect(await list('payments', 'general', { source: 'native' })).toEqual({ status: 403, reason: 'service_required' });
    expect(await list('viewer', 'general', { source: 'native' })).toEqual({ status: 403, reason: 'service_required' });
  });

  it('counts an exact trace id, never a blank one or a Zipkin id list', async () => {
    expect((await list('payments', 'general', { source: 'native', traceId: 't-1' })).status).toBe(200);
    for (const traceId of [' ', '', ' t-1']) {
      expect((await list('payments', 'general', { source: 'native', traceId })).reason, JSON.stringify(traceId)).toBe('service_required');
    }
    expect((await list('payments', 'general', { source: 'native', traceIds: ['t-1'] })).reason).toBe('service_required');
  });

  it('is not asked of a read of the Zipkin store alone, which is never narrowed', async () => {
    expect((await list('payments', 'general', { source: 'zipkin' })).status).toBe(200);
    expect((await list('payments', 'general', { source: 'native', serviceId: PAY.id })).status).toBe(200);
  });
});
