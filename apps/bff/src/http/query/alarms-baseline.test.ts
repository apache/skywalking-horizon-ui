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
 * OAP evaluates an alarm rule's `baseline(...)` by the service NAME alone and
 * keeps the values in the alarm's snapshot. A caller limited to some groups
 * sees those values only when every service of that name is one it may read.
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
import { _resetCapabilitiesCache } from '../../logic/oap/capabilities.js';
import { registerAlarmsQueryRoutes } from './alarms.js';

const NOW = 1_700_000_000_000;
const NAME = 'payments::checkout';
const real = { id: serviceIdOf(NAME, true), name: NAME, normal: true, group: 'payments' };
const conjectured = { id: serviceIdOf(NAME, false), name: NAME, normal: false, group: 'payments' };

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

let scope = 'Service';
const fetch: FetchLike = async (_url, init) => {
  const { query = '' } = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
  if (query.includes('__type')) return json({ data: { __type: { fields: [{ name: 'queryAlarms' }] } } });
  if (query.includes('getTimeInfo')) return json({ data: { time: { timezone: '+0000' } } });
  if (query.includes('queryAlarms')) {
    const metric = { name: 'baseline', results: [{ metric: { labels: [] }, values: [{ id: '1', value: '42' }] }] };
    return json({
      data: {
        queryAlarms: {
          msgs: [
            {
              id: 'a-1', startTime: NOW - 60_000, recoveryTime: null, scope, name: scope === 'Service' ? NAME : `pod-1 of ${NAME}`,
              message: 'above the predicted range', tags: [],
              snapshot: { expression: 'service_resp_time > baseline(service_resp_time,upper)', metrics: [metric] },
            },
          ],
        },
      },
    });
  }
  return json({ data: {} });
};

async function alarmsFor(withNamesake: boolean) {
  _resetCapabilitiesCache();
  const cfg = configSchema.parse({ rbac: { roles: { payments: ['alarms:read@GENERAL[payments]'] } } });
  const config: ConfigSource = { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
  const snapshot: ServiceCatalog = {
    layers: ['GENERAL', 'VIRTUAL_DATABASE'],
    byLayer: new Map([
      ['GENERAL', [real]],
      ['VIRTUAL_DATABASE', withNamesake ? [conjectured] : []],
    ]),
    byName: new Map(),
  };
  const catalog = { get: async () => snapshot, allServices: async () => [] } as unknown as ServiceLayerCatalog;
  const unknown: FetchLike = async () => json({ data: { service: null } });
  const access = {
    services: new ServiceIdentityResolver({ config, fetch: unknown, catalog }),
    classify: async () => ({ isOperate: () => false }),
  };
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const app = Fastify();
  await app.register(cookie);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions, access }));
  registerAlarmsQueryRoutes(app, { config, sessions, serviceLayer: catalog, fetch });
  await app.ready();
  const sid = sessions.create('pay', ['payments']).sid;
  const res = await app.inject({
    method: 'GET',
    url: `/api/alarms?layer=GENERAL&service=${encodeURIComponent(NAME)}&normal=true&startTime=${NOW - 600_000}&endTime=${NOW}`,
    headers: { cookie: `horizon_sid=${sid}` },
  });
  await app.close();
  return { status: res.statusCode, body: res.json() as { msgs: Array<{ snapshot: { metrics: unknown[] } }> } };
}

describe('an alarm whose rule reads a baseline', () => {
  it('keeps the snapshot values when no unreadable service shares the name', async () => {
    const { status, body } = await alarmsFor(false);
    expect(status).toBe(200);
    expect(body.msgs[0]!.snapshot.metrics).toHaveLength(1);
  });

  it('withholds them from an instance alarm, whose lookup name is not a service\'s', async () => {
    scope = 'ServiceInstance';
    try {
      const { body } = await alarmsFor(false);
      expect(body.msgs[0]!.snapshot.metrics).toEqual([]);
    } finally {
      scope = 'Service';
    }
  });

  it('withholds them when a namesake is outside the grant, and keeps the alarm', async () => {
    const { status, body } = await alarmsFor(true);
    expect(status).toBe(200);
    expect(body.msgs).toHaveLength(1);
    expect(body.msgs[0]!.snapshot.metrics).toEqual([]);
  });
});
