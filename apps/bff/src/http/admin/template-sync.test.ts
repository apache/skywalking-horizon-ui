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
import { loadOverviewDashboards } from '../../logic/overview/loader.js';
import {
  layerCrossRefIssues,
  layerTemplatePushSchema,
  overviewTemplatePushSchema,
} from '../../logic/templates/bundled-schema.js';
import { canonicalLayerKey } from '../../logic/templates/identity.js';
import { resolveEffectiveLayer } from '../../logic/layers/effective.js';
import {
  resolveEffectiveOverview,
  resolveEffectiveOverviews,
} from '../../logic/overview/effective.js';
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

/** A minimal overview dashboard that passes the push bar. */
function validOverview(id: string): Json {
  return {
    id,
    title: id,
    widgets: [
      { id: 'w1', title: 'Load', type: 'metric', layer: 'GENERAL', mqe: 'service_cpm', span: 6, rowSpan: 2 },
    ],
  };
}

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
  /** The same client the routes write through — the read-side resolvers take
   *  it, so a test can ask what the runtime makes of what was just published. */
  client: () => UITemplateClient;
}> {
  const config = fakeConfig();
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const client = new UITemplateClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl });
  const app = Fastify();
  await app.register(cookie);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
  registerTemplateSyncAdminRoutes(app, { config, sessions, uiTemplateClient: () => client });
  await app.ready();
  // `operator` carries every Dashboard-setup write verb.
  const sid = sessions.create('op', ['operator']).sid;
  return { app, cookie: `horizon_sid=${sid}`, client: () => client };
}

/** A session holding exactly `verbs`, for asserting a boundary rather than a
 *  happy path — the suite's `operator` holds every write verb, so it cannot
 *  see one. Roles are policy data, so a throwaway role is enough. */
