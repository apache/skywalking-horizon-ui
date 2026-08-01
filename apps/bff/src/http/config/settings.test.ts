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
 * The org-settings contract, both halves of it.
 *
 * Source: in `live` mode the OAP row is the ONLY source — an absent, disabled
 * or unreadable row serves NO value, so the caller renders its in-code default
 * instead of the disk bundle presented as the operator's configuration. In
 * `readonly` mode the bundle IS the declared source and must be served.
 *
 * Reach: these three settings gate the shell for every signed-in user, so the
 * route is `auth`, and its payload carries only the resolved values — not the
 * admin sync-status rows with every template's remote AND bundled copy.
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
import { invalidateSyncCache, setTemplateReadOnly } from '../../logic/templates/sync.js';
import { registerTemplateSyncAdminRoutes } from '../admin/template-sync.js';
import { logger } from '../../logger.js';
import { registerSettingsRoute, type EffectiveSettings } from './settings.js';

/** A role that can read dashboards + alarms but was never granted
 *  `overview:read` — the shape of a custom RBAC role an operator writes. */
const NO_OVERVIEW_ROLE = { 'floor-ops': ['metrics:read', 'alarms:read'] };

function fakeConfig(): ConfigSource {
  const cfg = configSchema.parse({ rbac: { roles: NO_OVERVIEW_ROLE } });
  return { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
}

/** What OAP's `/ui-management/templates` surface holds, or a store the BFF
 *  cannot read at all. */
type Store = UITemplateRow[] | 'unreachable';

const row = (id: string, configuration: string, disabled = false): UITemplateRow =>
  ({ id, configuration, disabled });

const themeCfg = (themeId: string): string =>
  serializeEnvelope(buildEnvelope('theme', 'active', { themeId }));
const timeCfg = (defaultWindowMinutes: number): string =>
  serializeEnvelope(buildEnvelope('time-defaults', 'global', { defaultWindowMinutes }));
const alertCfg = (pinnedLayers: string[]): string =>
  serializeEnvelope(
    buildEnvelope('alert', 'page-setup', {
      pinnedLayers,
      defaultWindowMs: 7_200_000,
      overviewAlarmsLimit: 300,
    }),
  );

function templateClient(store: Store): () => UITemplateClient {
  return () =>
    ({
      list: async (): Promise<UITemplateRow[]> => {
        if (store === 'unreachable') throw new Error('ECONNREFUSED');
        return store.map((r) => ({ ...r }));
      },
      // Reading the org settings must never seed / rewrite anything.
      create: () => Promise.reject(new Error('the settings route must not write to OAP')),
      update: () => Promise.reject(new Error('the settings route must not write to OAP')),
      disable: () => Promise.reject(new Error('the settings route must not write to OAP')),
    }) as unknown as UITemplateClient;
}

async function build(store: Store): Promise<{ app: FastifyInstance; sid: string }> {
  const config = fakeConfig();
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const app = Fastify();
  await app.register(cookie);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
  const deps = { config, sessions, uiTemplateClient: templateClient(store) };
  registerSettingsRoute(app, deps);
  // Registered alongside so the two reads can be compared under one session.
  registerTemplateSyncAdminRoutes(app, deps);
  await app.ready();
  return { app, sid: sessions.create('floor-op', ['floor-ops']).sid };
}

const get = (app: FastifyInstance, sid: string, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: `horizon_sid=${sid}` } });

async function settings(store: Store): Promise<EffectiveSettings> {
  const { app, sid } = await build(store);
  const res = await get(app, sid, '/api/configs/settings');
  await app.close();
  expect(res.statusCode).toBe(200);
  return res.json() as EffectiveSettings;
}

describe('org settings — live mode serves the OAP row, never the disk bundle', () => {
  beforeEach(() => {
    invalidateSyncCache();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    setTemplateReadOnly(false);
    invalidateSyncCache();
    vi.restoreAllMocks();
  });

  it('serves the remote content of each singleton', async () => {
    const body = await settings([
      row('t1', themeCfg('obsidian')),
      row('d1', timeCfg(15)),
      row('a1', alertCfg(['K8S_SERVICE'])),
    ]);
    expect(body.theme).toEqual({ themeId: 'obsidian' });
    expect(body.timeDefaults).toEqual({ defaultWindowMinutes: 15 });
    expect(body.alert).toMatchObject({ pinnedLayers: ['K8S_SERVICE'], overviewAlarmsLimit: 300 });
  });

  it('serves no value when OAP holds no row for the singleton', async () => {
    // The disk bundle ships all three; live mode must not substitute it.
    expect(await settings([])).toEqual({ theme: null, timeDefaults: null, alert: null });
  });

  it('serves no value when the template store is unreachable', async () => {
    expect(await settings('unreachable')).toEqual({ theme: null, timeDefaults: null, alert: null });
  });

  it('serves no value for an admin-disabled row', async () => {
    const body = await settings([
      row('t1', themeCfg('aurora'), true),
      row('d1', timeCfg(15)),
    ]);
    expect(body.theme).toBeNull();
    expect(body.timeDefaults).toEqual({ defaultWindowMinutes: 15 });
  });

  it('serves no value for a row OAP holds but Horizon cannot parse', async () => {
    const body = await settings([row('t1', '{not json')]);
    expect(body.theme).toBeNull();
  });
});

describe('org settings — readonly mode serves the bundle, its declared source', () => {
  beforeEach(() => {
    invalidateSyncCache();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    setTemplateReadOnly(false);
    invalidateSyncCache();
    vi.restoreAllMocks();
  });

  it('resolves all three from disk without consulting the store', async () => {
    setTemplateReadOnly(true);
    // The client throws on every call: reaching it at all would fail the test.
    const body = await settings('unreachable');
    expect(body.theme).toEqual({ themeId: 'horizon' });
    expect(body.timeDefaults).toEqual({ defaultWindowMinutes: 60 });
    expect(body.alert).toMatchObject({ pinnedLayers: ['GENERAL', 'MESH'] });
  });
});

describe('org settings — reachable to every signed-in user, and only these values', () => {
  beforeEach(() => {
    invalidateSyncCache();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    setTemplateReadOnly(false);
    invalidateSyncCache();
    vi.restoreAllMocks();
  });

  it('a role without overview:read reads the settings but not the template rows', async () => {
    const { app, sid } = await build([row('t1', themeCfg('meridian'))]);
    const ok = await get(app, sid, '/api/configs/settings');
    const denied = await get(app, sid, '/api/admin/templates/sync-status');
    await app.close();
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as EffectiveSettings).theme).toEqual({ themeId: 'meridian' });
    expect(denied.statusCode).toBe(403);
  });

  it('carries the three values and nothing else', async () => {
    const { app, sid } = await build([row('t1', themeCfg('meridian'))]);
    const res = await get(app, sid, '/api/configs/settings');
    await app.close();
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['alert', 'theme', 'timeDefaults']);
    // No bundled copy, no row ids, no per-template status — that stays admin-side.
    expect(JSON.stringify(body)).not.toContain('bundled');
  });

  it('requires a session', async () => {
    const { app } = await build([]);
    const res = await app.inject({ method: 'GET', url: '/api/configs/settings' });
    await app.close();
    expect(res.statusCode).toBe(401);
  });
});
