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
 * The layer-template PUSH boundary: the three routes that make a layer live for
 * everyone (`save`, `:name/push-bundled`, `sync-all`) must refuse malformed
 * content before it reaches OAP, and must still publish a half-authored one —
 * the editor seeds every new widget with a blank MQE, so refusing that would
 * leave an operator unable to publish after adding a widget.
 *
 * The bundled set is faked so a malformed bundled layer can exist at all; the
 * calibration block at the bottom runs the real shipped bundle through the same
 * bar, because a bundled layer the push refuses could never be reset to.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { UITemplateClient, type FetchLike } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { resync } from '../../logic/templates/sync.js';
import { allLayerTemplates } from '../../logic/layers/loader.js';
import { layerTemplatePushSchema } from '../../logic/templates/bundled-schema.js';
import { registerTemplateSyncAdminRoutes } from './template-sync.js';

/** The bundled set the routes see. Mutable so each test can plant exactly the
 *  templates it needs (including ones no shipped bundle would contain). */
const bundle = vi.hoisted(() => ({
  rows: [] as Array<{ kind: string; key: string; content: unknown }>,
}));

vi.mock('../../logic/templates/aggregator.js', () => ({
  iterateBundledTemplates: () => bundle.rows,
  iterateBundledOverlays: () => [],
}));

type Json = Record<string, unknown>;

/** A minimal layer template that passes the push bar. */
function validLayer(key: string): Json {
  return {
    key,
    alias: key,
    slots: {},
    components: { service: true },
    header: { orderBy: 'cpm', columns: [{ metric: 'cpm', label: 'Load', mqe: 'service_cpm' }] },
    dashboards: {
      service: [
        { id: 'w1', title: 'Load', type: 'line', expressions: ['service_cpm'], span: 6, rowSpan: 2 },
      ],
    },
  };
}

/** In-memory stand-in for OAP's ui_template store, plus the write log the
 *  refusal tests assert stays empty. */
function makeStore() {
  const rows: Array<{ id: string; configuration: string; disabled: boolean }> = [];
  const writes: Array<{ op: 'create' | 'update' | 'disable'; id: string }> = [];
  const reply = (body: unknown): Response =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET') return reply(rows);
    if (method === 'POST' && url.endsWith('/disable')) {
      const id = decodeURIComponent(url.split('/').slice(-2)[0]);
      const row = rows.find((r) => r.id === id);
      if (row) row.disabled = true;
      writes.push({ op: 'disable', id });
      return reply({ id, status: true, message: '' });
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as { id: string; configuration: string };
    if (method === 'POST') {
      rows.push({ id: body.id, configuration: body.configuration, disabled: false });
      writes.push({ op: 'create', id: body.id });
      return reply({ id: body.id, status: true, message: '' });
    }
    if (method === 'PUT') {
      const row = rows.find((r) => r.id === body.id);
      if (row) row.configuration = body.configuration;
      writes.push({ op: 'update', id: body.id });
      return reply({ id: body.id, status: true, message: '' });
    }
    return new Response('unexpected', { status: 500 });
  };
  return { rows, writes, fetchImpl };
}

function fakeConfig(): ConfigSource {
  const cfg = configSchema.parse({});
  return { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
}

async function buildApp(fetchImpl: FetchLike): Promise<{
  app: FastifyInstance;
  cookie: string;
}> {
  const config = fakeConfig();
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const client = new UITemplateClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl });
  const app = Fastify();
  await app.register(cookie);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
  registerTemplateSyncAdminRoutes(app, { config, sessions, uiTemplateClient: () => client });
  await app.ready();
  // `operator` carries both dashboard:write (layer saves) and overview:write
  // (the bundled pushes).
  const sid = sessions.create('op', ['operator']).sid;
  return { app, cookie: `horizon_sid=${sid}` };
}

async function post(app: FastifyInstance, url: string, cookieHeader: string, payload: object = {}) {
  return await app.inject({
    method: 'POST',
    url,
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    payload,
  });
}

beforeEach(() => {
  bundle.rows = [];
  resync();
});