async function buildAppAs(
  fetchImpl: FetchLike,
  verbs: string[],
): Promise<{ app: FastifyInstance; cookie: string }> {
  const cfg = configSchema.parse({ rbac: { roles: { scoped: verbs } } });
  const config: ConfigSource = {
    current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {},
  };
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const client = new UITemplateClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl });
  const app = Fastify();
  await app.register(cookie);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
  registerTemplateSyncAdminRoutes(app, { config, sessions, uiTemplateClient: () => client });
  await app.ready();
  return { app, cookie: `horizon_sid=${sessions.create('u', ['scoped']).sid}` };
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

  it('refuses content whose own key names a different layer, and writes nothing', async () => {
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);

    const res = await post(app, '/api/admin/templates/save', c, {
      name: 'horizon.layer.GENERAL',
      content: validLayer('MESH'),
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string; issues: string[] };
    expect(body.code).toBe('invalid_content');
    expect(body.issues.join(' ')).toMatch(/key: "MESH" is not the layer this is published as/);
    expect(store.writes).toEqual([]);
    await app.close();
  });

  // Two spellings of the same layer that no reader ever looks up: the row would
  // be created, the push would report success, and nothing on screen would
  // change — so the refusal has to name the one spelling that IS read.
  it.each([
    ['lower-case', 'horizon.layer.general', 'GENERAL', 'horizon.layer.GENERAL'],
    ['an OAP legacy alias', 'horizon.layer.CACHE', 'CACHE', 'horizon.layer.VIRTUAL_CACHE'],
  ])('refuses %s name, names the one Horizon reads, and writes nothing', async (_label, name, key, canonical) => {
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);

    const res = await post(app, '/api/admin/templates/save', c, {
      name,
      content: validLayer(key),
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string; issues: string[] };
    expect(body.code).toBe('invalid_content');
    expect(body.issues).toEqual([
      `name: "${name}" is not a name Horizon reads — publish it as "${canonical}"`,
    ]);
    expect(store.writes).toEqual([]);
    expect(store.rows).toEqual([]);
    await app.close();
  });

  it('refuses layer content whose key is an alias of the layer it is published as', async () => {
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);

    // The row name is the one the runtime reads, but the content answers as
    // `CACHE` — and the config bundle files a layer under the key its CONTENT
    // reports, so this lands under a key no page asks for.
    const res = await post(app, '/api/admin/templates/save', c, {
      name: 'horizon.layer.VIRTUAL_CACHE',
      content: validLayer('CACHE'),
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { issues: string[] }).issues).toEqual([
      'key: "CACHE" is not the layer this is published as (horizon.layer.VIRTUAL_CACHE)',
    ]);
    expect(store.writes).toEqual([]);
    await app.close();
  });

  it('refuses a singleton stored under anything but its one key', async () => {
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);

    const res = await post(app, '/api/admin/templates/save', c, {
      name: 'horizon.theme.ACTIVE',
      content: { themeId: 'midnight' },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { issues: string[] }).issues.join(' ')).toMatch(
      /publish it as "horizon\.theme\.active"/,
    );
    expect(store.writes).toEqual([]);
    await app.close();
  });

  it('refuses a duplicate widget id — the second widget would be unaddressable', async () => {
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);
    const broken = validLayer('GENERAL');
    ((broken.dashboards as Json).service as Json[]).push({
      id: 'w1',
      title: 'Load again',
      type: 'line',
      expressions: ['service_sla'],
      span: 6,
      rowSpan: 2,
    });

    const res = await post(app, '/api/admin/templates/save', c, {
      name: 'horizon.layer.GENERAL',
      content: broken,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as { issues: string[] };
    expect(body.issues).toContain('dashboards.service.1.id: duplicate widget id "w1"');
    expect(store.writes).toEqual([]);
    await app.close();
  });

  it('refuses a duplicate service-list column metric', async () => {
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);
    const broken = validLayer('GENERAL');
    (broken.header as Json).columns = [
      { metric: 'cpm', label: 'Load', mqe: 'service_cpm' },
      { metric: 'cpm', label: 'Load (copy)', mqe: 'service_sla' },
    ];

    const res = await post(app, '/api/admin/templates/save', c, {
      name: 'horizon.layer.GENERAL',
      content: broken,
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { issues: string[] }).issues).toContain(
      'header.columns.1.metric: duplicate column metric "cpm"',
    );
    expect(store.writes).toEqual([]);
    await app.close();
  });

  it('refuses an orderBy that names no column — the service list would sort alphabetically', async () => {
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);
    const broken = validLayer('GENERAL');
    (broken.header as Json).orderBy = 'throttled';

    const res = await post(app, '/api/admin/templates/save', c, {
      name: 'horizon.layer.GENERAL',
      content: broken,
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { issues: string[] }).issues.join(' ')).toMatch(
      /header\.orderBy: "throttled" is not one of the header columns/,
    );
    expect(store.writes).toEqual([]);
    await app.close();
  });

  it('checks the header copy the editor writes, not just the one it loaded', async () => {
    // The editor edits `metrics` in place and leaves the loader's `header`
    // mirror as it found it, so a defect lands on `metrics` alone.
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);
    const broken = validLayer('GENERAL');
    broken.metrics = { orderBy: 'throttled', columns: [{ metric: 'cpm', label: 'Load', mqe: 'service_cpm' }] };

    const res = await post(app, '/api/admin/templates/save', c, {
      name: 'horizon.layer.GENERAL',
      content: broken,
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { issues: string[] }).issues.join(' ')).toMatch(/metrics\.orderBy:/);
    expect(store.writes).toEqual([]);
    await app.close();
  });

  it('refuses a naming pattern that does not compile', async () => {
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);
    const broken = validLayer('GENERAL');
    broken.naming = { pattern: '^(?<service>.+', alias: 'group' };

    const res = await post(app, '/api/admin/templates/save', c, {
      name: 'horizon.layer.GENERAL',
      content: broken,
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { issues: string[] }).issues.join(' ')).toMatch(/naming\.pattern: invalid regex/);
    expect(store.writes).toEqual([]);
    await app.close();
  });

  it('refuses a deployment grouping rule whose regex does not compile', async () => {
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);
    const broken = validLayer('GENERAL');
    broken.deployment = { clusterBy: { kind: 'nameRegex', pattern: '^(?<group>[a-z', alias: 'group' } };

    const res = await post(app, '/api/admin/templates/save', c, {
      name: 'horizon.layer.GENERAL',
      content: broken,
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { issues: string[] }).issues.join(' ')).toMatch(
      /deployment\.clusterBy\.pattern: invalid regex/,
    );
    expect(store.writes).toEqual([]);
    await app.close();
  });

  it('refuses a role pair whose primary names none of that pair’s metrics', async () => {
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);
    const broken = validLayer('GENERAL');
    broken.deployment = {
      roleToRole: [
        {
          from: '*',
          to: '*',
          primary: 'writes',
          metrics: [{ id: 'write', label: 'Write', mqe: 'service_instance_relation_client_cpm' }],
        },
      ],
    };

    const res = await post(app, '/api/admin/templates/save', c, {
      name: 'horizon.layer.GENERAL',
      content: broken,
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { issues: string[] }).issues).toContain(
      'deployment.roleToRole.0.primary: "writes" is not one of this pair\'s metric ids (write)',
    );
    expect(store.writes).toEqual([]);
    await app.close();
  });

  it('publishes a half-authored deployment block — the editor seeds every hole in it', async () => {
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);
    const content = validLayer('GENERAL');
    content.alias = ''; // free text cleared
    content.deployment = {
      roleToRole: [
        // What "Add role pair" seeds.
        { from: '*', to: '*', primary: '', metrics: [] },
        // Sides and `primary` are free text, fillable before the roles (a
        // different card of the same editor) and the metric rows they name.
        { from: '', to: 'data', primary: 'write', metrics: [] },
        // A metric row added, `primary` not chosen yet.
        { from: '*', to: '*', primary: '', metrics: [{ id: 'metric_1', label: 'Metric 1', mqe: '' }] },
      ],
      // "Add role" + "Add metric".
      roles: [{ key: 'role_1', label: '', main: false, nodeMetrics: [{ id: 'metric_1', label: 'Metric 1', mqe: '', unit: '' }] }],
      // Switching a grouping rule to name-regex seeds an empty pattern.
      clusterBy: { kind: 'nameRegex', pattern: '', alias: 'group' },
    };

    const res = await post(app, '/api/admin/templates/save', c, {
      name: 'horizon.layer.GENERAL',
      content,
    });

    expect(res.statusCode).toBe(200);
    expect(store.writes).toEqual([{ op: 'create', id: 'horizon.layer.GENERAL' }]);
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

describe('a verb reaches its own page and no other', () => {
  const get = async (app: FastifyInstance, url: string, cookie: string) =>
    await app.inject({ method: 'GET', url, headers: { cookie } });

  it('a translation reader sees overview and layer sources — and no other kind', async () => {
    // Translating needs the source string beside the translation. It does not
    // need the Alert page, the 3D map, the theme or the time defaults, each of
    // which has a read verb of its own.
    bundle.rows = [
      { kind: 'layer', key: 'GENERAL', content: validLayer('GENERAL') },
      { kind: 'overview', key: 'services', content: validOverview('services') },
      { kind: 'alert', key: 'page-setup', content: { pinnedLayers: ['GENERAL'] } },
      { kind: 'theme', key: 'active', content: { themeId: 'horizon' } },
    ];
    const { app, cookie: c } = await buildAppAs(makeStore().fetchImpl, ['translation:read']);
    const res = await get(app, '/api/admin/templates/sync-status?force=true', c);
    expect(res.statusCode).toBe(200);
    const kinds = new Set((res.json() as { rows: Array<{ kind: string }> }).rows.map((r) => r.kind));
    expect([...kinds].sort()).toEqual(['layer', 'overview']);
    await app.close();
  });

  it('a bulk push touches only rows the caller may READ as well as write', async () => {
    // Write alone would push — and, through `synced`, enumerate — rows the
    // caller cannot look at.
    bundle.rows = [{ kind: 'theme', key: 'active', content: { themeId: 'horizon' } }];
    const store = makeStore();
    const { app, cookie: c } = await buildAppAs(store.fetchImpl, ['setup:write']);
    const res = await post(app, '/api/admin/templates/sync-all', c, {});
    const body = res.json() as { synced?: string[] };
    expect(body.synced ?? []).toEqual([]);
    expect(store.writes).toEqual([]);
    await app.close();
  });
});

describe('the read/write boundary between a template and its translations', () => {
  it('refuses an overlay name on /save — it would be written as its SOURCE row', async () => {
    // `buildEnvelope` re-derives the name from kind+key and DROPS the locale,
    // so this authorized as `translation:write` and landed on the source row.
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);

    const res = await post(app, '/api/admin/templates/save', c, {
      name: 'horizon.layer.GENERAL.i18n.es',
      content: validLayer('GENERAL'),
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('invalid_template_name');
    expect(store.writes).toEqual([]);
    expect(store.rows).toEqual([]);
    await app.close();
  });

  it('refuses an overlay that rewrites structure or a query, not wording', async () => {
    // The runtime merger replaces ANY string leaf at a matching path, so an
    // unchecked overlay is a structure edit under a permission that means text.
    const store = makeStore();
    bundle.rows = [{ kind: 'layer', key: 'GENERAL', content: validLayer('GENERAL') }];
    const { app, cookie: c } = await buildApp(store.fetchImpl);

    const res = await post(app, '/api/admin/templates/save-translation', c, {
      name: 'horizon.layer.GENERAL',
      locale: 'es',
      content: { key: 'EVIL' },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string; issues: string[] };
    expect(body.code).toBe('invalid_overlay');
    expect(body.issues.join(' ')).toContain('key');
    expect(store.writes).toEqual([]);
    await app.close();
  });

  it('accepts an overlay that only translates an allowlisted text field', async () => {
    const store = makeStore();
    bundle.rows = [{ kind: 'layer', key: 'GENERAL', content: validLayer('GENERAL') }];
    const { app, cookie: c } = await buildApp(store.fetchImpl);

    const res = await post(app, '/api/admin/templates/save-translation', c, {
      name: 'horizon.layer.GENERAL',
      locale: 'es',
      content: { alias: 'General (es)' },
    });

    expect(res.statusCode).toBe(200);
    expect(store.writes.length).toBe(1);
    await app.close();
  });
});

describe('POST /api/admin/templates/save — overview content reaching OAP', () => {
  it('refuses a dashboard whose id is not the row it is published as, and writes nothing', async () => {
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);

    // The list page reads each dashboard's identity from its CONTENT and the
    // page route reads it from the row NAME, so this row would answer as `mesh`
    // in the picker while `/services` and `/mesh` both resolved elsewhere.
    const res = await post(app, '/api/admin/templates/save', c, {
      name: 'horizon.overview.services',
      content: validOverview('mesh'),
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string; issues: string[] };
    expect(body.code).toBe('invalid_content');
    expect(body.issues).toEqual([
      'id: "mesh" is not the overview this is published as (horizon.overview.services)',
    ]);
    expect(store.writes).toEqual([]);
    await app.close();
  });

  it('refuses a misspelled field — the legacy schema stored it as dead config', async () => {
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);
    const broken = validOverview('services');
    (broken.widgets as Json[])[0].agregation = 'sum';

    const res = await post(app, '/api/admin/templates/save', c, {
      name: 'horizon.overview.services',
      content: broken,
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { issues: string[] }).issues.join(' ')).toMatch(/agregation/);
    expect(store.writes).toEqual([]);
    await app.close();
  });

  it('refuses a widget type the renderer has no case for', async () => {
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);
    const broken = validOverview('services');
    (broken.widgets as Json[])[0].type = 'pie';

    const res = await post(app, '/api/admin/templates/save', c, {
      name: 'horizon.overview.services',
      content: broken,
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { issues: string[] }).issues.join(' ')).toMatch(/widgets\.0\.type:/);
    expect(store.writes).toEqual([]);
    await app.close();
  });

  it('publishes a half-authored dashboard — every hole here is one the editor leaves open', async () => {
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);
    const content: Json = {
      id: 'services',
      title: '', // meta title cleared
      description: '',
      widgets: [
        // "— any —" layer, MQE cleared, tip + unit cleared.
        { id: 'w1', title: '', type: 'metric', mqe: '', tip: '', unit: '', span: 6, rowSpan: 2 },
        // Every KPI row removed, then one added back: "+ add row" seeds a blank MQE.
        { id: 'w2', title: 'Tile', type: 'kpi-tile', layer: 'GENERAL', kpis: [], span: 6, rowSpan: 2 },
        {
          id: 'w3',
          title: 'Tile 2',
          type: 'kpi-tile',
          layer: 'GENERAL',
          kpis: [{ label: 'new KPI', mqe: '' }],
          aggregateOnPage: true,
          // "A separate metric…" picked, expression not typed yet.
          rankBy: { mqe: '' },
          span: 6,
          rowSpan: 2,
        },
      ],
    };

    const res = await post(app, '/api/admin/templates/save', c, {
      name: 'horizon.overview.services',
      content,
    });

    expect(res.statusCode).toBe(200);
    expect(store.writes).toEqual([{ op: 'create', id: 'horizon.overview.services' }]);
    await app.close();
  });

  it('publishes a brand-new dashboard that has no widgets yet', async () => {
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);

    const res = await post(app, '/api/admin/templates/save', c, {
      name: 'horizon.overview.blank',
      content: { id: 'blank', title: 'Blank', widgets: [] },
    });

    expect(res.statusCode).toBe(200);
    expect(store.writes).toEqual([{ op: 'create', id: 'horizon.overview.blank' }]);
    await app.close();
  });
});

