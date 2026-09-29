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
import { catalogIndex, serviceIdOf } from '../services/service-identity.js';
import type { ServiceCatalog } from '../services/service-layer-catalog.js';
import { alarmConcernsService, alarmDestinations, alarmIncidentKey, alarmLayers, alarmOwners, alarmSourceId, isRelationAlarm } from './owners.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const svc = (name: string, group = '', normal = true) => ({ id: serviceIdOf(name, normal), name, normal, group });

const checkout = svc('payments::checkout', 'payments');
const ledger = svc('payments::ledger', 'payments');
const mysql = svc('localhost:3306', '', false);

const index = catalogIndex({
  layers: ['SO11Y_JAVA_AGENT', 'GENERAL', 'VIRTUAL_DATABASE'],
  byLayer: new Map([
    ['SO11Y_JAVA_AGENT', [checkout]],
    ['GENERAL', [checkout, ledger]],
    ['VIRTUAL_DATABASE', [mysql]],
  ]),
  byName: new Map(),
} as ServiceCatalog);

describe('the layers an alarm belongs to', () => {
  it('reads the owner service of an instance or an endpoint from its id, with every layer it is in', () => {
    expect(
      alarmLayers({ scope: 'ServiceInstance', id: `${checkout.id}_${b64('checkout-1')}`, name: 'checkout-1 of payments::checkout' }, index),
    ).toEqual(['SO11Y_JAVA_AGENT', 'GENERAL']);
    expect(alarmLayers({ scope: 'Endpoint', id: `${ledger.id}_${b64('POST:/users')}`, name: 'POST:/users in payments::ledger' }, index)).toEqual([
      'GENERAL',
    ]);
    expect(alarmLayers({ scope: 'Service', id: ledger.id, name: ledger.name }, index)).toEqual(['GENERAL']);
  });

  it('includes both ends of a relation, the destination read from the name', () => {
    expect(alarmLayers({ scope: 'ServiceRelation', id: ledger.id, name: 'payments::ledger to localhost:3306' }, index)).toEqual([
      'GENERAL',
      'VIRTUAL_DATABASE',
    ]);
    expect(
      alarmLayers(
        { scope: 'ServiceInstanceRelation', id: `${ledger.id}_${b64('ledger-1')}`, name: 'ledger-1 of payments::ledger to localhost:3306 of localhost:3306' },
        index,
      ),
    ).toEqual(['GENERAL', 'VIRTUAL_DATABASE']);
  });

  it('places a relation from a virtual source OAP files in no layer by its destination', () => {
    // The live shape: the agent's `User` service calling an endpoint.
    const user = serviceIdOf('User', false);
    const name = 'User in User to POST:/users in payments::checkout';
    expect(alarmLayers({ scope: 'EndpointRelation', id: `${user}_${b64('User')}`, name }, index)).toEqual(['SO11Y_JAVA_AGENT', 'GENERAL']);
  });

  it('finds the destination service when the endpoint name itself contains " in "', () => {
    const name = 'POST:/users in payments::checkout to GET /report in eu in payments::ledger';
    expect(alarmLayers({ scope: 'EndpointRelation', id: `${checkout.id}_${b64('POST:/users')}`, name }, index)).toEqual([
      'SO11Y_JAVA_AGENT',
      'GENERAL',
    ]);
  });

  // OAP returns no destination id, so a name that fits two services adds only
  // what both are: the service is one of them, and nothing says which.
  it('gives a destination the name fits to two services only the layers both are in', () => {
    const real = svc('reports', 'payments');
    const conjectured = svc('reports', '', false);
    const other = svc('eu in reports', 'payments');
    const ambiguous = catalogIndex({
      layers: ['GENERAL', 'MESH', 'VIRTUAL_DATABASE'],
      byLayer: new Map([
        ['GENERAL', [ledger, real, other]],
        ['MESH', [real]],
        ['VIRTUAL_DATABASE', [conjectured]],
      ]),
      byName: new Map(),
    } as ServiceCatalog);
    // A normal and a conjectured `reports`, in no common layer.
    expect(alarmLayers({ scope: 'ServiceRelation', id: ledger.id, name: 'payments::ledger to reports' }, ambiguous)).toEqual(['GENERAL']);
    // `GET /x in eu` of `reports`, or `GET /x` of `eu in reports`: both GENERAL, only one MESH.
    const name = 'POST:/users in payments::ledger to GET /x in eu in reports';
    const noConjectured = catalogIndex({
      layers: ['GENERAL', 'MESH'],
      byLayer: new Map([
        ['GENERAL', [ledger, real, other]],
        ['MESH', [real]],
      ]),
      byName: new Map(),
    } as ServiceCatalog);
    expect(alarmLayers({ scope: 'EndpointRelation', id: `${ledger.id}_${b64('POST:/users')}`, name }, noConjectured)).toEqual(['GENERAL']);
    // With one service of that name, its every layer.
    const one = catalogIndex({ layers: ['GENERAL', 'MESH'], byLayer: new Map([['GENERAL', [ledger, real]], ['MESH', [real]]]), byName: new Map() } as ServiceCatalog);
    expect(alarmLayers({ scope: 'ServiceRelation', id: ledger.id, name: 'payments::ledger to reports' }, one)).toEqual(['GENERAL', 'MESH']);
  });

  it('is empty when no end is a service the catalog knows', () => {
    const ghost = serviceIdOf('ghost', true);
    expect(alarmLayers({ scope: 'ServiceInstance', id: `${ghost}_${b64('g-1')}`, name: 'g-1 of ghost' }, index)).toEqual([]);
    expect(alarmLayers({ scope: 'Process', id: 'a1b2c3', name: 'p' }, index)).toEqual([]);
  });
});

