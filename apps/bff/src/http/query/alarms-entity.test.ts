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
 * A service picked alone is not sent to OAP; the rows are kept by that same
 * id, so the flag decides them just the same.
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
                // A Service alarm's id is the service's own: base64(name).<0|1>.
                id: 'bXlzcWwtYQ==.0',
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
    uiTemplateClient: () => {
      throw new Error('no alarm page is read here');
    },
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

function conditionOf(oap: ReturnType<typeof fakeOap>): Record<string, unknown> | undefined {
  return oap.asked('queryAlarms').at(-1)?.variables.condition as Record<string, unknown> | undefined;
}

function alarmRow(id: string, name: string, i: number) {
  return { id, startTime: NOW - 60_000 - i, recoveryTime: null, scope: 'Service', name, message: 'm', tags: [], snapshot: { expression: `r${i}`, metrics: [] } };
}

/** `queryAlarms` answered the way OAP 11.0.0 does on BanyanDB without an
 *  entity filter: `from` offsets the storage read AND the page cut from it,
 *  so any page after the first comes back empty. */
function banyandbAlarms(base: ReturnType<typeof fakeOap>, all: unknown[]) {
  const pagesAsked: Array<{ pageNum: number; pageSize: number }> = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Captured;
    if (!body.query.includes('queryAlarms')) return base.fetch(url, init);
    const paging = (body.variables.condition as { paging: { pageNum: number; pageSize: number } }).paging;
    pagesAsked.push(paging);
    const from = (paging.pageNum - 1) * paging.pageSize;
    const stored = all.slice(from, from + paging.pageSize);
    return json({ data: { queryAlarms: { msgs: stored.slice(Math.min(from, stored.length), from + paging.pageSize) } } });
  };
  return { fetch, pagesAsked };
}

beforeEach(() => _resetCapabilitiesCache());

const returned = (body: Record<string, unknown>) => (body.msgs as unknown[]).length;