/**
 * The publish boundary and the runtime resolvers have to agree on ONE name per
 * template — that is the whole rule, and the two halves live in different
 * files, so pin them against each other rather than against a restated
 * expectation. Every spelling the route accepts must come back out of the
 * read side the pages actually use; every spelling it refuses must leave the
 * store untouched.
 */
describe('what publishes is what the runtime reads back', () => {
  it.each(['GENERAL', 'general', 'General', 'CACHE', 'VIRTUAL_CACHE'])(
    'layer name %s: accepted iff the layer page can resolve it',
    async (spelling) => {
      const store = makeStore();
      const { app, cookie: c, client } = await buildApp(store.fetchImpl);

      const res = await post(app, '/api/admin/templates/save', c, {
        name: `horizon.layer.${spelling}`,
        content: validLayer(spelling.toUpperCase()),
      });

      // What the sidebar hands the per-layer routes for this template.
      const routeKey = canonicalLayerKey(spelling).toLowerCase();
      const effective = await resolveEffectiveLayer(client, routeKey);

      expect(res.statusCode === 200).toBe(effective.template !== null);
      if (res.statusCode !== 200) expect(store.writes).toEqual([]);
      await app.close();
    },
  );

  it('layer: exactly the canonical spelling publishes', async () => {
    // Guards the case above from passing vacuously (all-refused / all-accepted).
    const accepted: string[] = [];
    for (const spelling of ['GENERAL', 'general', 'General', 'CACHE', 'VIRTUAL_CACHE']) {
      resync();
      const store = makeStore();
      const { app, cookie: c } = await buildApp(store.fetchImpl);
      const res = await post(app, '/api/admin/templates/save', c, {
        name: `horizon.layer.${spelling}`,
        content: validLayer(spelling.toUpperCase()),
      });
      if (res.statusCode === 200) accepted.push(spelling);
      await app.close();
    }
    expect(accepted).toEqual(['GENERAL', 'VIRTUAL_CACHE']);
  });

  it('overview: a record ALREADY stored as a dashboard it does not contain reaches neither read path', async () => {
    // The refusal only guards what Horizon writes from now on. A store written
    // before it — or by another tool — holds these, and the read side has to
    // apply the same rule or the row renders under the id its content claims.
    const store = makeStore();
    store.rows.push({
      id: 'misfiled',
      configuration: JSON.stringify({
        name: 'horizon.overview.ops',
        kind: 'overview',
        version: 1,
        content: validOverview('services'),
      }),
      disabled: false,
    });
    const { app, client } = await buildApp(store.fetchImpl);

    expect(await resolveEffectiveOverview(client, 'ops')).toBeNull();
    expect(await resolveEffectiveOverview(client, 'services')).toBeNull();
    expect(await resolveEffectiveOverviews(client)).toEqual([]);
    await app.close();
  });

  it('overview: the row that publishes is the row both read paths return', async () => {
    const store = makeStore();
    const { app, cookie: c, client } = await buildApp(store.fetchImpl);

    const mismatched = await post(app, '/api/admin/templates/save', c, {
      name: 'horizon.overview.services',
      content: validOverview('mesh'),
    });
    expect(mismatched.statusCode).toBe(400);
    expect(await resolveEffectiveOverview(client, 'services')).toBeNull();
    expect(await resolveEffectiveOverviews(client)).toEqual([]);

    const ok = await post(app, '/api/admin/templates/save', c, {
      name: 'horizon.overview.services',
      content: validOverview('services'),
    });
    expect(ok.statusCode).toBe(200);

    // The page route resolves by row name, the list by the content's own id —
    // the two only ever name the same dashboard because the publish enforced it.
    const byName = await resolveEffectiveOverview(client, 'services');
    expect((byName as { id: string } | null)?.id).toBe('services');
    expect((await resolveEffectiveOverviews(client)).map((d) => d.id)).toEqual(['services']);
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

  it('refuses a bundled layer whose orderBy names no column, and reports it once', async () => {
    const broken = validLayer('GENERAL');
    (broken.header as Json).orderBy = 'throttled';
    // A bundled row carries the authored `layer-header` and the loader's two
    // mirrors of it; the defect is one defect, not three.
    broken['layer-header'] = broken.header;
    broken.metrics = broken.header;
    bundle.rows = [{ kind: 'layer', key: 'GENERAL', content: broken }];
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);

    const res = await post(app, '/api/admin/templates/horizon.layer.GENERAL/push-bundled', c);

    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string; issues: string[] };
    expect(body.code).toBe('invalid_content');
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0]).toMatch(/\.orderBy: "throttled" is not one of the header columns/);
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

  it('refuses a bundled overview whose id is not its own file key', async () => {
    // A replaced `bundled_templates/` directory is the documented risk here:
    // the dashboard is keyed by the file, the content answers as another one.
    bundle.rows = [{ kind: 'overview', key: 'services', content: validOverview('mesh') }];
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);

    const res = await post(app, '/api/admin/templates/horizon.overview.services/push-bundled', c);

    expect(res.statusCode).toBe(400);
    expect((res.json() as { issues: string[] }).issues.join(' ')).toMatch(
      /is not the overview this is published as/,
    );
    expect(store.writes).toEqual([]);
    await app.close();
  });

  it('still pushes a well-formed bundled overview', async () => {
    bundle.rows = [{ kind: 'overview', key: 'services', content: validOverview('services') }];
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);

    const res = await post(app, '/api/admin/templates/horizon.overview.services/push-bundled', c);

    expect(res.statusCode).toBe(200);
    expect(store.writes).toEqual([{ op: 'create', id: 'horizon.overview.services' }]);
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

  it('accepts every overview dashboard this build bundles', () => {
    // Same reason as the layer case above: reset-to-bundled and sync-all
    // publish exactly these, so one the push bar refuses could never be reset
    // to. They are the loader's copies, which is what those routes read.
    const rejected = loadOverviewDashboards()
      .map((d) => ({ id: d.id, parsed: overviewTemplatePushSchema.safeParse(JSON.parse(JSON.stringify(d))) }))
      .filter((r) => !r.parsed.success)
      .map((r) => r.id);
    expect(rejected).toEqual([]);
    expect(loadOverviewDashboards().length).toBeGreaterThan(0);
  });

  it('finds no cross-reference defect in any layer template this build bundles', () => {
    // Reset-to-bundled and sync-all publish exactly these, and every one of them
    // carries all three header copies (`layer-header` + the loader's `header` /
    // `metrics` mirrors), so this also pins that a mirrored copy is not
    // reported once per copy.
    const found = allLayerTemplates().flatMap((tpl) => {
      const parsed = layerTemplatePushSchema.safeParse(JSON.parse(JSON.stringify(tpl)));
      if (!parsed.success) return [`${tpl.key}: does not parse`];
      return layerCrossRefIssues(parsed.data, { complete: false }).map(
        (i) => `${tpl.key}: ${i.path} — ${i.message}`,
      );
    });
    expect(found).toEqual([]);
  });
});