describe('the services an alarm concerns', () => {
  it('reads the source service from the entity id, and none for a scope no service owns', () => {
    const instance = `${checkout.id}_${b64('checkout-1')}`;
    expect(alarmSourceId({ scope: 'Service', id: ledger.id, name: ledger.name })).toBe(ledger.id);
    expect(alarmSourceId({ scope: 'ServiceRelation', id: ledger.id, name: 'payments::ledger to localhost:3306' })).toBe(ledger.id);
    expect(alarmSourceId({ scope: 'ServiceInstance', id: instance, name: 'checkout-1 of payments::checkout' })).toBe(checkout.id);
    expect(alarmSourceId({ scope: 'EndpointRelation', id: instance, name: 'x' })).toBe(checkout.id);
    expect(alarmSourceId({ scope: 'All', id: '', name: 'all' })).toBeNull();
    expect(alarmSourceId({ scope: 'Process', id: 'a1b2c3', name: 'p' })).toBeNull();
    expect(alarmSourceId({ scope: null, id: ledger.id, name: ledger.name })).toBeNull();
  });

  it('reads the destination candidates of a relation only', () => {
    expect(alarmDestinations({ scope: 'ServiceRelation', id: ledger.id, name: 'payments::ledger to localhost:3306' }, index)).toEqual([
      expect.objectContaining({ id: mysql.id }),
    ]);
    expect(alarmDestinations({ scope: 'Service', id: ledger.id, name: ledger.name }, index)).toEqual([]);
    expect(isRelationAlarm({ scope: 'ServiceInstanceRelation' })).toBe(true);
    expect(isRelationAlarm({ scope: 'ProcessRelation' })).toBe(true);
    expect(isRelationAlarm({ scope: 'Endpoint' })).toBe(false);
    expect(isRelationAlarm({ scope: null })).toBe(false);
  });
});

