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
 * How the read routes answer a `page` they were given, against a layer
 * stored on OAP with extension pages.
 *
 * The property under test throughout is that an UNKNOWN page is a 404 and
 * never the component's default grid: answering it with the default would
 * render real widgets under a URL that promised different ones, and an
 * operator reading that page has no way to tell.
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
import { registerDashboardConfigRoute } from './dashboard.js';

function fakeConfig(): ConfigSource {
  const cfg = configSchema.parse({});
  return { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
}

const widget = (id: string) => ({ id, title: id, type: 'line', expressions: ['x'] });

/** A layer with a default Service grid plus two Service extension pages
 *  and one Instance page. */
const LAYER_KEY = 'CUSTOM_MQ';
const layerContent = {
  key: LAYER_KEY,
  alias: 'Custom MQ',
  slots: { services: 'Queues' },
  components: { service: true, instances: true },
  dashboards: { service: [widget('svc-default')], instance: [widget('inst-default')] },
  dashboardExtPages: {
    service: [
      { id: 'resource', name: 'Resource usage', widgets: [widget('res-a'), widget('res-b')] },
      { id: 'agents', name: 'Agents', serviceFilter: '/^agent::/', widgets: [widget('ag-a')] },
    ],
    instance: [{ id: 'runtime', name: 'Runtime', widgets: [widget('rt-a')] }],
  },
};

const store: UITemplateRow[] = [
  { id: 'r1', configuration: serializeEnvelope(buildEnvelope('layer', LAYER_KEY, layerContent)) } as UITemplateRow,
];

function templateClient(): () => UITemplateClient {
  return () =>
    ({
      list: async (): Promise<UITemplateRow[]> => store.map((r) => ({ ...r })),
      create: () => Promise.reject(new Error('read path must not write')),
      update: () => Promise.reject(new Error('read path must not write')),
      disable: () => Promise.reject(new Error('read path must not write')),
    }) as unknown as UITemplateClient;
}

async function withApp<T>(fn: (app: FastifyInstance, sid: string) => Promise<T>): Promise<T> {
  const config = fakeConfig();
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const app: FastifyInstance = Fastify();
  await app.register(cookie);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
  const deps = { config, sessions, uiTemplateClient: templateClient() };
  registerConfigBundleRoute(app, deps);
  registerDashboardConfigRoute(app, deps);
  await app.ready();
  const { sid } = sessions.create('op', ['admin']);
  try {
    return await fn(app, sid);
  } finally {
    await app.close();
  }
}

function configFor(scope: string, page?: string) {
  return withApp(async (app, sid) => {
    const qs = new URLSearchParams({ scope, ...(page === undefined ? {} : { page }) });
    const res = await app.inject({
      method: 'GET',
      url: `/api/layer/${LAYER_KEY.toLowerCase()}/dashboard/config?${qs.toString()}`,
      headers: { cookie: `horizon_sid=${sid}` },
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  });
}

describe('GET dashboard/config — page selection', () => {
  beforeEach(() => {
    invalidateSyncCache();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    invalidateSyncCache();
    vi.restoreAllMocks();
  });

  it('serves the component default when no page is asked for', async () => {
    const r = await configFor('service');
    expect(r.status).toBe(200);
    expect((r.body.widgets as Array<{ id: string }>).map((w) => w.id)).toEqual(['svc-default']);
  });

  it('serves a named page and echoes which page it is', async () => {
    const r = await configFor('service', 'resource');
    expect(r.status).toBe(200);
    expect(r.body.page).toBe('resource');
    expect((r.body.widgets as Array<{ id: string }>).map((w) => w.id)).toEqual(['res-a', 'res-b']);
  });

  it('404s an unknown page instead of serving the default grid', async () => {
    const r = await configFor('service', 'nope');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('unknown_page');
  });

  it('404s a page id borrowed from another component', async () => {
    // `runtime` exists, but under instance — resolving it here would show
    // Instance widgets on a Service URL.
    const r = await configFor('service', 'runtime');
    expect(r.status).toBe(404);
  });

  it('serves instance pages independently of service pages', async () => {
    expect((await configFor('instance')).body.widgets).toHaveLength(1);
    const r = await configFor('instance', 'runtime');
    expect(r.status).toBe(200);
    expect((r.body.widgets as Array<{ id: string }>).map((w) => w.id)).toEqual(['rt-a']);
  });

  it('404s a page on a scope that cannot carry pages', async () => {
    expect((await configFor('topology', 'resource')).status).toBe(404);
  });
});

describe('config bundle — extension-page widgets', () => {
  beforeEach(() => {
    invalidateSyncCache();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    invalidateSyncCache();
    vi.restoreAllMocks();
  });

  async function bundle(): Promise<ConfigBundle> {
    return withApp(async (app, sid) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/configs/bundle',
        headers: { cookie: `horizon_sid=${sid}` },
      });
      expect(res.statusCode).toBe(200);
      return res.json() as ConfigBundle;
    });
  }

  it('carries each page under `<component>/<id>`', async () => {
    const b = await bundle();
    const pages = b.layerExtPages?.[LAYER_KEY.toLowerCase()] ?? {};
    expect(Object.keys(pages).sort()).toEqual(['instance/runtime', 'service/agents', 'service/resource']);
    expect(pages['service/resource'].map((w) => w.id)).toEqual(['res-a', 'res-b']);
  });

  it('leaves the default grids exactly as they were', async () => {
    const b = await bundle();
    const scopes = b.layers[LAYER_KEY.toLowerCase()];
    expect(scopes.service?.map((w) => w.id)).toEqual(['svc-default']);
    expect(scopes.instance?.map((w) => w.id)).toEqual(['inst-default']);
  });

  it('omits the block entirely for a deployment with no pages', async () => {
    // Every bundled layer is in this state, so the field must not appear
    // merely because the feature exists.
    const b = await bundle();
    for (const key of Object.keys(b.layers)) {
      if (key === LAYER_KEY.toLowerCase()) continue;
      expect(b.layerExtPages?.[key]).toBeUndefined();
    }
  });
});
