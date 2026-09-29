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
 * `/api/alarms` with a named alarm page, and with a service picked alone,
 * through the real scope gate and grants.
 *
 * The fake OAP matches an entity filter the way OAP does — the entity's own id
 * (`id0`) or the relation destination's (`id1`), which OAP keeps and does not
 * return — so a Service entity drops the service's instance, endpoint and
 * child-relation alarms here as it does there.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { FetchLike, UITemplateClient, UITemplateRow } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { ServiceIdentityResolver, serviceIdOf } from '../../logic/services/service-identity.js';
import type { ServiceCatalog, ServiceLayerCatalog } from '../../logic/services/service-layer-catalog.js';
import { _resetCapabilitiesCache } from '../../logic/oap/capabilities.js';
import { buildEnvelope, serializeEnvelope } from '../../logic/templates/names.js';
import { resetTemplateSyncState } from '../../logic/templates/sync.js';
import { logger } from '../../logger.js';
import { registerAlarmsQueryRoutes } from './alarms.js';

const NOW = 1_700_000_000_000;
const WINDOW = `startTime=${NOW - 600_000}&endTime=${NOW}`;

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const svc = (name: string, group = '', normal = true) => ({ id: serviceIdOf(name, normal), name, normal, group });
const checkout = svc('payments::checkout', 'payments');
const scorer = svc('risk::scorer', 'risk');
const bdb = svc('showcase-banyandb');
/** The agent's virtual `User` service, in no layer the catalog lists. */
const user = serviceIdOf('User', false);
const child = (serviceId: string, name: string) => `${serviceId}_${b64(name)}`;