describe('/api/alarms filters on the identity the request carried', () => {
  it('keeps a virtual service\'s alarms by the id its name and flag make, sending OAP no entity', async () => {
    const oap = fakeOap();
    const { status, body } = await listAlarms(oap.fetch, `&layer=VIRTUAL_DATABASE&${MYSQL}`);
    expect(status).toBe(200);
    expect(entitiesOf(oap)).toBeUndefined();
    expect(returned(body)).toBe(1);
    const asNormal = await listAlarms(fakeOap().fetch, '&layer=VIRTUAL_DATABASE&service=mysql-a&normal=true');
    expect(returned(asNormal.body)).toBe(0);
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

  // OAP stores one layer per alarm — the entity's first, or none when it had
  // not resolved it — so a layer is applied by the layers the page counts.
  // Other layers' alarms can fill OAP's first page; the filter reads on.
  it('fills a layer\'s page from past the rows another layer filled', async () => {
    const mesh = { id: 'bWVzaC1h.1', name: 'mesh-a', normal: true };
    const base = fakeOap({ MESH: [mesh], VIRTUAL_DATABASE: [{ id: 'bXlzcWwtYQ==.0', name: 'mysql-a', normal: false }] });
    const all = [...Array.from({ length: 500 }, (_, i) => alarmRow(mesh.id, mesh.name, i)), alarmRow('bXlzcWwtYQ==.0', 'mysql-a', 999)];
    const oap = banyandbAlarms(base, all);
    const { body } = await listAlarms(oap.fetch, '&layer=VIRTUAL_DATABASE&pageSize=200');
    expect((body.msgs as Array<{ name: string }>).map((m) => m.name)).toEqual(['mysql-a']);
    expect(body.truncated).toBe(false);
    expect(oap.pagesAsked.every((p) => p.pageNum === 1)).toBe(true);
  });

  it('serves a later page from the window\'s first rows', async () => {
    const all = Array.from({ length: 8 }, (_, i) => alarmRow('bXlzcWwtYQ==.0', 'mysql-a', i));
    const oap = banyandbAlarms(fakeOap(), all);
    const { status, body } = await listAlarms(oap.fetch, '&pageNum=2&pageSize=3');
    expect(status).toBe(200);
    expect((body.msgs as Array<{ snapshot: { expression: string } }>).map((m) => m.snapshot.expression)).toEqual(['r3', 'r4', 'r5']);
    expect(body.truncated).toBe(true);
    expect(oap.pagesAsked).toEqual([{ pageNum: 1, pageSize: 7 }]);
  });

  it('refuses a page past the rows a window may be read to', async () => {
    const { status } = await listAlarms(fakeOap().fetch, '&pageNum=11&pageSize=500');
    expect(status).toBe(400);
  });

  it('refuses a layer filter when the service catalog cannot be read', async () => {
    const base = fakeOap();
    const fetchImpl: FetchLike = async (url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Captured;
      if (body.query.includes('listLayers')) throw new Error('connect ECONNREFUSED');
      return base.fetch(url, init);
    };
    const { status, body } = await listAlarms(fetchImpl, '&layer=GENERAL');
    expect(status).toBe(503);
    expect(body.error).toBe('catalog_unavailable');
  });

  it('keeps the alarms of the layer\'s services, without asking OAP for its stored layer', async () => {
    const roster = { VIRTUAL_DATABASE: [{ id: 'bXlzcWwtYQ==.0', name: 'mysql-a', normal: false }] };
    const inLayer = await listAlarms(fakeOap(roster).fetch, '&layer=virtual_database');
    expect((inLayer.body.msgs as unknown[]).length).toBe(1);
    const oap = fakeOap(roster);
    const elsewhere = await listAlarms(oap.fetch, '&layer=GENERAL');
    expect((elsewhere.body.msgs as unknown[]).length).toBe(0);
    expect(conditionOf(oap)?.layer).toBeUndefined();
  });

  // OAP stores one layer per alarm — the entity's first, or none when it had
  // not resolved it — so beside a service it can only drop that service's rows.
  it('sends no layer beside a picked service', async () => {
    const oap = fakeOap();
    await listAlarms(oap.fetch, `&layer=VIRTUAL_DATABASE&${MYSQL}`);
    expect(conditionOf(oap)?.layer).toBeUndefined();
  });

  it('tags a row with the layers of the service that owns it', async () => {
    const oap = fakeOap({ VIRTUAL_DATABASE: [{ id: 'bXlzcWwtYQ==.0', name: 'mysql-a', normal: false }] });
    const { body } = await listAlarms(oap.fetch, '');
    expect((body.msgs as Array<Record<string, unknown>>)[0]).toMatchObject({ layerKeys: ['VIRTUAL_DATABASE'], layerKey: 'VIRTUAL_DATABASE' });
  });

  it('rejects a flag that is neither true nor false instead of assuming normal', async () => {
    const oap = fakeOap();
    const { status, body } = await listAlarms(oap.fetch, '&service=songs&normal=0');
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_query');
    expect(oap.asked('queryAlarms')).toHaveLength(0);
  });

  it('ignores a service id rather than refusing it — the name and flag decide', async () => {
    const oap = fakeOap();
    const { status, body } = await listAlarms(
      oap.fetch,
      `&serviceId=${encodeURIComponent('c29uZ3M=.1')}&${MYSQL}`,
    );
    expect(status).toBe(200);
    expect(entitiesOf(oap)).toBeUndefined();
    expect(returned(body)).toBe(1);
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
  it('filters by the caller\'s flag even when the layer\'s roster says otherwise', async () => {
    const oap = fakeOap(ROSTER);
    const { body } = await listAlarms(oap.fetch, '&layer=VIRTUAL_DATABASE&service=mysql-a&normal=true');
    expect(returned(body)).toBe(0);
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
    const { body } = await listAlarms(oap.fetch, `&${MYSQL}`);
    expect(returned(body)).toBe(1);
    const other = await listAlarms(fakeOap(ROSTER).fetch, '&service=songs&normal=true');
    expect(returned(other.body)).toBe(0);
  });
});