// The alarm-page setup, the active theme and the global time default were the
// only configuration published with no shape check at all: a malformed payload
// was stored on OAP verbatim and then served to every signed-in user, surfacing
// later as a page that would not render. OAP keeps these as opaque strings and
// tells the kinds apart only by row name, so this boundary is the only place
// the shape can be checked.
describe('POST /api/admin/templates/save — singleton settings reaching OAP', () => {
  const cases: { name: string; good: object; bad: object; badPath: string }[] = [
    {
      name: 'horizon.alert.page-setup',
      good: { pinnedLayers: ['GENERAL'], defaultWindowMs: 1_200_000, overviewAlarmsLimit: 200 },
      bad: { pinnedLayers: 'GENERAL', defaultWindowMs: 1_200_000, overviewAlarmsLimit: 200 },
      badPath: 'pinnedLayers:',
    },
    {
      name: 'horizon.theme.active',
      good: { themeId: 'horizon' },
      bad: { themeId: 'horizon', extra: true },
      badPath: '(root):',
    },
    {
      name: 'horizon.time-defaults.global',
      good: { defaultWindowMinutes: 60 },
      bad: { defaultWindowMinutes: -1 },
      badPath: 'defaultWindowMinutes:',
    },
  ];

  for (const { name, good, bad, badPath } of cases) {
    it(`refuses malformed ${name} and writes nothing`, async () => {
      const store = makeStore();
      const { app, cookie: c } = await buildApp(store.fetchImpl);

      const res = await post(app, '/api/admin/templates/save', c, { name, content: bad });

      expect(res.statusCode).toBe(400);
      const body = res.json() as { code: string; issues: string[] };
      expect(body.code).toBe('invalid_content');
      expect(body.issues.some((i) => i.startsWith(badPath))).toBe(true);
      expect(store.writes).toEqual([]);
      await app.close();
    });

    it(`still publishes a well-formed ${name}`, async () => {
      const store = makeStore();
      const { app, cookie: c } = await buildApp(store.fetchImpl);

      const res = await post(app, '/api/admin/templates/save', c, { name, content: good });

      expect(res.statusCode).toBe(200);
      expect(store.writes.length).toBe(1);
      await app.close();
    });
  }
});

