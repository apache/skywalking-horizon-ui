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
 * `/api/alarms` entity filter: the picked service's `normal` flag must reach
 * OAP as the caller sent it.
 *
 * The flag is not decoration — OAP builds the service id as
 * `base64(name).1` (normal) / `base64(name).0` (conjectural), and every
 * instance / endpoint id is built on top of that. Filtering a virtual service
 * as normal therefore asks for an id nothing was ever stored under, and OAP
 * answers with an empty page that reads as "this service has no alarms".
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { ServiceLayerCatalog } from '../../logic/services/service-layer-catalog.js';
import { _resetCapabilitiesCache } from '../../logic/oap/capabilities.js';
import { registerAlarmsQueryRoutes } from './alarms.js';

const NOW = 1_700_000_000_000;
const WINDOW = `startTime=${NOW - 600_000}&endTime=${NOW}`;

interface Captured {
  query: string;
  variables: Record<string, unknown>;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** An OAP that advertises `queryAlarms`, answers with one alarm, and records
 *  every request so a test can read back the condition it was sent. */
function fakeOap(): { fetch: FetchLike; asked: (fragment: string) => Captured[] } {
  const calls: Captured[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Captured;
    const query = body.query ?? '';
    calls.push({ query, variables: body.variables ?? {} });
    if (query.includes('__type')) {
      return json({ data: { __type: { fields: [{ name: 'queryAlarms' }] } } });
    }
    if (query.includes('getTimeInfo')) return json({ data: { time: { timezone: '+0000' } } });
    if (query.includes('listLayers')) return json({ data: { layers: [] } });
    if (query.includes('queryAlarms')) {
      return json({
        data: {
          queryAlarms: {
            msgs: [
              {
                id: 'alarm-1',
                startTime: NOW - 60_000,
                recoveryTime: null,
                scope: 'Service',
                name: 'mysql-a',
                message: 'response time is more than 1000ms',
                tags: [],
                snapshot: { expression: 'x > 1', metrics: [] },
              },
            ],
          },
        },
      });
    }
    return json({ data: {} });
  };
  return { fetch, asked: (fragment) => calls.filter((c) => c.query.includes(fragment)) };
}

function fakeConfig(): ConfigSource {
  const cfg = configSchema.parse({});
  return { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
}

async function build(fetchImpl: FetchLike): Promise<{ app: FastifyInstance; sid: string }> {
  const config = fakeConfig();
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const app = Fastify();
  await app.register(cookie);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
  registerAlarmsQueryRoutes(app, {
    config,
    sessions,
    serviceLayer: new ServiceLayerCatalog({ config, fetch: fetchImpl }),
    fetch: fetchImpl,
  });
  await app.ready();
  return { app, sid: sessions.create('op', ['admin']).sid };
}

/** GET /api/alarms with the given extra query string, as a logged-in operator. */
async function listAlarms(
  fetchImpl: FetchLike,
  filters: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { app, sid } = await build(fetchImpl);
  const res = await app.inject({
    method: 'GET',
    url: `/api/alarms?${WINDOW}${filters}`,
    headers: { cookie: `horizon_sid=${sid}` },
  });
  return { status: res.statusCode, body: res.json() };
}

/** The `entities` array of the queryAlarms condition the fake OAP was sent. */
function entitiesOf(oap: { asked: (f: string) => Captured[] }): unknown {
  const condition = oap.asked('queryAlarms')[0]?.variables.condition as
    | Record<string, unknown>
    | undefined;
  return condition?.entities;
}

beforeEach(() => _resetCapabilitiesCache());

describe('/api/alarms carries the picked service\'s normal flag to OAP', () => {
  it('sends normal:false for a virtual service so the entity id resolves', async () => {
    const oap = fakeOap();
    const { status } = await listAlarms(oap.fetch, '&layer=VIRTUAL_DATABASE&service=mysql-a&normal=false');
    expect(status).toBe(200);
    expect(entitiesOf(oap)).toEqual([
      { scope: 'Service', serviceName: 'mysql-a', normal: false },
    ]);
  });

  it('keeps normal:true for a normal service, flag sent or omitted', async () => {
    const explicit = fakeOap();
    await listAlarms(explicit.fetch, '&layer=GENERAL&service=songs&normal=true');
    expect(entitiesOf(explicit)).toEqual([
      { scope: 'Service', serviceName: 'songs', normal: true },
    ]);

    _resetCapabilitiesCache();
    const implicit = fakeOap();
    await listAlarms(implicit.fetch, '&layer=GENERAL&service=songs');
    expect(entitiesOf(implicit)).toEqual([
      { scope: 'Service', serviceName: 'songs', normal: true },
    ]);
  });

  it('carries the flag into the instance-scoped entity', async () => {
    const oap = fakeOap();
    await listAlarms(oap.fetch, '&service=mysql-a&normal=false&instance=mysql-a-0');
    expect(entitiesOf(oap)).toEqual([
      {
        scope: 'ServiceInstance',
        serviceName: 'mysql-a',
        normal: false,
        serviceInstanceName: 'mysql-a-0',
      },
    ]);
  });

  it('carries the flag into the endpoint-scoped entity', async () => {
    const oap = fakeOap();
    await listAlarms(oap.fetch, '&service=mysql-a&normal=false&endpoint=SELECT+db.tbl');
    expect(entitiesOf(oap)).toEqual([
      {
        scope: 'Endpoint',
        serviceName: 'mysql-a',
        normal: false,
        endpointName: 'SELECT db.tbl',
      },
    ]);
  });

  it('adds no entity filter when no service was picked', async () => {
    const oap = fakeOap();
    await listAlarms(oap.fetch, '&layer=GENERAL&normal=false');
    expect(entitiesOf(oap)).toBeUndefined();
  });

  it('rejects a flag that is neither true nor false instead of assuming normal', async () => {
    const oap = fakeOap();
    const { status, body } = await listAlarms(oap.fetch, '&service=mysql-a&normal=0');
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_query');
    expect(oap.asked('queryAlarms')).toHaveLength(0);
  });
});
