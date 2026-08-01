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
 * `/api/alarms` entity filter: the halves OAP's alarm query actually takes
 * travel with the request — the picked service's NAME and its `normal` flag.
 * `alarm.graphqls` has no id form, so neither half is looked up, guessed, or
 * overridden by a roster, and a service id would have nowhere to go.
 *
 * The flag is not decoration — OAP builds the service id as
 * `base64(name).1` (normal) / `base64(name).0` (conjectural), and every
 * instance / endpoint id is built on top of that. Filtering a virtual service
 * as normal therefore asks for an id nothing was ever stored under, and OAP
 * answers with an empty page that reads as "this service has no alarms".
 *
 * The URLs below are the ones the UI's alarms client emits (see
 * `apps/ui/src/api/scopes/alarms.test.ts`, which parses its own output against
 * this route's schema).
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
/** A virtual-layer pick, as the roster row reached the filter: name + flag. */
const MYSQL = 'service=mysql-a&normal=false';

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

/** One layer's roster as `listServices(layer)` reports it. */
interface RosterRow {
  id: string;
  name: string;
  normal: boolean | null;
}

/** An OAP that advertises `queryAlarms`, answers with one alarm, serves the
 *  given per-layer rosters to the service-layer catalog, and records every
 *  request so a test can read back the condition it was sent. */
function fakeOap(
  roster: Record<string, RosterRow[]> = {},
): { fetch: FetchLike; asked: (fragment: string) => Captured[] } {
  const layers = Object.keys(roster);
  const calls: Captured[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Captured;
    const query = body.query ?? '';
    calls.push({ query, variables: body.variables ?? {} });
    if (query.includes('__type')) {
      return json({ data: { __type: { fields: [{ name: 'queryAlarms' }] } } });
    }
    if (query.includes('getTimeInfo')) return json({ data: { time: { timezone: '+0000' } } });
    if (query.includes('listLayers')) return json({ data: { layers } });
    if (query.includes('HorizonServiceCatalogServices')) {
      // The catalog aliases one `listServices` per layer, in `layers` order.
      const data: Record<string, Array<RosterRow & { group: string }>> = {};
      layers.forEach((layer, i) => {
        data[`_${i}`] = (roster[layer] ?? []).map((r) => ({ ...r, group: '' }));
      });
      return json({ data });
    }
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

describe('/api/alarms filters on the identity the request carried', () => {
  it('sends the name and flag of a virtual service so the entity id resolves', async () => {
    const oap = fakeOap();
    const { status } = await listAlarms(oap.fetch, `&layer=VIRTUAL_DATABASE&${MYSQL}`);
    expect(status).toBe(200);
    expect(entitiesOf(oap)).toEqual([
      { scope: 'Service', serviceName: 'mysql-a', normal: false },
    ]);
  });

  it('carries the flag into the instance-scoped entity', async () => {
    const oap = fakeOap();
    await listAlarms(oap.fetch, `&${MYSQL}&instance=mysql-a-0`);
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
    await listAlarms(oap.fetch, `&${MYSQL}&endpoint=SELECT+db.tbl`);
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
    await listAlarms(oap.fetch, '&layer=GENERAL');
    expect(entitiesOf(oap)).toBeUndefined();
  });

  it('rejects a flag that is neither true nor false instead of assuming normal', async () => {
    const oap = fakeOap();
    const { status, body } = await listAlarms(oap.fetch, '&service=songs&normal=0');
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_query');
    expect(oap.asked('queryAlarms')).toHaveLength(0);
  });

  it('ignores a service id rather than refusing it — there is no id form to use it in', async () => {
    const oap = fakeOap();
    const { status } = await listAlarms(
      oap.fetch,
      `&serviceId=${encodeURIComponent('bXlzcWwtYQ==.0')}&${MYSQL}`,
    );
    expect(status).toBe(200);
    expect(entitiesOf(oap)).toEqual([
      { scope: 'Service', serviceName: 'mysql-a', normal: false },
    ]);
  });
});

/* A name with no flag is half a pick. Guessing the missing half addresses a
 * different entity; dropping the filter answers with the whole layer's alarms
 * under one service's name. Neither is acceptable, so the route refuses. */
describe('/api/alarms refuses a service without its flag rather than filtering on it', () => {
  it('refuses a picked service with no flag instead of defaulting it to normal', async () => {
    const oap = fakeOap();
    const { status, body } = await listAlarms(oap.fetch, '&layer=VIRTUAL_DATABASE&service=mysql-a');
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_query');
    expect(oap.asked('queryAlarms')).toHaveLength(0);
  });

  it('reads a flag with no service as no service filter at all', async () => {
    const oap = fakeOap();
    const { status } = await listAlarms(oap.fetch, '&layer=GENERAL&normal=false');
    expect(status).toBe(200);
    expect(entitiesOf(oap)).toBeUndefined();
  });
});

/* The flag is whatever the picked row said. The route holds a per-layer roster
 * for tagging rows with their layer, and must not consult it to second-guess
 * the request — a roster snapshot lags the pick, and a filter that swaps in a
 * stale flag queries an entity the operator did not pick. */
const ROSTER: Record<string, RosterRow[]> = {
  VIRTUAL_DATABASE: [{ id: 'bXlzcWwtYQ==.0', name: 'mysql-a', normal: false }],
  GENERAL: [{ id: 'c29uZ3M=.1', name: 'songs', normal: true }],
};

describe('/api/alarms takes the flag from the request, not from a layer roster', () => {
  it('sends the caller\'s flag even when the layer\'s roster says otherwise', async () => {
    const oap = fakeOap(ROSTER);
    await listAlarms(oap.fetch, '&layer=VIRTUAL_DATABASE&service=mysql-a&normal=true');
    expect(entitiesOf(oap)).toEqual([
      { scope: 'Service', serviceName: 'mysql-a', normal: true },
    ]);
  });

  it('filters a service the roster snapshot has never seen', async () => {
    const oap = fakeOap(ROSTER);
    await listAlarms(
      oap.fetch,
      '&layer=VIRTUAL_DATABASE&service=redis-b&normal=false&instance=redis-b-0',
    );
    expect(entitiesOf(oap)).toEqual([
      {
        scope: 'ServiceInstance',
        serviceName: 'redis-b',
        normal: false,
        serviceInstanceName: 'redis-b-0',
      },
    ]);
  });

  it('needs no layer at all to filter — the identity is self-contained', async () => {
    const oap = fakeOap(ROSTER);
    await listAlarms(oap.fetch, `&${MYSQL}`);
    expect(entitiesOf(oap)).toEqual([
      { scope: 'Service', serviceName: 'mysql-a', normal: false },
    ]);
  });
});
