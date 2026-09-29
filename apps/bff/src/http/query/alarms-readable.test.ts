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
 * `/api/alarms` and `/api/alarms/count` for a caller who does not read every
 * layer: a read that names no service answers with the alarms of the services
 * they may read, through the real scope gate and grants.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
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
const WINDOW = `startTime=${NOW - 600_000}&endTime=${NOW}`;

const svc = (name: string, group = '', normal = true) => ({ id: serviceIdOf(name, normal), name, normal, group });
const checkout = svc('payments::checkout', 'payments');
const scorer = svc('risk::scorer', 'risk');
const bdb = svc('showcase-banyandb');
const ghost = svc('payments::ghost', 'payments');

const catalogOf = (unreachable = false): ServiceCatalog =>
  unreachable
    ? { layers: [], byLayer: new Map(), byName: new Map(), unreachable: true }
    : {
        layers: ['GENERAL', 'BANYANDB'],
        byLayer: new Map([
          ['GENERAL', [checkout, scorer]],
          ['BANYANDB', [bdb]],
        ]),
        byName: new Map(),
      };

const ROLES = {
  ops: ['alarms:read', 'cluster:read'],
  viewer: ['alarms:read'],
  payments: ['alarms:read@GENERAL[payments]'],
};

interface Row {
  id: string;
  startTime: number;
  recoveryTime: number | null;
  scope: string;
  name: string;
  message: string;
  tags: [];
  snapshot: { expression: string; metrics: unknown[] };
}

let seq = 0;
function row(scope: string, id: string, name: string): Row {
  seq += 1;
  const metrics = [{ name: 'm', results: [{ metric: { labels: [] }, values: [{ id: '1', value: '9' }] }] }];
  return { id, startTime: NOW - 60_000 - seq, recoveryTime: null, scope, name, message: name, tags: [], snapshot: { expression: `rule-${seq}`, metrics } };
}

const CHECKOUT = row('Service', checkout.id, checkout.name);
const BDB = row('Service', bdb.id, bdb.name);
const INBOUND = row('ServiceRelation', scorer.id, `${scorer.name} to ${checkout.name}`);
const OUTBOUND = row('ServiceRelation', checkout.id, `${checkout.name} to ${scorer.name}`);
const ALL = row('All', '', 'the deployment');
const SCORER = row('Service', scorer.id, scorer.name);
const ROWS = [CHECKOUT, BDB, INBOUND, OUTBOUND, ALL, SCORER];

interface Oap {
  fetch: FetchLike;
  alarmReads: Array<{ pageSize: number; entities?: unknown }>;
}

/** An OAP holding `rows`, answering `getService` from `known` (or not at all
 *  when `down`). With an entity filter it answers the rows naming that service. */
function fakeOap(rows: Row[], opts: { legacy?: boolean; down?: boolean } = {}): Oap {
  const alarmReads: Oap['alarmReads'] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetch: FetchLike = async (_url, init) => {
    const { query = '', variables = {} } = JSON.parse(String(init?.body ?? '{}')) as { query?: string; variables?: Record<string, unknown> };
    if (query.includes('__type')) return json({ data: { __type: { fields: opts.legacy ? [] : [{ name: 'queryAlarms' }] } } });
    if (query.includes('getTimeInfo')) return json({ data: { time: { timezone: '+0000' } } });
    if (query.includes('HorizonAccessService')) {
      if (opts.down) throw new Error('connect ECONNREFUSED');
      return json({ data: { service: null } });
    }
    const condition = (variables.condition ?? variables) as { paging: { pageSize: number }; entities?: Array<{ serviceName: string }> };
    if (query.includes('queryAlarms') || query.includes('getAlarm')) {
      alarmReads.push({ pageSize: condition.paging.pageSize, entities: condition.entities });
      const named = condition.entities?.[0]?.serviceName;
      const msgs = rows.filter((m) => !named || m.name.includes(named)).slice(0, condition.paging.pageSize);
      return json({ data: query.includes('queryAlarms') ? { queryAlarms: { msgs } } : { getAlarm: { msgs } } });
    }
    return json({ data: {} });
  };
  return { fetch, alarmReads };
}

let app: FastifyInstance | null = null;
beforeEach(() => _resetCapabilitiesCache());
afterEach(async () => {
  await app?.close();
  app = null;
});