const CATALOG: ServiceCatalog = {
  layers: ['GENERAL', 'BANYANDB'],
  byLayer: new Map([
    ['GENERAL', [checkout, scorer]],
    ['BANYANDB', [bdb]],
  ]),
  byName: new Map(),
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
/** A row as OAP stores it: with the destination id it does not return. */
type Stored = Row & { destId?: string };

let seq = 0;
function row(scope: string, id: string, name: string, destId?: string): Stored {
  seq += 1;
  return { id, startTime: NOW - 60_000 - seq, recoveryTime: null, scope, name, message: name, tags: [], snapshot: { expression: `rule-${seq}`, metrics: [] }, destId };
}

const CHECKOUT = row('Service', checkout.id, checkout.name);
const CHECKOUT_1 = row('ServiceInstance', child(checkout.id, 'checkout-1'), 'checkout-1 of payments::checkout');
const CHECKOUT_EP = row('Endpoint', child(checkout.id, 'POST:/pay'), 'POST:/pay in payments::checkout');
const TO_SCORER = row('ServiceRelation', checkout.id, 'payments::checkout to risk::scorer', scorer.id);
const FROM_SCORER = row('ServiceRelation', scorer.id, 'risk::scorer to payments::checkout', checkout.id);
const INSTANCE_FROM_SCORER = row(
  'ServiceInstanceRelation',
  child(scorer.id, 'scorer-1'),
  'scorer-1 of risk::scorer to checkout-1 of payments::checkout',
  child(checkout.id, 'checkout-1'),
);
const ENDPOINT_FROM_USER = row('EndpointRelation', child(user, 'User'), 'User in User to POST:/users in payments::checkout', child(checkout.id, 'POST:/users'));
const SCORER = row('Service', scorer.id, scorer.name);
const SCORER_1 = row('ServiceInstance', child(scorer.id, 'scorer-1'), 'scorer-1 of risk::scorer');
const BDB = row('Service', bdb.id, bdb.name);
const ALL = row('All', '', 'the deployment');
const ROWS = [CHECKOUT, CHECKOUT_1, CHECKOUT_EP, TO_SCORER, FROM_SCORER, INSTANCE_FROM_SCORER, ENDPOINT_FROM_USER, SCORER, SCORER_1, BDB, ALL];
const CHECKOUTS = [CHECKOUT, CHECKOUT_1, CHECKOUT_EP, TO_SCORER, FROM_SCORER, INSTANCE_FROM_SCORER, ENDPOINT_FROM_USER];
const RISKS = [TO_SCORER, FROM_SCORER, INSTANCE_FROM_SCORER, SCORER, SCORER_1];

const ROLES = {
  ops: ['alarms:read', 'cluster:read'],
  general: ['alarms:read@GENERAL'],
  payments: ['alarms:read@GENERAL[payments]'],
  paymentsAndStorage: ['alarms:read@GENERAL[payments]', 'alarms:read@BANYANDB'],
};

const template = (key: string, content: unknown): UITemplateRow =>
  ({ id: key, disabled: false, configuration: serializeEnvelope(buildEnvelope('alert', key, content)) }) as UITemplateRow;
const page = (id: string, pinnedLayers: string[]) => template(id, { id, title: id, pinnedLayers });

const STORE: UITemplateRow[] = [
  template('default', { pinnedLayers: ['GENERAL'], defaultWindowMs: 1_200_000, overviewAlarmsLimit: 200 }),
  page('risk', ['GENERAL[risk]']),
  page('mixed', ['GENERAL[risk]', 'BANYANDB']),
];

interface AlarmRead {
  pageNum: number;
  pageSize: number;
  keyword?: string;
  entities?: unknown;
}
interface Oap {
  fetch: FetchLike;
  alarmReads: AlarmRead[];
  /** The ids `getService` was asked about. */
  serviceAsks: string[];
}
/** A service OAP holds beyond the catalog's read. */
type Beyond = { name: string; normal: boolean; group: string; layers: string[] };

interface EntityWire {
  scope: string;
  serviceName: string;
  normal: boolean;
  serviceInstanceName?: string;
  endpointName?: string;
}

function entityId(e: EntityWire): string {
  const service = serviceIdOf(e.serviceName, e.normal);
  if (e.scope === 'ServiceInstance') return child(service, e.serviceInstanceName ?? '');
  if (e.scope === 'Endpoint') return child(service, e.endpointName ?? '');
  return service;
}

function fakeOap(rows: Stored[], opts: { legacy?: boolean; down?: boolean; services?: Record<string, Beyond> } = {}): Oap {
  const alarmReads: AlarmRead[] = [];
  const serviceAsks: string[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetch: FetchLike = async (_url, init) => {
    const { query = '', variables = {} } = JSON.parse(String(init?.body ?? '{}')) as { query?: string; variables?: Record<string, unknown> };
    if (query.includes('__type')) return json({ data: { __type: { fields: opts.legacy ? [] : [{ name: 'queryAlarms' }] } } });
    if (query.includes('getTimeInfo')) return json({ data: { time: { timezone: '+0000' } } });
    if (query.includes('HorizonAccessService')) {
      const id = String(variables.id);
      serviceAsks.push(id);
      if (opts.down) throw new Error('connect ECONNREFUSED');
      const hit = opts.services?.[id];
      return json({ data: { service: hit ? { id, ...hit } : null } });
    }
    if (query.includes('HorizonAlarmServices')) {
      const layer = String(variables.layer);
      return json({ data: { listServices: CATALOG.byLayer.get(layer) ?? [] } });
    }
    if (query.includes('queryAlarms') || query.includes('getAlarm')) {
      const c = (variables.condition ?? variables) as { paging: { pageNum: number; pageSize: number }; keyword?: string; entities?: EntityWire[] };
      alarmReads.push({ ...c.paging, keyword: c.keyword, entities: c.entities });
      const ids = c.entities?.map(entityId);
      const matched = rows
        .filter((m) => !ids || ids.some((id) => m.id === id || m.destId === id))
        .filter((m) => !c.keyword || m.message.includes(c.keyword));
      const from = (c.paging.pageNum - 1) * c.paging.pageSize;
      const msgs = matched.slice(from, from + c.paging.pageSize).map(({ destId: _, ...m }) => m);
      return json({ data: query.includes('queryAlarms') ? { queryAlarms: { msgs } } : { getAlarm: { msgs } } });
    }
    return json({ data: {} });
  };
  return { fetch, alarmReads, serviceAsks };
}

let app: FastifyInstance | null = null;
beforeEach(() => {
  _resetCapabilitiesCache();
  resetTemplateSyncState();
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});
afterEach(async () => {
  await app?.close();
  app = null;
  resetTemplateSyncState();
  vi.restoreAllMocks();
});

interface Setup {
  store?: UITemplateRow[] | 'unreachable';
  catalogUnreachable?: boolean;
  /** Another alarm route, instead of the list. */
  url?: string;
}

async function call(role: keyof typeof ROLES, query: string, oap: Oap, setup: Setup = {}) {
  const cfg = configSchema.parse({ rbac: { roles: ROLES } });
  const config: ConfigSource = { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
  const snapshot: ServiceCatalog = setup.catalogUnreachable
    ? { layers: [], byLayer: new Map(), byName: new Map(), unreachable: true }
    : { ...CATALOG };
  const catalog = { get: async () => snapshot } as unknown as ServiceLayerCatalog;
  const store = setup.store ?? STORE;
  let storeReads = 0;
  const uiTemplateClient = (): UITemplateClient =>
    ({
      list: async () => {
        storeReads += 1;
        if (store === 'unreachable') throw new Error('ECONNREFUSED');
        return store.map((r) => ({ ...r }));
      },
      create: () => Promise.reject(new Error('reading alarms must not write to OAP')),
      update: () => Promise.reject(new Error('reading alarms must not write to OAP')),
      disable: () => Promise.reject(new Error('reading alarms must not write to OAP')),
    }) as unknown as UITemplateClient;
  const access = {
    services: new ServiceIdentityResolver({ config, fetch: oap.fetch, catalog }),
    classify: async () => ({ isOperate: (l: string) => l === 'BANYANDB' }),
  };
  const sessions = new SessionStore({ ttlMinutes: 60 });
  app = Fastify();
  await app.register(cookie);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions, access }));
  registerAlarmsQueryRoutes(app, { config, sessions, serviceLayer: catalog, uiTemplateClient, fetch: oap.fetch });
  await app.ready();
  const sid = sessions.create(role, [role]).sid;
  const res = await app.inject({ method: 'GET', url: setup.url ?? `/api/alarms?${WINDOW}${query}`, headers: { cookie: `horizon_sid=${sid}` } });
  const body = res.json() as Record<string, unknown>;
  await app.close();
  app = null;
  return { status: res.statusCode, body, storeReads };
}

