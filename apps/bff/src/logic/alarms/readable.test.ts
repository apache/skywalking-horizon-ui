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

import { describe, expect, it } from 'vitest';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionAccess } from '../../rbac/layer-access.js';
import { RequestAccess } from '../../rbac/request-access.js';
import { ServiceIdentityResolver, ServiceLookupUnavailable, catalogIndex, serviceIdOf } from '../services/service-identity.js';
import type { ServiceCatalog, ServiceLayerCatalog } from '../services/service-layer-catalog.js';
import { AlarmRowAccess, readsEveryAlarm } from './readable.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const svc = (name: string, group = '', normal = true) => ({ id: serviceIdOf(name, normal), name, normal, group });

const checkout = svc('payments::checkout', 'payments');
const scorer = svc('risk::scorer', 'risk');
const bdb = svc('showcase-banyandb');
const mysql = svc('localhost:3306', '', false);
const reports = svc('reports', 'payments');
const reportsRisk = svc('reports', 'risk', false);

const snapshot: ServiceCatalog = {
  layers: ['GENERAL', 'SO11Y_JAVA_AGENT', 'BANYANDB', 'VIRTUAL_DATABASE', 'MESH'],
  byLayer: new Map([
    ['GENERAL', [checkout, scorer, reports]],
    ['SO11Y_JAVA_AGENT', [checkout]],
    ['BANYANDB', [bdb]],
    ['VIRTUAL_DATABASE', [mysql]],
    ['MESH', [reportsRisk]],
  ]),
  byName: new Map(),
};