describe('POST /api/admin/templates/save — layer content reaching OAP', () => {
  it('refuses malformed content and writes nothing', async () => {
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);
    const broken = validLayer('GENERAL');
    // A cleared widget-size input: the dashboard route rejects the whole body on
    // it, so this one widget blanks the batch it rides in for every user.
    ((broken.dashboards as Json).service as Json[])[0].span = '';

    const res = await post(app, '/api/admin/templates/save', c, {
      name: 'horizon.layer.GENERAL',
      content: broken,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string; issues: string[] };
    expect(body.code).toBe('invalid_content');
    expect(body.issues.some((i) => i.startsWith('dashboards.service.0.span:'))).toBe(true);
    expect(store.writes).toEqual([]);
    expect(store.rows).toEqual([]);
    await app.close();
  });

  it('refuses an unknown component flag — a misspelling that would silently drop a tab', async () => {
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);
    const broken = validLayer('GENERAL');
    (broken.components as Json).topolgy = true;

    const res = await post(app, '/api/admin/templates/save', c, {
      name: 'horizon.layer.GENERAL',
      content: broken,
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { issues: string[] }).issues.join(' ')).toMatch(/topolgy/);
    expect(store.writes).toEqual([]);
    await app.close();
  });

  it('publishes a template whose newly added widgets still have a blank MQE', async () => {
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);
    const content = validLayer('GENERAL');
    // Exactly what "Add widget" and "Add widget · tab" + "Add to tab" seed.
    ((content.dashboards as Json).service as Json[]).push(
      { id: 'w2', title: 'Widget 2', type: 'card', expressions: [''], span: 4, rowSpan: 1 },
      {
        id: 'w3',
        title: 'Widget 3',
        type: 'tab',
        expressions: [],
        span: 6,
        rowSpan: 4,
        tabs: [{ name: 'Tab 1', widgets: [{ id: 'w3_t0_w1', title: 'Widget 1', type: 'line', expressions: [''], span: 6, rowSpan: 2 }] }],
      },
    );

    const res = await post(app, '/api/admin/templates/save', c, {
      name: 'horizon.layer.GENERAL',
      content,
    });

    expect(res.statusCode).toBe(200);
    expect(store.writes).toEqual([{ op: 'create', id: 'horizon.layer.GENERAL' }]);
    const stored = JSON.parse(store.rows[0].configuration) as { content: Json };
    // Stored verbatim — the blank MQE is the operator's own JSON, not rewritten.
    expect(((stored.content.dashboards as Json).service as Json[])[1].expressions).toEqual(['']);
    await app.close();
  });

  it('leaves other template kinds alone', async () => {
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);
    const res = await post(app, '/api/admin/templates/save', c, {
      name: 'horizon.theme.active',
      content: { themeId: 'midnight' },
    });
    expect(res.statusCode).toBe(200);
    expect(store.writes).toEqual([{ op: 'create', id: 'horizon.theme.active' }]);
    await app.close();
  });
});

describe('POST /api/admin/templates/:name/push-bundled', () => {
  it('refuses a malformed bundled layer and writes nothing', async () => {
    const broken = validLayer('GENERAL');
    broken.components = 'yes';
    bundle.rows = [{ kind: 'layer', key: 'GENERAL', content: broken }];
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);

    const res = await post(app, '/api/admin/templates/horizon.layer.GENERAL/push-bundled', c);

    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string; issues: string[] };
    expect(body.code).toBe('invalid_content');
    expect(body.issues.some((i) => i.startsWith('components:'))).toBe(true);
    expect(store.writes).toEqual([]);
    await app.close();
  });

  it('still pushes a well-formed bundled layer', async () => {
    bundle.rows = [{ kind: 'layer', key: 'GENERAL', content: validLayer('GENERAL') }];
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);

    const res = await post(app, '/api/admin/templates/horizon.layer.GENERAL/push-bundled', c);

    expect(res.statusCode).toBe(200);
    expect(store.writes).toEqual([{ op: 'create', id: 'horizon.layer.GENERAL' }]);
    await app.close();
  });
});

describe('POST /api/admin/templates/sync-all', () => {
  it('skips the malformed layer, reports it, and syncs the rest', async () => {
    const broken = validLayer('MESH');
    ((broken.dashboards as Json).service as Json[])[0].type = 'pie';
    bundle.rows = [
      { kind: 'layer', key: 'GENERAL', content: validLayer('GENERAL') },
      { kind: 'layer', key: 'MESH', content: broken },
    ];
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);

    const res = await post(app, '/api/admin/templates/sync-all', c, { kind: 'layer' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { synced: string[]; failed: Array<{ name: string; error: string }> };
    expect(body.synced).toEqual(['horizon.layer.GENERAL']);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].name).toBe('horizon.layer.MESH');
    expect(body.failed[0].error).toMatch(/invalid content — dashboards\.service\.0\.type:/);
    expect(store.writes).toEqual([{ op: 'create', id: 'horizon.layer.GENERAL' }]);
    await app.close();
  });
});

describe('push-bar calibration', () => {
  it('accepts every layer template this build bundles', () => {
    const rejected = allLayerTemplates()
      .map((tpl) => ({ key: tpl.key, parsed: layerTemplatePushSchema.safeParse(JSON.parse(JSON.stringify(tpl))) }))
      .filter((r) => !r.parsed.success)
      .map((r) => r.key);
    expect(rejected).toEqual([]);
    expect(allLayerTemplates().length).toBeGreaterThan(0);
  });

  it('accepts the holes the editor leaves open, and refuses the ones that break a page', () => {
    const blank = validLayer('GENERAL');
    ((blank.dashboards as Json).service as Json[])[0].expressions = [''];
    expect(layerTemplatePushSchema.safeParse(blank).success).toBe(true);

    const cleared = validLayer('GENERAL');
    ((cleared.dashboards as Json).service as Json[])[0].rowSpan = '';
    expect(layerTemplatePushSchema.safeParse(cleared).success).toBe(false);
  });
});
