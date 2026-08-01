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
 * Two contracts of the config bundle, both about a row the payload must NOT
 * carry.
 *
 * Duplicates (OVERVIEW dashboards): the sidebar's overview entries come from
 * this payload, so it is where a duplicated overview has to be dropped, the
 * same way the menu route drops a duplicated layer. Three properties: an
 * overview whose enabled OAP records DIFFER is dropped (nobody can say which
 * dashboard the name means); byte-identical records are NOT dropped (either
 * copy renders the same thing); and every duplicate — dropped or not — is
 * still reported in `syncStatus`, so the admin banner can tell the operator to
 * clean it up.
 *
 * Identity: this route enumerates the remote rows and files each one under the
 * key its CONTENT declares, so a row that is not readable as what it is stored
 * as does not merely orphan itself here — it lands on whatever template its
 * content names.
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
const layerContent = (key: string, alias: string, widgetId: string): unknown => ({
  key,
  alias,
  slots: { services: 'Services' },
  components: { service: true },
  dashboards: { service: [{ id: widgetId, title: widgetId, type: 'line', expressions: ['x'] }] },
});
const layerCfg = (key: string, alias: string): string =>
  serializeEnvelope(
    buildEnvelope('layer', key, { key, alias, slots: { services: 'Services' }, components: { service: true } }),
  );
/** An envelope whose NAME and CONTENT were written independently — what the
 *  publish boundary now refuses, and what a store written before it can hold.
 *  Built by hand because `buildEnvelope` derives the name from the key, which
 *  is precisely the agreement under test. */
const rawCfg = (name: string, kind: string, content: unknown): string =>
  JSON.stringify({ name, kind, version: 1, content });

const layerKeys = (b: ConfigBundle): string[] => Object.keys(b.layers).sort();
const widgetIds = (b: ConfigBundle, key: string): string[] =>
  (b.layers[key]?.service ?? []).map((w) => w.id);

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

  it('a mis-filed overview record adds no dashboard under either id', async () => {
    // The row is named `ops`, its content answers as `services`. The list
    // carries each dashboard's own id, so serving it would put a second
    // `services` entry in the sidebar that opening `ops` renders.
    const bundle = await bundleOf([
      row('misfiled', rawCfg('horizon.overview.ops', 'overview', { id: 'services', title: 'Ops', widgets: [] })),
    ]);
    expect(overviewIds(bundle)).toEqual([]);
    expect(bundle.syncStatus.unreadable.map((u) => u.id)).toEqual(['misfiled']);
  });

  it('a mis-filed record naming a dashboard nobody ships publishes no id at all', async () => {
    // The same defect where the id it declares is NOT one of the shipped
    // dashboards: the disk pass never looks at this row, so the remote-only
    // pass is the only gate, and `my-custom-board` is an id no operator
    // published under any name — it would reach the sidebar from a record
    // stored as `ops`.
    const bundle = await bundleOf([
      row(
        'misfiled',
        rawCfg('horizon.overview.ops', 'overview', { id: 'my-custom-board', title: 'Ops', widgets: [] }),
      ),
    ]);
    expect(overviewIds(bundle)).toEqual([]);
    expect(bundle.syncStatus.unreadable.map((u) => u.reason)).toEqual([
      '"my-custom-board" is not the overview this is published as (horizon.overview.ops)',
    ]);
  });

  it('still serves a remote-only dashboard whose content agrees with its name', async () => {
    // The gate above is identity, not remote-only-ness: a dashboard created in
    // the admin and pushed has no disk base and must keep reaching the sidebar.
    const bundle = await bundleOf([row('pushed', overviewCfg('ops-board', 'Ops board'))]);
    expect(overviewIds(bundle)).toEqual(['ops-board']);
    expect(bundle.syncStatus.unreadable).toEqual([]);
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

describe('config bundle — a record that is not the template it is stored as serves nobody', () => {
  beforeEach(() => {
    invalidateSyncCache();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    invalidateSyncCache();
    vi.restoreAllMocks();
  });

  it('a layer stored under a name Horizon never computes contributes no layer', async () => {
    // `horizon.layer.general` is a name no reader builds — every one of them
    // upper-cases the key. The content is perfectly good GENERAL config, which
    // is what made this look harmless: the row was reported unreadable and
    // still put `layers.general` in the payload.
    const bundle = await bundleOf([
      row('lower', rawCfg('horizon.layer.general', 'layer', layerContent('GENERAL', 'General', 'w-general'))),
    ]);
    expect(layerKeys(bundle)).toEqual([]);
    expect(bundle.syncStatus.unreadable.map((u) => u.id)).toEqual(['lower']);
  });

  it('a layer record holding ANOTHER layer’s template cannot take that layer’s slot', async () => {
    // The serious half. Rows are enumerated in name order and filed under the
    // key their content declares, so `horizon.layer.MESH` holding a K8S
    // template lands on `layers.k8s` — after, and over, the real K8S row.
    const bundle = await bundleOf([
      row('k8s-real', serializeEnvelope(buildEnvelope('layer', 'K8S', layerContent('K8S', 'Kubernetes', 'w-k8s')))),
      row('impostor', rawCfg('horizon.layer.MESH', 'layer', layerContent('K8S', 'Impostor', 'w-impostor'))),
    ]);
    expect(layerKeys(bundle)).toEqual(['k8s']);
    expect(widgetIds(bundle, 'k8s')).toEqual(['w-k8s']);
    expect(bundle.syncStatus.unreadable.map((u) => u.reason)).toEqual([
      '"K8S" is not the layer this is published as (horizon.layer.MESH)',
    ]);
  });

  it('leaves every readable row alone', async () => {
    const bundle = await bundleOf([
      row('k8s-real', serializeEnvelope(buildEnvelope('layer', 'K8S', layerContent('K8S', 'Kubernetes', 'w-k8s')))),
      row('lower', rawCfg('horizon.layer.general', 'layer', layerContent('GENERAL', 'General', 'w-general'))),
    ]);
    expect(layerKeys(bundle)).toEqual(['k8s']);
    expect(widgetIds(bundle, 'k8s')).toEqual(['w-k8s']);
  });
});
