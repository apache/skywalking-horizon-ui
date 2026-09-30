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
 * The sidebar follows the verbs. A session with no layer grant sees the menu
 * it always did — minus the operate layers, which were only ever hidden in
 * the browser — and a session with layer grants sees the layers and group
 * entries they reach, counted accordingly.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { FetchLike, MenuResponse, UITemplateClient, UITemplateRow } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { buildEnvelope, serializeEnvelope } from '../../logic/templates/names.js';
import { invalidateSyncCache } from '../../logic/templates/sync.js';
import type { ServiceCatalog, ServiceLayerCatalog } from '../../logic/services/service-layer-catalog.js';
import { ServiceIdentityResolver } from '../../logic/services/service-identity.js';
import { registerMenuRoute } from './menu.js';

const ROLES = {
  viewer: ['metrics:read'],
  maintainer: ['metrics:read', 'cluster:read'],
  payments: ['metrics:read@GENERAL[payments]'],
  bdb: ['metrics:read@BANYANDB'],
  alarmsOnly: ['alarms:read', 'metrics:read@GENERAL[payments]'],
  everyPage: ['metrics:read', 'traces:read', 'logs:read', 'topology:read'],
};

const snapshot: ServiceCatalog = {
  layers: ['GENERAL', 'BANYANDB'],
  byLayer: new Map([
    [
      'GENERAL',
      [
        { id: 'a.1', name: 'payments::a', normal: true, group: 'payments' },
        { id: 'b.1', name: 'payments::b', normal: true, group: 'payments' },
        { id: 'c.1', name: 'risk::c', normal: true, group: 'risk' },
      ],
    ],
    ['BANYANDB', [{ id: 'd.1', name: 'showcase-banyandb', normal: true, group: '' }]],
  ]),
  byName: new Map(),
};

const oapQuery: FetchLike = async () =>
  new Response(
    JSON.stringify({ data: { layers: ['GENERAL', 'BANYANDB'], levels: [] } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const layerRow = (key: string, extra: Record<string, unknown>): UITemplateRow =>
  ({
    id: key,
    disabled: false,
    configuration: serializeEnvelope(
      buildEnvelope('layer', key, { key, alias: key, slots: { services: 'Services' }, components: { service: true }, ...extra }),
    ),
  }) as UITemplateRow;

const store = [
  layerRow('GENERAL', {
    splitByServiceGroup: true,
    components: { service: true, instances: true, topology: true, traces: true, logs: true },
  }),
  layerRow('BANYANDB', { visibility: 'operate' }),
];

const templateClient = (): UITemplateClient =>
  ({
    list: async () => store.map((r) => ({ ...r })),
    create: () => Promise.reject(new Error('read only')),
    update: () => Promise.reject(new Error('read only')),
    disable: () => Promise.reject(new Error('read only')),
  }) as unknown as UITemplateClient;

let app: FastifyInstance | null = null;
beforeEach(() => invalidateSyncCache());
afterEach(async () => {
  await app?.close();
  app = null;
});

async function menuFor(role: keyof typeof ROLES): Promise<Array<{ key: string; serviceCount: number }>> {
  return (await menuEntries(role)).map(({ key, serviceCount }) => ({ key, serviceCount }));
}

async function menuEntries(
  role: keyof typeof ROLES,
): Promise<
  Array<{ key: string; serviceCount: number; rows: string[]; slots: MenuResponse['layers'][number]['slots']; raw: MenuResponse['layers'][number] }>
> {
  const cfg = configSchema.parse({ rbac: { roles: ROLES } });
  const config: ConfigSource = { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const catalog = { get: async () => snapshot } as unknown as ServiceLayerCatalog;
  app = Fastify();
  await app.register(cookie);
  app.addHook(
    'onRoute',
    makeRouteAuthHook({
      config,
      sessions,
      access: {
        services: new ServiceIdentityResolver({ config, catalog }),
        classify: async () => ({ isOperate: (l: string) => l.toUpperCase() === 'BANYANDB' }),
      },
    }),
  );
  registerMenuRoute(app, { config, sessions, fetch: oapQuery, uiTemplateClient: templateClient, serviceCatalog: catalog });
  await app.ready();
  const sid = sessions.create(role, [role]).sid;
  const res = await app.inject({ method: 'GET', url: '/api/menu', headers: { cookie: `horizon_sid=${sid}` } });
  // An entry named the way a grant names it: the layer, and a split layer's
  // group in brackets. Every entry of a layer carries the layer's own key.
  return (res.json() as MenuResponse).layers.map((l) => ({
    key: l.serviceGroup === undefined ? l.key.toLowerCase() : `${l.key.toLowerCase()}[${l.serviceGroup}]`,
    raw: l,
    serviceCount: l.serviceCount,
    rows: (l.menuRows ?? []).map((r) => r.path),
    slots: l.slots,
  }));
}

const keys = (m: Array<{ key: string }>) => m.map((l) => l.key).sort();

describe('the menu follows the verbs', () => {
  it('shows a plain viewer every layer but the operate ones', async () => {
    const menu = keys(await menuFor('viewer'));
    expect(menu).toEqual(expect.arrayContaining(['general[payments]', 'general[risk]', 'mysql']));
    expect(menu).not.toContain('banyandb');
  });

  it('shows the operate layers to cluster:read', async () => {
    expect(keys(await menuFor('maintainer'))).toEqual(expect.arrayContaining(['banyandb', 'general[payments]', 'mysql']));
  });

  it('shows a group grant its own group entry only', async () => {
    expect(await menuFor('payments')).toEqual([{ key: 'general[payments]', serviceCount: 2 }]);
  });

  it('keys a split layer\'s entries by the layer, the group apart', async () => {
    const raw = (await menuEntries('viewer')).map((e) => e.raw).filter((l) => l.key === 'general');
    expect(raw.map((l) => l.serviceGroup).sort()).toEqual(['payments', 'risk']);
    expect(JSON.stringify(raw)).not.toContain('~');
  });

  it('shows an explicit operate-layer grant that layer alone', async () => {
    expect(keys(await menuFor('bdb'))).toEqual(['banyandb']);
  });

  it('shows a layer with all its pages or not at all', async () => {
    const rowsOf = async (role: keyof typeof ROLES) =>
      (await menuEntries(role)).find((e) => e.key === 'general[payments]')?.rows;
    const every = ['service', 'instance', 'topology', 'trace', 'logs'];
    expect(await rowsOf('payments')).toEqual(every);
    expect(await rowsOf('everyPage')).toEqual(every);
  });

  it('does not open layer pages through a verb that has none', async () => {
    expect(keys(await menuFor('alarmsOnly'))).toEqual(['general[payments]']);
  });
});

describe('a stored layer row that spells its entity terms as `aliases`', () => {
  it('still gives every entry, split ones included, the names the layer page reads', async () => {
    const general = store[0]!;
    store[0] = layerRow('GENERAL', {
      slots: undefined,
      aliases: { services: 'Apps' },
      splitByServiceGroup: true,
      components: { service: true, instances: true, topology: true, traces: true, logs: true },
    });
    try {
      const entries = await menuEntries('viewer');
      expect(entries.find((l) => l.key === 'general[payments]')?.slots).toEqual({ services: 'Apps' });
      // Neither spelling: an empty map, never a missing one.
      store[0] = layerRow('GENERAL', { slots: undefined, splitByServiceGroup: true });
      await app?.close();
      invalidateSyncCache();
      expect((await menuEntries('viewer')).find((l) => l.key === 'general[payments]')?.slots).toEqual({});
    } finally {
      store[0] = general;
    }
  });
});