async function call(
  role: keyof typeof ROLES,
  url: string,
  oap: Oap,
  catalogUnreachable = false,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const cfg = configSchema.parse({ rbac: { roles: ROLES } });
  const config: ConfigSource = { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
  const snapshot = catalogOf(catalogUnreachable);
  const catalog = { get: async () => snapshot } as unknown as ServiceLayerCatalog;
  const access = {
    services: new ServiceIdentityResolver({ config, fetch: oap.fetch, catalog }),
    classify: async () => ({ isOperate: (l: string) => l === 'BANYANDB' }),
  };
  const sessions = new SessionStore({ ttlMinutes: 60 });
  app = Fastify();
  await app.register(cookie);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions, access }));
  const uiTemplateClient = () => {
    throw new Error('no alarm page is read here');
  };
  registerAlarmsQueryRoutes(app, { config, sessions, serviceLayer: catalog, uiTemplateClient, fetch: oap.fetch });
  await app.ready();
  const sid = sessions.create(role, [role]).sid;
  const res = await app.inject({ method: 'GET', url, headers: { cookie: `horizon_sid=${sid}` } });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

type Msg = Row & { layerKeys: string[]; owners: Array<{ layer: string; group: string }> };
const msgs = (body: Record<string, unknown>) => body.msgs as Msg[];
const names = (body: Record<string, unknown>) => msgs(body).map((m) => m.name);

describe('a reader of every layer', () => {
  it('gets every alarm whole, and the count reads the window as before', async () => {
    const oap = fakeOap(ROWS);
    const list = await call('ops', `/api/alarms?${WINDOW}`, oap);
    expect(names(list.body)).toEqual(ROWS.map((m) => m.name));
    expect(msgs(list.body).every((m) => m.snapshot.metrics.length === 1)).toBe(true);
    const count = await call('ops', `/api/alarms/count?${WINDOW}`, fakeOap(ROWS));
    expect(count.body).toMatchObject({ total: 6, incidents: 6, truncated: false });
  });

  it('counts without the service catalog', async () => {
    const count = await call('ops', `/api/alarms/count?${WINDOW}`, fakeOap(ROWS), true);
    expect(count.status).toBe(200);
  });
});

describe('a plain alarms:read without cluster:read', () => {
  it('no longer sees the alarms of services only in an operate layer', async () => {
    const list = await call('viewer', `/api/alarms?${WINDOW}`, fakeOap(ROWS));
    expect(names(list.body)).toEqual([CHECKOUT, INBOUND, OUTBOUND, ALL, SCORER].map((m) => m.name));
    const count = await call('viewer', `/api/alarms/count?${WINDOW}`, fakeOap(ROWS));
    expect(count.body).toMatchObject({ total: 5, activeIncidents: 5 });
  });
});

describe('alarms:read on a layer\'s group, with no service named', () => {
  it('lists the alarms of the services it reads instead of refusing', async () => {
    const list = await call('payments', `/api/alarms?${WINDOW}`, fakeOap(ROWS));
    expect(list.status).toBe(200);
    expect(names(list.body)).toEqual([CHECKOUT.name, INBOUND.name, OUTBOUND.name]);
    expect(list.body.truncated).toBe(false);
  });

  it('keeps a relation into its service whole: either end of a relation reads all of it', async () => {
    const list = await call('payments', `/api/alarms?${WINDOW}`, fakeOap(ROWS));
    const [own, inbound, outbound] = msgs(list.body);
    expect(inbound!.snapshot.metrics).toHaveLength(1);
    expect(inbound!.message).toBe(INBOUND.message);
    expect(own!.snapshot.metrics).toHaveLength(1);
    expect(outbound!.snapshot.metrics).toHaveLength(1);
  });

  it('tags each row with the layer-and-group pairs of its services', async () => {
    const list = await call('payments', `/api/alarms?${WINDOW}`, fakeOap(ROWS));
    const [own, inbound] = msgs(list.body);
    expect(own).toMatchObject({ layerKeys: ['GENERAL'], owners: [{ layer: 'GENERAL', group: 'payments' }] });
    expect(inbound!.owners).toEqual([
      { layer: 'GENERAL', group: 'risk' },
      { layer: 'GENERAL', group: 'payments' },
    ]);
    expect(Object.keys(own!)).not.toContain('kept');
  });

  it('applies a layer filter to those rows alone', async () => {
    const list = await call('payments', `/api/alarms?${WINDOW}&layer=general`, fakeOap(ROWS));
    expect(names(list.body)).toEqual([CHECKOUT.name, INBOUND.name, OUTBOUND.name]);
    const none = await call('payments', `/api/alarms?${WINDOW}&layer=BANYANDB`, fakeOap(ROWS));
    expect(names(none.body)).toEqual([]);
  });

  it('counts only those alarms', async () => {
    const count = await call('payments', `/api/alarms/count?${WINDOW}`, fakeOap(ROWS));
    expect(count.status).toBe(200);
    expect(count.body).toMatchObject({ total: 3, firing: 3, incidents: 3, activeIncidents: 3, truncated: false });
  });

  it('says the count is capped only when more of its alarms exist', async () => {
    const many = Array.from({ length: 450 }, (_, i) => (i % 2 ? row('Service', scorer.id, scorer.name) : row('Service', checkout.id, checkout.name)));
    const capped = await call('payments', `/api/alarms/count?${WINDOW}`, fakeOap(many));
    expect(capped.body).toMatchObject({ total: 200, truncated: true });
    const exact = await call('payments', `/api/alarms/count?${WINDOW}`, fakeOap(many.slice(0, 400)));
    expect(exact.body).toMatchObject({ total: 200, truncated: false });
  });

  it('counts from a legacy OAP too, whose query names no service', async () => {
    const count = await call('payments', `/api/alarms/count?${WINDOW}`, fakeOap(ROWS, { legacy: true }));
    expect(count.body).toMatchObject({ total: 3 });
  });

  it('is still refused the legacy alarm list', async () => {
    const list = await call('payments', `/api/alarms?${WINDOW}`, fakeOap(ROWS, { legacy: true }));
    expect(list.status).toBe(403);
    expect(list.body.reason).toBe('alarm_filter_unsupported');
  });

  it('answers 503 when OAP cannot say whose an unknown source is, never a partial list', async () => {
    const rows = [...ROWS, row('Service', ghost.id, ghost.name)];
    const list = await call('payments', `/api/alarms?${WINDOW}`, fakeOap(rows, { down: true }));
    expect(list.status).toBe(503);
    expect(list.body.error).toBe('oap_unreachable');
    const count = await call('payments', `/api/alarms/count?${WINDOW}`, fakeOap(rows, { down: true }));
    expect(count.status).toBe(503);
    expect(count.body.error).toBe('oap_unreachable');
  });

  it('answers 503 when the service catalog cannot be read', async () => {
    const list = await call('payments', `/api/alarms?${WINDOW}`, fakeOap(ROWS), true);
    expect(list.status).toBe(503);
    expect(list.body.error).toBe('catalog_unavailable');
    const count = await call('payments', `/api/alarms/count?${WINDOW}`, fakeOap(ROWS), true);
    expect(count.body.error).toBe('catalog_unavailable');
  });
});

