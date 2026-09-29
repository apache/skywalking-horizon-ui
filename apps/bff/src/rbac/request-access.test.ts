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
import { configSchema } from '../config/schema.js';
import type { ConfigSource } from '../config/loader.js';
import type { ServiceCatalog, ServiceLayerCatalog } from '../logic/services/service-layer-catalog.js';
import { isExactIdentity, RequestAccess } from './request-access.js';
import { ServiceIdentityResolver, ServiceLookupUnavailable, serviceIdOf } from '../logic/services/service-identity.js';
import { SessionAccess } from './layer-access.js';

const cfg = configSchema.parse({});
const config: ConfigSource = { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
const facts = { isOperate: (l: string) => l === 'BANYANDB', canonical: (l: string) => l.toUpperCase() };
const BDB = { id: serviceIdOf('showcase-banyandb', true), name: 'showcase-banyandb', normal: true, group: '' };

const oap = (answer: 'down' | 'none' | 'banyandb'): FetchLike => async () => {
  if (answer === 'down') throw new Error('ETIMEDOUT');
  const service = answer === 'none' ? null : { ...BDB, layers: ['BANYANDB'] };
  return new Response(JSON.stringify({ data: { service } }), { status: 200, headers: { 'content-type': 'application/json' } });
};

function viewer(snapshot: ServiceCatalog, fetch: FetchLike): RequestAccess {
  const catalog = { get: async () => snapshot } as unknown as ServiceLayerCatalog;
  const services = new ServiceIdentityResolver({ config, fetch, catalog });
  return new RequestAccess(new SessionAccess(['metrics:read'], undefined, facts), services);
}

/** A fresh catalog per call: what OAP answered beyond a catalog is held for
 *  that catalog's life. */
const empty = (): ServiceCatalog => ({ layers: [], byLayer: new Map(), byName: new Map() });

describe('a service lookup that could not be answered', () => {
  it('refuses rather than taking "unavailable" as "unknown"', async () => {
    expect(await viewer(empty(), oap('down')).allows(['metrics:read'], { id: BDB.id })).toBe(false);
  });

  it('still lets a plain verb name a service OAP answers it does not know', async () => {
    expect(await viewer(empty(), oap('none')).allows(['metrics:read'], { id: BDB.id })).toBe(true);
  });
});

describe('a name the catalog knows only one service by', () => {
  // A fresh catalog lists the normal `showcase-banyandb` in GENERAL; the
  // conjectured namesake OAP registered since is in BANYANDB.
  const fresh = (): ServiceCatalog => ({ layers: ['GENERAL'], byLayer: new Map([['GENERAL', [BDB]]]), byName: new Map() });
  const namesake: FetchLike = async (_url, init) => {
    const { variables } = JSON.parse(String(init?.body ?? '{}')) as { variables: { id: string } };
    const service = variables.id === serviceIdOf(BDB.name, false) ? { ...BDB, id: variables.id, normal: false, layers: ['BANYANDB'] } : null;
    return new Response(JSON.stringify({ data: { service } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  it('asks OAP for the other id, and refuses the name when the namesake is out of reach', async () => {
    expect(await viewer(fresh(), namesake).allows(['metrics:read'], { name: BDB.name })).toBe(false);
    expect(await viewer(fresh(), oap('none')).allows(['metrics:read'], { name: BDB.name })).toBe(true);
    expect(await viewer(fresh(), oap('down')).decide(['metrics:read'], { name: BDB.name })).toBe('unavailable');
  });

  it('does not ask when the name comes with its normal flag', async () => {
    expect(await viewer(fresh(), oap('down')).allows(['metrics:read'], { name: BDB.name, normal: true })).toBe(true);
  });
});

describe('a catalog kept through a failed refresh', () => {
  it('re-checks its rows with OAP before they decide access', async () => {
    // The retained row still says GENERAL; OAP now says BANYANDB only.
    const stale: ServiceCatalog = {
      layers: ['GENERAL'],
      byLayer: new Map([['GENERAL', [BDB]]]),
      byName: new Map(),
      unreachable: true,
      stale: true,
    };
    expect(await viewer(stale, oap('banyandb')).allows(['metrics:read'], { id: BDB.id })).toBe(false);
    expect(await viewer(stale, oap('down')).allows(['metrics:read'], { id: BDB.id })).toBe(false);
  });

  it('trusts rows read in the last few minutes, and re-checks older ones', async () => {
    const retained = (ageMs: number): ServiceCatalog => ({
      layers: ['GENERAL'],
      byLayer: new Map([['GENERAL', [BDB]]]),
      byName: new Map(),
      unreachable: true,
      stale: true,
      readAt: Date.now() - ageMs,
    });
    expect(await viewer(retained(60_000), oap('down')).allows(['metrics:read'], { id: BDB.id })).toBe(true);
    expect(await viewer(retained(10 * 60_000), oap('banyandb')).allows(['metrics:read'], { id: BDB.id })).toBe(false);
  });
});

describe('an empty identity', () => {
  it('reads every service for a plain verb, as before, and nothing for a layer-limited one', async () => {
    expect(await viewer(empty(), oap('down')).allows(['metrics:read'], { id: '' })).toBe(true);
    const catalog = { get: async () => empty() } as unknown as ServiceLayerCatalog;
    const services = new ServiceIdentityResolver({ config, fetch: oap('down'), catalog });
    const limited = new RequestAccess(new SessionAccess(['metrics:read@GENERAL'], undefined, facts), services);
    expect(await limited.allows(['metrics:read'], { id: '' })).toBe(false);
    expect(await limited.allows(['metrics:read'], { name: '' })).toBe(false);
  });
});

describe('an identity OAP reads exactly as written', () => {
  it('refuses what OAP would trim, fold to _blank, or encode differently', () => {
    expect(isExactIdentity('payments::checkout')).toBe(true);
    expect(isExactIdentity('支付::结账 🚀')).toBe(true);
    for (const v of ['', ' ', 'a ', '\u0000', 'a\u0007b', 'a\uD800', '\uDC00a']) expect(isExactIdentity(v), JSON.stringify(v)).toBe(false);
  });
});

describe('filtering the rows of a read that named no service', () => {
  it('reports an ownership lookup OAP could not answer instead of dropping the row', async () => {
    const rows = [{ serviceId: BDB.id }];
    await expect(viewer(empty(), oap('down')).keepReadable(['metrics:read'], rows, (r) => ({ id: r.serviceId }))).rejects.toBeInstanceOf(
      ServiceLookupUnavailable,
    );
    expect(await viewer(empty(), oap('none')).keepReadable(['metrics:read'], rows, (r) => ({ id: r.serviceId }))).toEqual(rows);
  });

  it('asks nothing for a caller who reads every layer', async () => {
    const catalog = { get: async () => empty() } as unknown as ServiceLayerCatalog;
    const services = new ServiceIdentityResolver({ config, fetch: oap('down'), catalog });
    const everyLayer = new RequestAccess(new SessionAccess(['metrics:read', 'cluster:read'], undefined, facts), services);
    const rows = [{ serviceId: BDB.id }];
    expect(await everyLayer.keepReadable(['metrics:read'], rows, (r) => ({ id: r.serviceId }))).toEqual(rows);
  });
});

describe('a graph whose metrics read by name alone', () => {
  const cfg = {
    nodeMetrics: [
      { id: 'cpm', mqe: 'service_cpm' },
      { id: 'predicted', mqe: 'baseline(service_cpm,value)' },
    ],
  };
  const real = { id: serviceIdOf('payments::a', true), name: 'payments::a', normal: true, group: 'payments' };
  const conjectured = { ...real, id: serviceIdOf('payments::a', false), normal: false };
  const catalogOf = (withNamesake: boolean): ServiceCatalog => ({
    layers: ['GENERAL', 'VIRTUAL_DATABASE'],
    byLayer: new Map([
      ['GENERAL', [real]],
      ['VIRTUAL_DATABASE', withNamesake ? [conjectured] : []],
    ]),
    byName: new Map(),
  });
  const access = (grants: string[], withNamesake: boolean) => {
    const catalog = { get: async () => catalogOf(withNamesake) } as unknown as ServiceLayerCatalog;
    const services = new ServiceIdentityResolver({ config, fetch: oap('none'), catalog });
    return new RequestAccess(new SessionAccess(grants, undefined, facts), services);
  };
  const ids = (c: typeof cfg) => c.nodeMetrics.map((m) => m.id);

  it('keeps them when every service of the focus name is readable', async () => {
    expect(ids(await access(['topology:read@GENERAL[payments]'], false).graphConfig(['topology:read'], [real.id], cfg))).toEqual(['cpm', 'predicted']);
  });

  it('leaves them out when a namesake is not, and on a layer-wide map for a limited caller', async () => {
    const limited = access(['topology:read@GENERAL[payments]'], true);
    expect(ids(await limited.graphConfig(['topology:read'], [real.id], cfg))).toEqual(['cpm']);
    expect(ids(await access(['topology:read@GENERAL[payments]'], false).graphConfig(['topology:read'], [], cfg))).toEqual(['cpm']);
  });

  it('leaves them out for a focus OAP does not know, which still has a name to answer for', async () => {
    const unknownFocus = serviceIdOf('payments::a', false);
    expect(ids(await access(['topology:read'], false).graphConfig(['topology:read'], [unknownFocus], cfg))).toEqual(['cpm']);
  });

  it('checks the name MQE sends: a blank one is `_blank`, which another service may carry', async () => {
    // A conjectured service with a blank name, and a real one literally named
    // `_blank` that reports only into an operate layer. Both answer to `_blank`.
    const blank = { id: serviceIdOf('_blank', false), name: '', normal: false, group: '' };
    const literal = { id: serviceIdOf('_blank', true), name: '_blank', normal: true, group: '' };
    const catalog = {
      get: async (): Promise<ServiceCatalog> => ({
        layers: ['GENERAL', 'BANYANDB'],
        byLayer: new Map([
          ['GENERAL', [blank]],
          ['BANYANDB', [literal]],
        ]),
        byName: new Map(),
      }),
    } as unknown as ServiceLayerCatalog;
    const services = new ServiceIdentityResolver({ config, fetch: oap('none'), catalog });
    const plain = new RequestAccess(new SessionAccess(['topology:read'], undefined, facts), services);
    expect(ids(await plain.graphConfig(['topology:read'], [blank.id], cfg))).toEqual(['cpm']);
  });

  it('keeps them for a caller who reads every layer', async () => {
    expect(ids(await access(['topology:read', 'cluster:read'], true).graphConfig(['topology:read'], [], cfg))).toEqual(['cpm', 'predicted']);
  });
});

describe('a name that also addresses the blank-named service', () => {
  it('reads every service filed under it, whichever name the roster shows', async () => {
    // A conjectured service literally named `_blank`, readable to a viewer, and
    // a real service with an empty name, which OAP files under `_blank` too and
    // which reports only into an operate layer.
    const literal = { id: serviceIdOf('_blank', false), name: '_blank', normal: false, group: '' };
    const blankNamed = { id: serviceIdOf('', true), name: '', normal: true, group: '' };
    expect(blankNamed.id).toBe(serviceIdOf('_blank', true));
    const snapshot: ServiceCatalog = {
      layers: ['VIRTUAL_DATABASE', 'BANYANDB'],
      byLayer: new Map([
        ['VIRTUAL_DATABASE', [literal]],
        ['BANYANDB', [blankNamed]],
      ]),
      byName: new Map(),
    };
    expect(await viewer(snapshot, oap('none')).allows(['metrics:read'], { name: '_blank' })).toBe(false);
    expect(await viewer(snapshot, oap('none')).allows(['metrics:read'], { id: literal.id })).toBe(true);
    // An empty name is that same service, not the absence of one: a row that
    // carries it is decided like any other.
    expect(await viewer(snapshot, oap('none')).allows(['metrics:read'], { name: '' })).toBe(false);
    const rows = [{ service: '' }, { service: ' ' }];
    expect(await viewer(snapshot, oap('none')).keepReadable(['metrics:read'], rows, (r) => ({ name: r.service }))).toEqual([]);
  });
});
