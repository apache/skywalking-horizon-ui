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
 * The config bundle's duplicate-template contract for OVERVIEW dashboards —
 * the sidebar's overview entries come from this payload, so it is where a
 * duplicated overview has to be dropped, the same way the menu route drops a
 * duplicated layer.
 *
 * Three properties, all asserted below: an overview whose enabled OAP records
 * DIFFER is dropped (nobody can say which dashboard the name means);
 * byte-identical records are NOT dropped (either copy renders the same thing);
 * and every duplicate — dropped or not — is still reported in `syncStatus`, so
 * the admin banner can tell the operator to clean it up.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { UITemplateClient, UITemplateRow } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { buildEnvelope, serializeEnvelope } from '../../logic/templates/names.js';
import { invalidateSyncCache } from '../../logic/templates/sync.js';
import { logger } from '../../logger.js';
import { registerConfigBundleRoute, type ConfigBundle } from './bundle.js';

function fakeConfig(): ConfigSource {
  const cfg = configSchema.parse({});
  return { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
}

const row = (id: string, configuration: string, disabled = false): UITemplateRow =>
  ({ id, configuration, disabled });

const overviewCfg = (id: string, title: string): string =>
  serializeEnvelope(buildEnvelope('overview', id, { id, title, widgets: [] }));
const layerCfg = (key: string, alias: string): string =>
  serializeEnvelope(
    buildEnvelope('layer', key, { key, alias, slots: { services: 'Services' }, components: { service: true } }),
  );

function templateClient(store: UITemplateRow[]): () => UITemplateClient {
  return () =>
    ({
      list: async (): Promise<UITemplateRow[]> => store.map((r) => ({ ...r })),
      // Building the bundle is a pure read path — any write here is a bug.
      create: () => Promise.reject(new Error('the bundle route must not write to OAP')),
      update: () => Promise.reject(new Error('the bundle route must not write to OAP')),
      disable: () => Promise.reject(new Error('the bundle route must not write to OAP')),
    }) as unknown as UITemplateClient;
}

async function bundleOf(store: UITemplateRow[]): Promise<ConfigBundle> {
  const config = fakeConfig();
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const app: FastifyInstance = Fastify();
  await app.register(cookie);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
  registerConfigBundleRoute(app, { config, sessions, uiTemplateClient: templateClient(store) });
  await app.ready();
  const { sid } = sessions.create('op', ['admin']);
  const res = await app.inject({
    method: 'GET',
    url: '/api/configs/bundle',
    headers: { cookie: `horizon_sid=${sid}` },
  });
  await app.close();
  expect(res.statusCode).toBe(200);
  return res.json() as ConfigBundle;
}

const overviewIds = (b: ConfigBundle): string[] => b.overviews.map((o) => o.id).sort();

describe('config bundle — a duplicated overview dashboard is not navigable', () => {
  beforeEach(() => {
    invalidateSyncCache();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    invalidateSyncCache();
    vi.restoreAllMocks();
  });

  it('drops the overview whose two enabled OAP records carry different content', async () => {
    const bundle = await bundleOf([
      row('dupe-a', overviewCfg('services', 'Services')),
      row('dupe-b', overviewCfg('services', 'Services (second copy)')),
      row('mesh-1', overviewCfg('mesh', 'Service Mesh')),
    ]);
    expect(overviewIds(bundle)).toEqual(['mesh']);
  });

  it('keeps an overview whose two enabled records are byte-identical', async () => {
    const bundle = await bundleOf([
      row('dupe-a', overviewCfg('services', 'Services')),
      row('dupe-b', overviewCfg('services', 'Services')),
    ]);
    expect(overviewIds(bundle)).toEqual(['services']);
    // Once. A duplicate on OAP must not become two sidebar entries.
    expect(bundle.overviews).toHaveLength(1);
  });

  it('reports every duplicate it serves, so the admin banner still asks for cleanup', async () => {
    const bundle = await bundleOf([
      row('dupe-a', overviewCfg('services', 'Services')),
      row('dupe-b', overviewCfg('services', 'Services')),
    ]);
    expect(bundle.syncStatus.conflicts).toEqual([
      {
        name: 'horizon.overview.services',
        kind: 'overview',
        key: 'services',
        enabledIds: ['dupe-a', 'dupe-b'],
        identical: true,
      },
    ]);
  });

  it('keeps an overview whose only twin is a disabled tombstone', async () => {
    const bundle = await bundleOf([
      row('a-tombstone', overviewCfg('services', 'retired copy'), true),
      row('z-live', overviewCfg('services', 'Services')),
    ]);
    expect(overviewIds(bundle)).toEqual(['services']);
    expect(bundle.syncStatus.conflicts).toEqual([]);
  });

  it('drops a remote-only duplicated dashboard too — it has no on-disk base to fall back to', async () => {
    // Dashboards created in the admin and pushed have no bundled copy, so they
    // reach the bundle through the remote-only pass. Same ambiguity, same drop.
    const bundle = await bundleOf([
      row('dupe-a', overviewCfg('ops-board', 'Ops board')),
      row('dupe-b', overviewCfg('ops-board', 'Ops board (second copy)')),
      row('solo', overviewCfg('cost-board', 'Cost board')),
    ]);
    expect(overviewIds(bundle)).toEqual(['cost-board']);
  });

  it('a duplicated LAYER template drops no overview, even when they share the key', async () => {
    // The bundle ships both a `mesh` overview and a MESH layer, so a conflict
    // has to be read with its kind or the wrong entry disappears.
    const bundle = await bundleOf([
      row('layer-a', layerCfg('MESH', 'Service Mesh')),
      row('layer-b', layerCfg('MESH', 'Service Mesh (second copy)')),
      row('ov-1', overviewCfg('mesh', 'Service Mesh')),
    ]);
    expect(overviewIds(bundle)).toEqual(['mesh']);
  });
});