// An overview widget bound to one service group filters by `GENERAL[payments]`.
describe('a layer filter on one service group', () => {
  it('keeps the alarms of that group\'s services, a relation across groups under each', async () => {
    const payments = await call('ops', `/api/alarms?${WINDOW}&layer=GENERAL[payments]`, fakeOap(ROWS));
    expect(payments.status).toBe(200);
    expect(names(payments.body)).toEqual([CHECKOUT.name, INBOUND.name, OUTBOUND.name]);
    const risk = await call('ops', `/api/alarms?${WINDOW}&layer=general[risk]`, fakeOap(ROWS));
    expect(names(risk.body)).toEqual([INBOUND.name, OUTBOUND.name, SCORER.name]);
  });

  it('keeps the group as written, and reads an empty group as the services with none', async () => {
    const cased = await call('ops', `/api/alarms?${WINDOW}&layer=GENERAL[Payments]`, fakeOap(ROWS));
    expect(names(cased.body)).toEqual([]);
    const ungrouped = await call('ops', `/api/alarms?${WINDOW}&layer=BANYANDB[-]`, fakeOap(ROWS));
    expect(names(ungrouped.body)).toEqual([BDB.name]);
  });

  it('refuses a filter that names no layer, rather than reading every one', async () => {
    for (const layer of ['GENERAL~payments', 'GENERAL[]']) {
      const res = await call('ops', `/api/alarms?${WINDOW}&layer=${encodeURIComponent(layer)}`, fakeOap(ROWS));
      expect(res.status, layer).toBe(400);
    }
  });

  it('narrows only what the grant already reads', async () => {
    const list = await call('payments', `/api/alarms?${WINDOW}&layer=GENERAL[risk]`, fakeOap(ROWS));
    expect(list.status).toBe(200);
    expect(names(list.body)).toEqual([INBOUND.name, OUTBOUND.name]);
  });
});

describe('alarms:read on a layer\'s group, naming a service', () => {
  it('reads that service\'s alarms, a relation into it included whole', async () => {
    const oap = fakeOap(ROWS);
    const list = await call('payments', `/api/alarms?${WINDOW}&service=${encodeURIComponent(checkout.name)}&normal=true`, oap);
    expect(list.status).toBe(200);
    expect(oap.alarmReads[0]!.entities).toBeUndefined();
    expect(names(list.body)).toEqual([CHECKOUT.name, INBOUND.name, OUTBOUND.name]);
    expect(msgs(list.body).map((m) => m.snapshot.metrics.length)).toEqual([1, 1, 1]);
  });

  it('is refused a service it does not read', async () => {
    const list = await call('payments', `/api/alarms?${WINDOW}&service=${encodeURIComponent(scorer.name)}&normal=true`, fakeOap(ROWS));
    expect(list.status).toBe(403);
    expect(list.body.reason).toBe('service_not_granted');
  });
});