const names = (body: Record<string, unknown>) => (body.msgs as Row[]).map((m) => m.name);
const namesOf = (rows: Row[]) => rows.map((m) => m.name);
const SERVICE = `&service=${encodeURIComponent(checkout.name)}&normal=true`;

describe('a named page', () => {
  it('keeps only the alarms its pins cover, a relation into the pinned group included', async () => {
    const res = await call('general', '&page=risk', fakeOap(ROWS));
    expect(res.status).toBe(200);
    expect(names(res.body)).toEqual(namesOf(RISKS));
    expect(res.body.truncated).toBe(false);
    // The pins the rows were read by travel with them, so the page draws those.
    expect(res.body.pinnedLayers).toEqual(['GENERAL[risk]']);
    expect((await call('general', '', fakeOap(ROWS))).body.pinnedLayers).toBeUndefined();
  });

  it('covers only the pins as served to the caller: a pin they reach nothing of adds no rows', async () => {
    // TO_SCORER / FROM_SCORER are the caller's through their payments end, and
    // fit the page's `GENERAL[risk]` pin — which the caller is not served.
    const res = await call('paymentsAndStorage', '&page=mixed', fakeOap(ROWS));
    expect(res.status).toBe(200);
    expect(names(res.body)).toEqual([BDB.name]);
  });

  it('is not found when it does not exist, or none of its pins is served to the caller', async () => {
    const oap = fakeOap(ROWS);
    const unknown = await call('ops', '&page=nope', oap);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('alarm_page_not_found');
    const unserved = await call('payments', '&page=risk', oap);
    expect(unserved.status).toBe(404);
    expect(unserved.body.error).toBe('alarm_page_not_found');
    expect(oap.alarmReads).toEqual([]);
  });

  it('answers 503 when the template store cannot be read, never reading alarms without the page', async () => {
    const oap = fakeOap(ROWS);
    const res = await call('ops', '&page=risk', oap, { store: 'unreachable' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('template_store_unreachable');
    expect(oap.alarmReads).toEqual([]);
  });

  it('reads the default page as no page at all, without the store', async () => {
    const res = await call('ops', '&page=default', fakeOap(ROWS), { store: 'unreachable' });
    expect(res.status).toBe(200);
    expect(names(res.body)).toEqual(namesOf(ROWS));
    expect(res.storeReads).toBe(0);
  });

  it('composes with a layer filter, a keyword and a picked service', async () => {
    const layered = await call('ops', '&page=risk&layer=GENERAL[payments]', fakeOap(ROWS));
    expect(names(layered.body)).toEqual(namesOf([TO_SCORER, FROM_SCORER, INSTANCE_FROM_SCORER]));

    const oap = fakeOap(ROWS);
    const keyword = await call('ops', '&page=risk&keyword=scorer-1', oap);
    expect(oap.alarmReads[0]!.keyword).toBe('scorer-1');
    expect(names(keyword.body)).toEqual(namesOf([INSTANCE_FROM_SCORER, SCORER_1]));
    const elsewhere = await call('ops', '&page=risk&keyword=POST%3A%2Fpay', fakeOap(ROWS));
    expect(names(elsewhere.body)).toEqual([]);

    const service = await call('ops', `&page=risk${SERVICE}`, fakeOap(ROWS));
    expect(names(service.body)).toEqual(namesOf([TO_SCORER, FROM_SCORER, INSTANCE_FROM_SCORER]));
  });

  it('is filled from past the rows other pages\' alarms fill, every read from row 0', async () => {
    const others = Array.from({ length: 600 }, () => row('Service', checkout.id, checkout.name));
    const oap = fakeOap([...others, SCORER, SCORER_1]);
    const res = await call('ops', '&page=risk&pageSize=200', oap);
    expect(names(res.body)).toEqual(namesOf([SCORER, SCORER_1]));
    expect(res.body.truncated).toBe(false);
    expect(oap.alarmReads.every((r) => r.pageNum === 1)).toBe(true);
  });
});

describe('the service choices on a named page', () => {
  const choices = async (role: keyof typeof ROLES, url: string, setup: Setup = {}) => {
    const res = await call(role, '', fakeOap(ROWS), { ...setup, url });
    return { status: res.status, names: ((res.body.services ?? []) as Array<{ name: string }>).map((s) => s.name), body: res.body };
  };

  it('offer only the services the page covers, where the list of the layer offers every one the caller reads', async () => {
    expect((await choices('general', '/api/alarms/services?layer=GENERAL')).names).toEqual([checkout.name, scorer.name]);
    expect((await choices('general', '/api/alarms/services?layer=GENERAL&page=risk')).names).toEqual([scorer.name]);
    expect((await choices('general', '/api/alarms/services?layer=GENERAL&page=default')).names).toEqual([checkout.name, scorer.name]);
  });

  it('offer nothing for a layer the page does not pin, and the page must be served to the caller', async () => {
    expect((await choices('ops', '/api/alarms/services?layer=BANYANDB&page=risk')).names).toEqual([]);
    const unserved = await choices('payments', '/api/alarms/services?layer=GENERAL&page=risk');
    expect(unserved.status).toBe(404);
    expect(unserved.body.error).toBe('alarm_page_not_found');
  });

  it('answer 503 when the template store cannot be read', async () => {
    expect((await choices('general', '/api/alarms/services?layer=GENERAL&page=risk', { store: 'unreachable' })).status).toBe(503);
  });
});

describe('a service picked alone', () => {
  it('keeps every alarm the service owns or a relation into it, and sends OAP no entity', async () => {
    const oap = fakeOap(ROWS);
    const res = await call('ops', SERVICE, oap);
    expect(res.status).toBe(200);
    expect(oap.alarmReads[0]!.entities).toBeUndefined();
    expect(names(res.body)).toEqual(namesOf(CHECKOUTS));
  });

  it('keeps the same rows the unfiltered list counts under the service', async () => {
    const byService = await call('ops', SERVICE, fakeOap(ROWS));
    // Checkout is the only service of the payments group.
    const byGroup = await call('ops', '&layer=GENERAL[payments]', fakeOap(ROWS));
    expect(names(byService.body)).toEqual(names(byGroup.body));
  });

  it('serves a group grant its service, asking only about the rows it lists', async () => {
    const elsewhere = svc('elsewhere::ghost');
    const oap = fakeOap([...ROWS, row('Service', elsewhere.id, elsewhere.name)]);
    const res = await call('payments', SERVICE, oap);
    expect(res.status).toBe(200);
    expect(names(res.body)).toEqual(namesOf(CHECKOUTS));
    expect(oap.serviceAsks).not.toContain(elsewhere.id);
  });

  // The catalog was read before a conjectured risk `payments::checkout`
  // registered: a relation that names it only as its destination may mean
  // either, so it is the payments reader's only when both are.
  it('drops a relation into the picked service that may mean an unreadable namesake', async () => {
    const namesake = { name: checkout.name, normal: false, group: 'risk', layers: ['GENERAL'] };
    const oap = fakeOap(ROWS, { services: { [serviceIdOf(checkout.name, false)]: namesake } });
    const res = await call('payments', SERVICE, oap);
    expect(res.status).toBe(200);
    expect(names(res.body)).toEqual(namesOf([CHECKOUT, CHECKOUT_1, CHECKOUT_EP, TO_SCORER]));
    expect(names((await call('ops', SERVICE, fakeOap(ROWS, { services: { [serviceIdOf(checkout.name, false)]: namesake } }))).body)).toEqual(
      namesOf(CHECKOUTS),
    );
  });

  it('says OAP could not be asked, rather than listing a relation it could not decide', async () => {
    expect((await call('payments', SERVICE, fakeOap(ROWS, { down: true }))).status).toBe(503);
  });

  it('is still refused a service the grant does not read', async () => {
    const res = await call('payments', `&service=${encodeURIComponent(scorer.name)}&normal=true`, fakeOap(ROWS));
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('service_not_granted');
  });

  it('still sends the keyword to OAP', async () => {
    const oap = fakeOap(ROWS);
    const res = await call('ops', `${SERVICE}&keyword=checkout-1`, oap);
    expect(oap.alarmReads[0]).toMatchObject({ keyword: 'checkout-1', entities: undefined });
    expect(names(res.body)).toEqual(namesOf([CHECKOUT_1, INSTANCE_FROM_SCORER]));
  });

  it('answers 503 when the service catalog cannot be read, since a relation into it is told by the catalog', async () => {
    const res = await call('ops', SERVICE, fakeOap(ROWS), { catalogUnreachable: true });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('catalog_unavailable');
  });

  it('is ignored by the legacy query, as the rest of the cascade is', async () => {
    const res = await call('ops', SERVICE, fakeOap(ROWS, { legacy: true }));
    expect(res.status).toBe(200);
    expect(names(res.body)).toEqual(namesOf(ROWS));
  });
});

describe('a picked instance or endpoint', () => {
  it('is sent to OAP as the exact entity', async () => {
    const oap = fakeOap(ROWS);
    const res = await call('ops', `${SERVICE}&instance=checkout-1`, oap);
    expect(oap.alarmReads[0]!.entities).toEqual([
      { scope: 'ServiceInstance', serviceName: checkout.name, normal: true, serviceInstanceName: 'checkout-1' },
    ]);
    expect(names(res.body)).toEqual(namesOf([CHECKOUT_1, INSTANCE_FROM_SCORER]));

    const endpoint = fakeOap(ROWS);
    const byEndpoint = await call('ops', `${SERVICE}&endpoint=POST%3A%2Fpay`, endpoint);
    expect(endpoint.alarmReads[0]!.entities).toEqual([{ scope: 'Endpoint', serviceName: checkout.name, normal: true, endpointName: 'POST:/pay' }]);
    expect(names(byEndpoint.body)).toEqual([CHECKOUT_EP.name]);
  });

  // OAP matched the relation on the picked instance's exact id, so a
  // conjectured namesake of its service cannot be what the relation meant.
  it('keeps a relation into it for a group grant, whatever namesake its service has', async () => {
    const namesake = { name: checkout.name, normal: false, group: 'risk', layers: ['GENERAL'] };
    const oap = fakeOap(ROWS, { services: { [serviceIdOf(checkout.name, false)]: namesake } });
    const res = await call('payments', `${SERVICE}&instance=checkout-1`, oap);
    expect(res.status).toBe(200);
    expect(names(res.body)).toEqual(namesOf([CHECKOUT_1, INSTANCE_FROM_SCORER]));
  });

  it('asks OAP nothing about the rows it returns', async () => {
    const oap = fakeOap(ROWS, { down: true });
    const res = await call('payments', `${SERVICE}&instance=checkout-1`, oap);
    expect(res.status).toBe(200);
    expect(names(res.body)).toEqual(namesOf([CHECKOUT_1, INSTANCE_FROM_SCORER]));
  });
});
