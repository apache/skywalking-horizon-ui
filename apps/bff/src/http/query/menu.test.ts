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
 * The sidebar's duplicate-template contract. A layer whose template name
 * sits on more than one ENABLED OAP record, with the copies carrying
 * different content, has no single definition, so the menu drops it instead
 * of routing an operator into a dashboard nobody can identify — and says so
 * in the log, because a menu entry that vanished without explanation is
 * worse than the duplicate itself.
 *
 * The other half of the contract is that hiding only ever follows a
 * POSITIVE ambiguity signal: a template status we could not read, a
 * duplicate that isn't this layer's own definition, and byte-identical
 * copies (same dashboard either way) all show everything.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type {
  FetchLike,
  MenuResponse,
  UITemplateClient,
  UITemplateRow,
} from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { buildEnvelope, buildOverlayEnvelope, serializeEnvelope } from '../../logic/templates/names.js';
import { invalidateSyncCache } from '../../logic/templates/sync.js';
import type { ServiceLayerCatalog } from '../../logic/services/service-layer-catalog.js';
import { logger } from '../../logger.js';
import { registerMenuRoute } from './menu.js';

function fakeConfig(): ConfigSource {
  const cfg = configSchema.parse({});
  return { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
}

/** OAP's query port: two active layers, nothing else. */
const oapQuery: FetchLike = async () =>
  new Response(
    JSON.stringify({
      data: {
        layers: ['GENERAL', 'MESH'],
        levels: [
          { layer: 'GENERAL', level: 0 },
          { layer: 'MESH', level: 0 },
        ],
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

/** Service counts are irrelevant here — keep the catalog off the wire. */
const emptyCatalog = {
  get: async () => ({ layers: [], byLayer: new Map(), byName: new Map() }),
} as unknown as ServiceLayerCatalog;

/** What OAP's `/ui-management/templates` surface holds, or a store the BFF
 *  cannot read at all (`unreachable`) / was never wired to (`no-client`). */
type Store = UITemplateRow[] | 'unreachable' | 'no-client';

const row = (id: string, configuration: string, disabled = false): UITemplateRow =>
  ({ id, configuration, disabled });

/** A layer envelope with just enough content for the menu to render it
 *  from the remote row (`components` is dereferenced by `componentsToCaps`). */
const layerCfg = (key: string, alias: string): string =>
  serializeEnvelope(
    buildEnvelope('layer', key, {
      key,
      alias,
      slots: { services: 'Services' },
      components: { service: true },
    }),
  );
const overviewCfg = (id: string, title: string): string =>
  serializeEnvelope(buildEnvelope('overview', id, { id, title, widgets: [] }));
const zhOverlayCfg = (key: string, alias: string): string =>
  serializeEnvelope(buildOverlayEnvelope('layer', key, 'zh-CN', { alias }));

function templateClient(store: Store): () => UITemplateClient {
  return () =>
    ({
      list: async (): Promise<UITemplateRow[]> => {
        if (store === 'unreachable' || store === 'no-client') throw new Error('ECONNREFUSED');
        return store.map((r) => ({ ...r }));
      },
      // The menu is a pure read path — any write here is a bug.
      create: () => Promise.reject(new Error('the menu route must not write to OAP')),
      update: () => Promise.reject(new Error('the menu route must not write to OAP')),
      disable: () => Promise.reject(new Error('the menu route must not write to OAP')),
    }) as unknown as UITemplateClient;
}

async function build(store: Store): Promise<{ app: FastifyInstance; sid: string }> {
  const config = fakeConfig();
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const app = Fastify();
  await app.register(cookie);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
  registerMenuRoute(app, {
    config,
    sessions,
    fetch: oapQuery,
    uiTemplateClient: store === 'no-client' ? undefined : templateClient(store),
    serviceCatalog: emptyCatalog,
  });
  await app.ready();
  return { app, sid: sessions.create('op', ['admin']).sid };
}

const get = (app: FastifyInstance, sid: string) =>
  app.inject({ method: 'GET', url: '/api/menu', headers: { cookie: `horizon_sid=${sid}` } });

/** Sidebar keys the menu served (lower-cased layer keys). */
async function menuKeys(store: Store): Promise<string[]> {
  const { app, sid } = await build(store);
  const res = await get(app, sid);
  await app.close();
  expect(res.statusCode).toBe(200);
  const body = res.json() as MenuResponse;
  // Proves we assert against the normal path, not the OAP-down skeleton.
  expect(body.oap.reachable).toBe(true);
  return body.layers.map((l) => l.key);
}

/** Menu-specific warn lines (sync.ts logs its own conflict line too). */
const hiddenWarns = (): unknown[][] =>
  vi
    .mocked(logger.warn)
    .mock.calls.filter((c) => c.some((a) => typeof a === 'string' && a.includes('Sidebar menu hides')));

describe('menu — a duplicated layer template is not navigable', () => {
  beforeEach(() => {
    invalidateSyncCache();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    invalidateSyncCache();
    vi.restoreAllMocks();
  });

  it('drops the layer whose template name is on two enabled OAP records', async () => {
    const keys = await menuKeys([
      row('dupe-a', layerCfg('GENERAL', 'General Service')),
      row('dupe-b', layerCfg('GENERAL', 'General Service (second copy)')),
      row('mesh-1', layerCfg('MESH', 'Service Mesh')),
    ]);
    expect(keys).not.toContain('general');
    // Only the ambiguous one goes — its neighbours are untouched.
    expect(keys).toContain('mesh');
  });

  it('keeps a layer whose two enabled records are byte-identical', async () => {
    // Same bytes on both records: whichever one renders, the operator sees the
    // same dashboard. Hiding it would cost them a working layer to punish a
    // bookkeeping problem on OAP — the admin banner still reports the duplicate.
    const keys = await menuKeys([
      row('dupe-a', layerCfg('GENERAL', 'General Service')),
      row('dupe-b', layerCfg('GENERAL', 'General Service')),
      row('mesh-1', layerCfg('MESH', 'Service Mesh')),
    ]);
    expect(keys).toContain('general');
    expect(keys).toContain('mesh');
    expect(hiddenWarns()).toHaveLength(0);
  });

  it('keeps a layer whose only twin is a disabled tombstone', async () => {
    // One enabled record is one definition, whatever else sits beside it.
    const keys = await menuKeys([
      row('a-tombstone', layerCfg('GENERAL', 'retired copy'), true),
      row('z-live', layerCfg('GENERAL', 'General Service')),
    ]);
    expect(keys).toContain('general');
    expect(hiddenWarns()).toHaveLength(0);
  });

  it('shows every layer when the template status cannot be read', async () => {
    // No status ⇒ no conflict signal. Hiding on absence would blank the
    // sidebar the moment OAP's admin port hiccups.
    const keys = await menuKeys('unreachable');
    expect(keys).toContain('general');
    expect(keys).toContain('mesh');
    expect(hiddenWarns()).toHaveLength(0);
  });

  it('shows every layer when no template client is wired', async () => {
    const keys = await menuKeys('no-client');
    expect(keys).toContain('general');
    expect(keys).toContain('mesh');
  });

  it('a duplicated overview record hides no layer, even when it shares the key', async () => {
    // The shipped bundle has both a `mesh` overview and a MESH layer, so a
    // conflict keyed `mesh` must be read with its kind or the wrong sidebar
    // entry disappears.
    const keys = await menuKeys([
      row('ov-a', overviewCfg('mesh', 'Service Mesh')),
      row('ov-b', overviewCfg('mesh', 'Service Mesh (second copy)')),
      row('general-1', layerCfg('GENERAL', 'General Service')),
    ]);
    expect(keys).toContain('mesh');
    expect(keys).toContain('general');
    expect(hiddenWarns()).toHaveLength(0);
  });

  it('a duplicated layer translation overlay hides no layer', async () => {
    // Overlay conflicts are reported with kind `layer` and the parent key,
    // but the layer's own definition is still a single record.
    const keys = await menuKeys([
      row('zh-a', zhOverlayCfg('GENERAL', '通用服务')),
      row('zh-b', zhOverlayCfg('GENERAL', '通用')),
      row('general-1', layerCfg('GENERAL', 'General Service')),
    ]);
    expect(keys).toContain('general');
    expect(hiddenWarns()).toHaveLength(0);
  });

  it('names the hidden layer in one warn, not one per sidebar poll', async () => {
    const { app, sid } = await build([
      row('dupe-a', layerCfg('GENERAL', 'General Service')),
      row('dupe-b', layerCfg('GENERAL', 'General Service (second copy)')),
    ]);
    await get(app, sid);
    await get(app, sid); // the sidebar re-polls every 60s per open tab
    await app.close();

    const warns = hiddenWarns();
    expect(warns).toHaveLength(1);
    expect(JSON.stringify(warns[0]?.[0])).toContain('GENERAL');
    // The operator needs to be told where to go and that Horizon changed nothing.
    expect(String(warns[0]?.[1])).toContain('Dashboard setup → Layer dashboards');
  });
});
