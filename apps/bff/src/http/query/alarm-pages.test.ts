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
 * `GET /api/alarms/pages` behind the real route policy and scope gate: any
 * `alarms:read` holder, plain or on one layer, is served the pages fitted to
 * what that grant reaches; anyone else is refused.
 */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { AlarmPagesResponse, UITemplateClient, UITemplateRow } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import { BUILTIN_ROLES } from '../../config/builtin-roles.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { buildEnvelope, serializeEnvelope } from '../../logic/templates/names.js';
import { resetTemplateSyncState } from '../../logic/templates/sync.js';
import type { ServiceLayerCatalog } from '../../logic/services/service-layer-catalog.js';
import { ServiceIdentityResolver } from '../../logic/services/service-identity.js';
import { logger } from '../../logger.js';
import { registerAlarmPagesRoute } from './alarm-pages.js';

const ROLES = {
  viewer: ['alarms:read'],
  maintainer: ['alarms:read', 'cluster:read'],
  payments: ['alarms:read@GENERAL[payments]'],
  storage: ['alarms:read@BANYANDB'],
  metricsOnly: ['metrics:read', 'cluster:read'],
};

const row = (key: string, content: unknown): UITemplateRow =>
  ({ id: key, disabled: false, configuration: serializeEnvelope(buildEnvelope('alert', key, content)) }) as UITemplateRow;

const STORE: UITemplateRow[] = [
  row('default', { pinnedLayers: ['GENERAL', 'MESH', 'BANYANDB'], defaultWindowMs: 7_200_000, overviewAlarmsLimit: 200 }),
  row('payments', { id: 'payments', title: 'Payments', order: 1, pinnedLayers: ['GENERAL[payments]', 'MESH'] }),
  row('storage', { id: 'storage', title: 'Storage', pinnedLayers: ['BANYANDB'], defaultWindowMs: 14_400_000 }),
];

let app: FastifyInstance | null = null;
beforeEach(() => {
  resetTemplateSyncState();
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});
afterEach(async () => {
  await app?.close();
  app = null;
  resetTemplateSyncState();
  vi.restoreAllMocks();
});

async function get(
  role: string | null,
  store: UITemplateRow[] | 'unreachable' = STORE,
  /** `null`: the built-in roles, as a deployment with no `rbac` block has. */
  roles: Record<string, string[]> | null = ROLES,
) {
  const cfg = configSchema.parse(roles ? { rbac: { roles } } : {});
  const config: ConfigSource = { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const catalog = { get: async () => ({ layers: [], byLayer: new Map(), byName: new Map() }) } as unknown as ServiceLayerCatalog;
  const templates = (): UITemplateClient =>
    ({
      list: async () => {
        if (store === 'unreachable') throw new Error('ECONNREFUSED');
        return store.map((r) => ({ ...r }));
      },
      create: () => Promise.reject(new Error('read only')),
      update: () => Promise.reject(new Error('read only')),
      disable: () => Promise.reject(new Error('read only')),
    }) as unknown as UITemplateClient;
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
  registerAlarmPagesRoute(app, { config, sessions, uiTemplateClient: templates });
  await app.ready();
  const headers = role ? { cookie: `horizon_sid=${sessions.create(role, [role]).sid}` } : {};
  return app.inject({ method: 'GET', url: '/api/alarms/pages', headers });
}

async function pagesFor(role: keyof typeof ROLES): Promise<AlarmPagesResponse> {
  const res = await get(role);
  expect(res.statusCode).toBe(200);
  return res.json() as AlarmPagesResponse;
}

describe('GET /api/alarms/pages', () => {
  it('serves a plain reader every page but the one only an operate layer fills', async () => {
    const body = await pagesFor('viewer');
    expect(body.unreachable).toBe(false);
    expect(body.default).toEqual({
      id: 'default',
      title: null,
      pinnedLayers: ['GENERAL', 'MESH'],
      hiddenPins: 1,
      defaultWindowMs: 7_200_000,
    });
    expect(body.pages).toEqual([
      { id: 'payments', title: 'Payments', pinnedLayers: ['GENERAL[payments]', 'MESH'], hiddenPins: 0, defaultWindowMs: 7_200_000 },
    ]);
  });

  it('serves cluster:read the operate-layer pins too', async () => {
    const body = await pagesFor('maintainer');
    expect(body.default?.pinnedLayers).toEqual(['GENERAL', 'MESH', 'BANYANDB']);
    expect(body.pages.map((p) => [p.id, p.defaultWindowMs])).toEqual([
      ['payments', 7_200_000],
      ['storage', 14_400_000],
    ]);
  });

  it('serves a group grant its own group, and no page it reaches nothing of', async () => {
    const body = await pagesFor('payments');
    expect(body.default).toMatchObject({ pinnedLayers: ['GENERAL[payments]'], hiddenPins: 2 });
    expect(body.pages.map((p) => [p.id, p.pinnedLayers, p.hiddenPins])).toEqual([['payments', ['GENERAL[payments]'], 1]]);
  });

  it('serves an explicit operate-layer grant that layer without cluster:read', async () => {
    const body = await pagesFor('storage');
    expect(body.default).toMatchObject({ pinnedLayers: ['BANYANDB'], hiddenPins: 2 });
    expect(body.pages.map((p) => p.id)).toEqual(['storage']);
  });

  it('says the store is unreachable and serves no page', async () => {
    const res = await get('viewer', 'unreachable');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ unreachable: true, default: null, pages: [] });
  });

  it('refuses a session without alarms:read, and one without a session', async () => {
    const denied = await get('metricsOnly');
    expect(denied.statusCode).toBe(403);
    await app?.close();
    app = null;
    expect((await get(null)).statusCode).toBe(401);
  });

  // What a deployment gets with no configuration of its own: the built-in
  // roles and the one page Horizon ships, seeded as it is.
  it('gives every built-in role the one shipped default page and nothing else', async () => {
    const shipped = JSON.parse(readFileSync(new URL('../../bundled_templates/alert/default.json', import.meta.url), 'utf8'));
    for (const role of Object.keys(BUILTIN_ROLES)) {
      const res = await get(role, [row('default', shipped)], null);
      expect(res.statusCode, `${role}: ${res.body}`).toBe(200);
      expect(res.json(), role).toEqual({
        unreachable: false,
        default: { id: 'default', title: null, pinnedLayers: ['GENERAL', 'MESH'], hiddenPins: 0, defaultWindowMs: 1_200_000 },
        pages: [],
      });
      await app?.close();
      app = null;
    }
  });
});