// The publish boundary is where an operator gets a REASON. Without it a link
// to an untrusted host saves cleanly and then silently fails to render, which
// reads as a bug rather than as policy.
describe('POST /api/admin/templates/save — documentLink link policy', () => {
  const withLink = (documentLink: string): Json => ({ ...validLayer('GENERAL'), documentLink });

  it.each([
    ['a javascript: scheme', 'javascript:alert(1)', 'javascript:'],
    ['an untrusted host', 'https://evil.example/x', 'evil.example'],
  ])('refuses %s and writes nothing', async (_label, link, expected) => {
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);

    const res = await post(app, '/api/admin/templates/save', c, {
      name: 'horizon.layer.GENERAL',
      content: withLink(link),
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string; issues: string[] };
    expect(body.code).toBe('invalid_content');
    expect(body.issues.some((i) => i.startsWith('documentLink:') && i.includes(expected))).toBe(true);
    expect(store.writes).toEqual([]);
    await app.close();
  });

  it('publishes a link on the default trusted host', async () => {
    const store = makeStore();
    const { app, cookie: c } = await buildApp(store.fetchImpl);

    const res = await post(app, '/api/admin/templates/save', c, {
      name: 'horizon.layer.GENERAL',
      content: withLink('https://skywalking.apache.org/docs/'),
    });

    expect(res.statusCode).toBe(200);
    expect(store.writes.length).toBe(1);
    await app.close();
  });
});