describe('whether an alarm concerns one service', () => {
  const user = serviceIdOf('User', false);
  const concerns = (m: { scope: string; id: string; name: string }, idx = index) => alarmConcernsService(m, checkout.id, idx);

  it('counts its own, its instances\', endpoints\' and relations\' alarms, from it or into it', () => {
    expect(concerns({ scope: 'Service', id: checkout.id, name: checkout.name })).toBe(true);
    expect(concerns({ scope: 'ServiceInstance', id: `${checkout.id}_${b64('checkout-1')}`, name: 'checkout-1 of payments::checkout' })).toBe(true);
    expect(concerns({ scope: 'Endpoint', id: `${checkout.id}_${b64('POST:/pay')}`, name: 'POST:/pay in payments::checkout' })).toBe(true);
    expect(concerns({ scope: 'ServiceRelation', id: checkout.id, name: 'payments::checkout to payments::ledger' })).toBe(true);
    expect(concerns({ scope: 'ServiceRelation', id: ledger.id, name: 'payments::ledger to payments::checkout' })).toBe(true);
    expect(concerns({ scope: 'EndpointRelation', id: `${user}_${b64('User')}`, name: 'User in User to POST:/users in payments::checkout' })).toBe(true);
    expect(
      concerns({ scope: 'ServiceInstanceRelation', id: `${ledger.id}_${b64('ledger-1')}`, name: 'ledger-1 of payments::ledger to checkout-1 of payments::checkout' }),
    ).toBe(true);
  });

  it('leaves out another service\'s alarms, the same name under the other flag, and a scope no service owns', () => {
    expect(concerns({ scope: 'Service', id: ledger.id, name: ledger.name })).toBe(false);
    expect(concerns({ scope: 'ServiceInstance', id: `${ledger.id}_${b64('ledger-1')}`, name: 'ledger-1 of payments::ledger' })).toBe(false);
    expect(concerns({ scope: 'ServiceRelation', id: ledger.id, name: 'payments::ledger to localhost:3306' })).toBe(false);
    expect(concerns({ scope: 'Service', id: serviceIdOf(checkout.name, false), name: checkout.name })).toBe(false);
    expect(concerns({ scope: 'All', id: '', name: 'payments::checkout' })).toBe(false);
  });

  it('does not count a relation whose destination name a namesake shares', () => {
    const namesake = svc(checkout.name, '', false);
    const both = catalogIndex({
      layers: ['GENERAL', 'VIRTUAL_DATABASE'],
      byLayer: new Map([
        ['GENERAL', [checkout, ledger]],
        ['VIRTUAL_DATABASE', [namesake]],
      ]),
      byName: new Map(),
    } as ServiceCatalog);
    expect(concerns({ scope: 'ServiceRelation', id: ledger.id, name: 'payments::ledger to payments::checkout' }, both)).toBe(false);
    expect(concerns({ scope: 'ServiceRelation', id: checkout.id, name: 'payments::checkout to payments::ledger' }, both)).toBe(true);
  });
});

describe('the layer-and-group pairs an alarm belongs to', () => {
  it('pairs every layer of the owner service with its group, and an ungrouped service with none', () => {
    expect(
      alarmOwners({ scope: 'ServiceInstance', id: `${checkout.id}_${b64('checkout-1')}`, name: 'checkout-1 of payments::checkout' }, index),
    ).toEqual([
      { layer: 'SO11Y_JAVA_AGENT', group: 'payments' },
      { layer: 'GENERAL', group: 'payments' },
    ]);
    expect(alarmOwners({ scope: 'ServiceRelation', id: ledger.id, name: 'payments::ledger to localhost:3306' }, index)).toEqual([
      { layer: 'GENERAL', group: 'payments' },
      { layer: 'VIRTUAL_DATABASE', group: '' },
    ]);
  });

  it('adds only the pairs every destination candidate shares, so a namesake in another group adds none', () => {
    const real = svc('reports', 'payments');
    const conjectured = svc('reports', 'risk', false);
    const both = catalogIndex({
      layers: ['GENERAL', 'MESH'],
      byLayer: new Map([['GENERAL', [ledger, real, conjectured]], ['MESH', [real]]]),
      byName: new Map(),
    } as ServiceCatalog);
    const m = { scope: 'ServiceRelation', id: ledger.id, name: 'payments::ledger to reports' };
    // Both are GENERAL, so the layer counts; their groups differ, so the
    // destination adds no pair — the one listed is the source's.
    expect(alarmLayers(m, both)).toEqual(['GENERAL']);
    expect(alarmOwners(m, both)).toEqual([{ layer: 'GENERAL', group: 'payments' }]);
  });

  it('is empty when no end is a service the catalog knows', () => {
    expect(alarmOwners({ scope: 'Service', id: serviceIdOf('ghost', true), name: 'ghost' }, index)).toEqual([]);
  });
});

describe('one incident per entity and rule', () => {
  it('keeps two rules on one service, and two relations from one source, apart', () => {
    const rule = (expression: string) => ({ scope: 'Service', id: checkout.id, name: checkout.name, snapshot: { expression } });
    expect(alarmIncidentKey(rule('avg(service_resp_time) > 1000'))).not.toBe(alarmIncidentKey(rule('service_percentile > 1000')));
    const user = `${serviceIdOf('User', false)}_${b64('User')}`;
    const relation = (dest: string) => ({ scope: 'EndpointRelation', id: user, name: `User in User to POST:/users in ${dest}` });
    expect(alarmIncidentKey(relation('payments::checkout'))).not.toBe(alarmIncidentKey(relation('risk::scorer')));
    expect(alarmIncidentKey(rule('x'))).toBe(alarmIncidentKey(rule('x')));
  });
});