const cfg = configSchema.parse({});
const config: ConfigSource = { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
const facts = { isOperate: (l: string) => l === 'BANYANDB' || l === 'SO11Y_JAVA_AGENT', canonical: (l: string) => l.toUpperCase() };

const ROLES = {
  ops: ['alarms:read', 'cluster:read'],
  viewer: ['alarms:read'],
  general: ['alarms:read@GENERAL'],
  payments: ['alarms:read@GENERAL[payments]'],
  paymentsAndMeshRisk: ['alarms:read@GENERAL[payments]', 'alarms:read@MESH[risk]'],
};

/** OAP's `getService`, by id; anything else is a service OAP does not know. */
function oap(known: Record<string, { group: string; layers: string[] }> = {}, down = false) {
  const asked: string[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const { variables } = JSON.parse(String(init?.body ?? '{}')) as { variables: { id: string } };
    asked.push(variables.id);
    if (down) throw new Error('connect ECONNREFUSED');
    const hit = known[variables.id];
    const service = hit ? { id: variables.id, name: 'x', normal: true, ...hit } : null;
    return new Response(JSON.stringify({ data: { service } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, asked };
}

function rowsFor(role: keyof typeof ROLES, fetch: FetchLike = oap().fetch): { access: RequestAccess; rows: AlarmRowAccess } {
  const catalog = { get: async () => snapshot } as unknown as ServiceLayerCatalog;
  const services = new ServiceIdentityResolver({ config, fetch, catalog });
  const access = new RequestAccess(new SessionAccess(ROLES[role], undefined, facts), services);
  return { access, rows: new AlarmRowAccess(access, catalogIndex(snapshot)) };
}

const service = (s: { id: string; name: string }) => ({ scope: 'Service', id: s.id, name: s.name });
const relation = (from: { id: string; name: string }, to: string) => ({ scope: 'ServiceRelation', id: from.id, name: `${from.name} to ${to}` });
const all = { scope: 'All', id: '', name: 'the whole deployment' };
const values = () => ({ expression: 'x > 1', metrics: [{ name: 'x', results: [] }] });

describe('a reader of every layer', () => {
  it('keeps every row whole and asks OAP nothing', async () => {
    const o = oap();
    const { access, rows } = rowsFor('ops', o.fetch);
    expect(readsEveryAlarm(access)).toBe(true);
    expect(readsEveryAlarm(undefined)).toBe(true);
    for (const m of [service(bdb), service(svc('ghost')), all, relation(scorer, checkout.name)]) {
      expect(await rows.keeps(m)).toBe(true);
    }
    expect(o.asked).toEqual([]);
  });
});

describe('a plain alarms:read without cluster:read', () => {
  it('drops a service only in an operate layer, and keeps one also in GENERAL', async () => {
    const { access, rows } = rowsFor('viewer');
    expect(readsEveryAlarm(access)).toBe(false);
    expect(await rows.keeps(service(bdb))).toBe(false);
    expect(await rows.keeps(service(checkout))).toBe(true);
    expect(await rows.keeps({ scope: 'ServiceInstance', id: `${bdb.id}_${b64('bdb-0')}`, name: 'bdb-0 of showcase-banyandb' })).toBe(false);
  });

  it('keeps a row no service owns', async () => {
    expect(await rowsFor('viewer').rows.keeps(all)).toBe(true);
    expect(await rowsFor('viewer').rows.keeps({ scope: 'Process', id: 'a1b2', name: 'p' })).toBe(true);
  });
});

describe('alarms:read on a layer', () => {
  it('keeps the rows of the layer\'s services and drops the others', async () => {
    const { rows } = rowsFor('general');
    expect(await rows.keeps(service(checkout))).toBe(true);
    expect(await rows.keeps(service(scorer))).toBe(true);
    expect(await rows.keeps(service(mysql))).toBe(false);
    expect(await rows.keeps(service(bdb))).toBe(false);
  });

  it('drops a row no service owns', async () => {
    expect(await rowsFor('general').rows.keeps(all)).toBe(false);
  });
});

describe('alarms:read on a layer\'s group', () => {
  it('keeps the group\'s services only', async () => {
    const { rows } = rowsFor('payments');
    expect(await rows.keeps(service(checkout))).toBe(true);
    expect(await rows.keeps(service(scorer))).toBe(false);
    expect(await rows.keeps({ scope: 'Endpoint', id: `${checkout.id}_${b64('POST:/pay')}`, name: 'POST:/pay in payments::checkout' })).toBe(true);
  });

  it('keeps a relation from a readable source whole', async () => {
    expect(await rowsFor('payments').rows.keeps(relation(checkout, scorer.name))).toBe(true);
  });

  it('keeps a relation read only through its destination whole, values included', async () => {
    const { rows } = rowsFor('payments');
    const m = { ...relation(scorer, checkout.name), snapshot: values() };
    expect(await rows.decide([m])).toEqual([{ row: m, kept: true }]);
  });

  // `reports` is a payments service in GENERAL and a conjectured risk one in
  // MESH, and OAP does not return which the relation called.
  it('drops a relation whose destination may be a service out of reach', async () => {
    expect(await rowsFor('payments').rows.keeps(relation(scorer, 'reports'))).toBe(false);
  });

  it('keeps it when every service the destination may be is readable', async () => {
    expect(await rowsFor('paymentsAndMeshRisk').rows.keeps(relation(scorer, 'reports'))).toBe(true);
  });

  it('drops a relation whose destination the catalog does not know', async () => {
    expect(await rowsFor('payments').rows.keeps(relation(scorer, 'nobody-known'))).toBe(false);
  });

  it('drops a row no service owns', async () => {
    expect(await rowsFor('payments').rows.keeps(all)).toBe(false);
  });

  it('decides every row of a batch, keeping what it may see', async () => {
    const { rows } = rowsFor('payments');
    const batch = [service(checkout), service(scorer), relation(scorer, checkout.name)].map((m) => ({ ...m, snapshot: values() }));
    const decided = await rows.decide(batch);
    expect(decided.map((d) => d.kept)).toEqual([true, false, true]);
    expect(decided.map((d) => d.row.snapshot.metrics.length)).toEqual([1, 1, 1]);
  });
});

describe('a source the catalog does not hold', () => {
  it('asks OAP once per id, and decides by what OAP answers', async () => {
    const ghost = svc('payments::ghost', 'payments');
    const o = oap({ [ghost.id]: { group: 'payments', layers: ['GENERAL'] } });
    const { rows } = rowsFor('payments', o.fetch);
    expect(await rows.keeps(service(ghost))).toBe(true);
    expect(await rows.keeps({ scope: 'ServiceInstance', id: `${ghost.id}_${b64('g-1')}`, name: 'g-1 of payments::ghost' })).toBe(true);
    expect(o.asked).toEqual([ghost.id]);
  });

  it('keeps a relation from a service OAP files in no layer through its destination', async () => {
    const user = svc('User', '', false);
    const o = oap({ [user.id]: { group: '', layers: [] } });
    const m = { scope: 'EndpointRelation', id: `${user.id}_${b64('User')}`, name: 'User in User to POST:/pay in payments::checkout' };
    expect(await rowsFor('payments', o.fetch).rows.keeps(m)).toBe(true);
  });

  it('throws when OAP could not be asked, rather than dropping the row', async () => {
    const { rows } = rowsFor('payments', oap({}, true).fetch);
    await expect(rows.keeps(service(svc('payments::ghost', 'payments')))).rejects.toBeInstanceOf(ServiceLookupUnavailable);
  });
});

