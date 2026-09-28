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
 * The route gate against the paths reproduced on a live OAP: the operate-layer
 * reads a plain viewer could make before, and the cross-group / cross-layer
 * reads a layer grant must refuse. Handlers here are stubs — what is under test
 * is whether the request reaches them.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../config/schema.js';
import type { ConfigSource } from '../config/loader.js';
import { SessionStore } from '../user/sessions.js';
import { makeRouteAuthHook, ROUTE_POLICY } from './route-policy.js';
import { ServiceIdentityResolver, serviceIdOf } from '../logic/services/service-identity.js';
import type { ServiceCatalog, ServiceLayerCatalog } from '../logic/services/service-layer-catalog.js';
import type { AccessDeps } from './request-access.js';

const PAY = { id: serviceIdOf('payments::checkout', true), name: 'payments::checkout', normal: true, group: 'payments' };
const RISK = { id: serviceIdOf('risk::scorer', true), name: 'risk::scorer', normal: true, group: 'risk' };
/** A payments service no other service shares a name with. */
const LEDGER = { id: serviceIdOf('payments::ledger', true), name: 'payments::ledger', normal: true, group: 'payments' };
const BDB = { id: serviceIdOf('showcase-banyandb', true), name: 'showcase-banyandb', normal: true, group: '' };
/** A conjectured service sharing PAY's name, in a layer the payments role is not granted. */
const PAY_VIRTUAL = { id: serviceIdOf('payments::checkout', false), name: 'payments::checkout', normal: false, group: 'payments' };

const snapshot: ServiceCatalog = {
  layers: ['GENERAL', 'BANYANDB', 'VIRTUAL_DATABASE'],
  byLayer: new Map([
    ['GENERAL', [PAY, RISK, LEDGER]],
    ['BANYANDB', [BDB]],
    ['VIRTUAL_DATABASE', [PAY_VIRTUAL]],
  ]),
  byName: new Map(),
};

const ROLES = {
  viewer: ['metrics:read', 'logs:read', 'traces:read', 'topology:read', 'profile:read'],
  maintainer: ['metrics:read', 'logs:read', 'traces:read', 'topology:read', 'profile:read', 'cluster:read'],
  payments: [
    'metrics:read@GENERAL[payments]',
    'logs:read@GENERAL[payments]',
    'traces:read@GENERAL[payments]',
    'topology:read@GENERAL[payments]',
    'profile:read@GENERAL[payments]',
    'events:read@GENERAL[payments]',
  ],
  bdb: ['metrics:read@BANYANDB'],
  payGenai: ['logs:read@GENERAL[payments]', 'logs:read@VIRTUAL_GENAI[payments]'],
  editor: ['metrics:read', 'topology:read', 'layer-template:write'],
};

function config(): ConfigSource {
  const cfg = configSchema.parse({ rbac: { roles: ROLES } });
  return { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
}

// OAP knows no service beyond the catalog.
const unknownToOap: FetchLike = async () =>
  new Response(JSON.stringify({ data: { service: null } }), { status: 200, headers: { 'content-type': 'application/json' } });

const oapDown: FetchLike = async () => {
  throw new Error('connect ECONNREFUSED');
};

function accessDeps(cfg: ConfigSource, fetch: FetchLike): AccessDeps {
  const catalog = { get: async () => snapshot } as unknown as ServiceLayerCatalog;
  return {
    services: new ServiceIdentityResolver({ config: cfg, fetch, catalog }),
    classify: async () => ({ isOperate: (l: string) => l.toUpperCase() === 'BANYANDB' }),
  };
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function build(fetch: FetchLike = unknownToOap): Promise<{ as: (role: keyof typeof ROLES) => string }> {
  const cfg = config();
  const sessions = new SessionStore({ ttlMinutes: 60 });
  app = Fastify();
  await app.register(cookie);
  app.addHook('onRoute', makeRouteAuthHook({ config: cfg, sessions, access: accessDeps(cfg, fetch) }));
  const ok = async () => ({ ok: true });
  app.get('/api/layer/:key/instances', ok);
  app.post('/api/layer/:key/logs', ok);
  app.get('/api/layer/:key/instance-topology', ok);
  app.post('/api/layer/:key/evaluation-records', ok);
  app.get('/api/layer/:key/topology', ok);
  app.get('/api/profile/tasks/:taskId/segments', ok);
  app.get('/api/zipkin/services', ok);
  app.post('/api/layer/:key/traces', ok);
  app.post('/api/mqe/exec', ok);
  app.post('/api/events', ok);
  app.post('/api/layer/:key/ebpf/network/process-relation-metrics', ok);
  app.get('/api/menu', async (req) => ({ access: req.access !== undefined }));
  await app.ready();
  return { as: (role) => `horizon_sid=${sessions.create(role, [role]).sid}` };
}

async function call(cookieHeader: string, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await app!.inject({ method, url, headers: { cookie: cookieHeader }, ...(payload ? { payload } : {}) });
  return { status: res.statusCode, body: res.json() as { reason?: string } };
}

const q = (s: { id: string; name: string }) =>
  `serviceId=${encodeURIComponent(s.id)}&service=${encodeURIComponent(s.name)}`;

describe('the operate layers need cluster:read or an explicit grant', () => {
  it('refuses a plain viewer the operate layer and its services, through any layer URL', async () => {
    const { as } = await build();
    const viewer = as('viewer');
    expect((await call(viewer, 'GET', `/api/layer/banyandb/instances?${q(BDB)}`)).body.reason).toBe('layer_not_granted');
    expect((await call(viewer, 'GET', `/api/layer/general/instances?${q(BDB)}`)).body.reason).toBe('service_not_granted');
    expect((await call(viewer, 'GET', `/api/layer/general/instances?${q(PAY)}`)).status).toBe(200);
  });

  it('checks the id the handler queries, not the name echoed beside it', async () => {
    const { as } = await build();
    const echo = (id: string, name: string) => `serviceId=${encodeURIComponent(id)}&service=${encodeURIComponent(name)}`;
    // The instances handler reads `serviceId` only, so the name cannot widen the read…
    expect((await call(as('viewer'), 'GET', `/api/layer/general/instances?${echo(PAY.id, BDB.name)}`)).status).toBe(200);
    expect((await call(as('viewer'), 'GET', `/api/layer/general/instances?${echo(BDB.id, PAY.name)}`)).status).toBe(403);
    // …and a list of names on a multi-service topology is not read as one service.
    const ids = `${PAY.id},${RISK.id}`;
    const names = `${PAY.name},${RISK.name}`;
    const topo = `/api/layer/general/topology?serviceId=${encodeURIComponent(ids)}&service=${encodeURIComponent(names)}`;
    expect((await call(as('viewer'), 'GET', topo)).status).toBe(200);
  });

  it('reads the one service an id names when a conjectured one shares its name', async () => {
    const { as } = await build();
    const url = `/api/layer/general/instances?serviceId=${encodeURIComponent(PAY.id)}&service=${encodeURIComponent(PAY.name)}`;
    expect((await call(as('payments'), 'GET', url)).status).toBe(200);
  });

  it('opens them to cluster:read, and to an explicit layer grant alone', async () => {
    const { as } = await build();
    expect((await call(as('maintainer'), 'GET', `/api/layer/banyandb/instances?${q(BDB)}`)).status).toBe(200);
    expect((await call(as('bdb'), 'GET', `/api/layer/banyandb/instances?${q(BDB)}`)).status).toBe(200);
    expect((await call(as('bdb'), 'GET', `/api/layer/general/instances?${q(PAY)}`)).body.reason).toBe('layer_not_granted');
  });

  it('refuses an MQE entity naming an operate-only service', async () => {
    const { as } = await build();
    const body = (name: string) => ({ expression: 'x', entity: { serviceName: name, normal: true }, step: 'MINUTE', startMs: 1, endMs: 2 });
    expect((await call(as('viewer'), 'POST', '/api/mqe/exec', body(BDB.name))).status).toBe(403);
    expect((await call(as('viewer'), 'POST', '/api/mqe/exec', body(PAY.name))).status).toBe(200);
  });

  it('reads a Service-scope metric through its source, never through the destination', async () => {
    const { as } = await build();
    const body = { expression: 'service_cpm', entity: { serviceName: RISK.name, normal: true, destServiceName: PAY.name, destNormal: true }, step: 'MINUTE', startMs: 1, endMs: 2 };
    expect((await call(as('payments'), 'POST', '/api/mqe/exec', body)).status).toBe(403);
    const own = { ...body, entity: { serviceName: PAY.name, normal: true, destServiceName: RISK.name, destNormal: true } };
    expect((await call(as('payments'), 'POST', '/api/mqe/exec', own)).status).toBe(200);
    // A destination alone names no service: the dummy handler here stands in
    // for mqe-exec's own inspect:read check, so the gate must let it through.
    const destOnly = { ...body, entity: { destServiceName: PAY.name, destNormal: true } };
    expect((await call(as('payments'), 'POST', '/api/mqe/exec', destOnly)).status).toBe(200);
  });

  it('checks a name exactly as the handler will send it', async () => {
    const { as } = await build();
    expect((await call(as('payments'), 'POST', '/api/events', { service: LEDGER.name })).status).toBe(200);
    expect((await call(as('payments'), 'POST', '/api/events', { service: ` ${LEDGER.name}` })).body.reason).toBe('identity_not_normalized');
  });

  it('refuses a padded identity, which one handler trims and another does not', async () => {
    const { as } = await build();
    const body = { expression: 'service_cpm', entity: { serviceName: `${BDB.name} `, normal: true }, step: 'MINUTE', startMs: 1, endMs: 2 };
    expect((await call(as('viewer'), 'POST', '/api/mqe/exec', body)).body.reason).toBe('identity_not_normalized');
  });

  it('refuses a name that is only whitespace, or carries control characters', async () => {
    const { as } = await build();
    for (const service of ['   ', `payments::led\u0007ger`, `payments::ledger\uD800`]) {
      expect((await call(as('payments'), 'POST', '/api/events', { service })).body.reason).toBe('identity_not_normalized');
    }
  });

  it('leaves a caller who reads every layer to the handler, as before', async () => {
    const { as } = await build(oapDown);
    const body = { expression: 'service_cpm', entity: { serviceName: `${BDB.name} `, normal: true }, step: 'MINUTE', startMs: 1, endMs: 2 };
    expect((await call(as('maintainer'), 'POST', '/api/mqe/exec', body)).status).toBe(200);
    const ghost = { id: serviceIdOf('ghost', true), name: 'ghost' };
    expect((await call(as('maintainer'), 'GET', `/api/layer/general/instances?${q(ghost)}`)).status).toBe(200);
  });

  it('answers an OAP it could not ask with an outage, not a refusal', async () => {
    const { as } = await build(oapDown);
    const ghost = { id: serviceIdOf('ghost', true), name: 'ghost' };
    const res = await call(as('viewer'), 'GET', `/api/layer/general/instances?${q(ghost)}`);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'oap_unreachable' });
    // A service the catalog already holds is decided without asking.
    expect((await call(as('viewer'), 'GET', `/api/layer/general/instances?${q(PAY)}`)).status).toBe(200);
  });

  it('reads a baseline through every service its name can mean', async () => {
    const { as } = await build();
    const body = (expression: string) => ({ expression, entity: { serviceName: PAY.name, normal: true }, step: 'HOUR', startMs: 1, endMs: 2 });
    expect((await call(as('payments'), 'POST', '/api/mqe/exec', body('service_cpm'))).status).toBe(200);
    // OAP looks a baseline up by name, so the conjectured namesake is read too.
    expect((await call(as('payments'), 'POST', '/api/mqe/exec', body('baseline(service_cpm,value)'))).status).toBe(403);
  });

  it('lets a plain viewer name a service OAP does not know, as before', async () => {
    const { as } = await build();
    const ghost = { id: serviceIdOf('ghost', true), name: 'ghost' };
    expect((await call(as('viewer'), 'GET', `/api/layer/general/instances?${q(ghost)}`)).status).toBe(200);
  });
});

describe('a group-limited grant reads its own services only', () => {
  it('refuses another group, and an instance of another group under its own service id', async () => {
    const { as } = await build();
    const pay = as('payments');
    expect((await call(pay, 'POST', '/api/layer/general/logs', { serviceId: PAY.id, service: PAY.name })).status).toBe(200);
    expect((await call(pay, 'POST', '/api/layer/general/logs', { serviceId: RISK.id, service: RISK.name })).status).toBe(403);
    const riskInstance = `${RISK.id}_aW5zdA==`;
    const res = await call(pay, 'POST', '/api/layer/general/logs', { serviceId: PAY.id, serviceInstanceId: riskInstance });
    expect(res.status).toBe(403);
  });

  it('must name a service where OAP would read every one', async () => {
    const { as } = await build();
    expect((await call(as('payments'), 'POST', '/api/layer/general/logs', {})).body.reason).toBe('service_required');
    expect((await call(as('viewer'), 'POST', '/api/layer/general/logs', {})).status).toBe(200);
  });

  it('reads a relation when it owns either end', async () => {
    const { as } = await build();
    const url = (a: string, b: string) =>
      `/api/layer/general/instance-topology?client=${encodeURIComponent(a)}&server=${encodeURIComponent(b)}`;
    expect((await call(as('payments'), 'GET', url(PAY.id, RISK.id))).status).toBe(200);
    expect((await call(as('payments'), 'GET', url(RISK.id, RISK.id))).status).toBe(403);
  });

  it('reads evaluation records only with the VIRTUAL_GENAI layer, whatever the URL', async () => {
    const { as } = await build();
    const res = await call(as('payments'), 'POST', '/api/layer/general/evaluation-records', { serviceId: PAY.id });
    expect(res.body.reason).toBe('layer_not_granted');
  });

  it('reads an evaluation record through either end of the call', async () => {
    const { as } = await build();
    const pay = as('payGenai');
    const url = '/api/layer/virtual_genai/evaluation-records';
    expect((await call(pay, 'POST', url, { providerId: PAY.id })).status).toBe(200);
    expect((await call(pay, 'POST', url, { providerId: RISK.id, serviceId: PAY.id })).status).toBe(200);
    expect((await call(pay, 'POST', url, { providerId: RISK.id })).status).toBe(403);
    // The handler queries `serviceId` and ignores `service` beside it.
    expect((await call(pay, 'POST', url, { serviceId: RISK.id, service: PAY.name })).status).toBe(403);
    expect((await call(pay, 'POST', url, {})).body.reason).toBe('service_required');
  });

  it('reads a process end as the service the handler reads, normal unless it says false', async () => {
    const { as } = await build();
    const url = '/api/layer/general/ebpf/network/process-relation-metrics';
    const end = (normal?: unknown) => ({ source: { serviceName: PAY.name, ...(normal === undefined ? {} : { normal }) } });
    expect((await call(as('payments'), 'POST', url, end())).status).toBe(200);
    expect((await call(as('payments'), 'POST', url, end('false'))).status).toBe(200);
    // The conjectured namesake sits in a layer the payments role is not granted.
    expect((await call(as('payments'), 'POST', url, end(false))).status).toBe(403);
    // An edge opens for a role that reads either end.
    const edge = (from: { name: string }, to: { name: string }) => ({
      source: { serviceName: from.name, processName: 'p' },
      dest: { serviceName: to.name, processName: 'q' },
    });
    expect((await call(as('payments'), 'POST', url, edge(PAY, RISK))).status).toBe(200);
    expect((await call(as('payments'), 'POST', url, edge(RISK, PAY))).status).toBe(200);
    expect((await call(as('payments'), 'POST', url, edge(RISK, RISK))).status).toBe(403);
    for (const serviceName of ['', null, undefined]) {
      const ends = { source: { serviceName, processName: 'p' }, dest: { serviceName: PAY.name, processName: 'q' } };
      expect((await call(as('viewer'), 'POST', url, ends)).body.reason, String(serviceName)).toBe('identity_not_normalized');
    }
  });

  it('attributes a profiling task to the service its id ends with', async () => {
    const { as } = await build();
    const url = (task: string) => `/api/profile/tasks/${encodeURIComponent(task)}/segments`;
    expect((await call(as('payments'), 'GET', url(`1700000000000_${PAY.id}`))).status).toBe(200);
    expect((await call(as('payments'), 'GET', url(`1700000000000_${RISK.id}`))).status).toBe(403);
    expect((await call(as('payments'), 'GET', url('opaque'))).body.reason).toBe('id_names_no_service');
    expect((await call(as('viewer'), 'GET', url('opaque'))).status).toBe(200);
  });

  it('leaves trace stores and trace-id lookups to the trace, which crosses layers', async () => {
    const { as } = await build();
    expect((await call(as('payments'), 'GET', '/api/zipkin/services')).status).toBe(200);
    const traces = (body: Record<string, unknown>) => call(as('payments'), 'POST', '/api/layer/general/traces', body);
    expect((await traces({ source: 'zipkin', service: 'any-zipkin-name' })).status).toBe(200);
    expect((await traces({ source: 'native', traceId: 't-1' })).status).toBe(200);
    // OAP drops a blank trace id and lists every service's traces.
    for (const traceId of [' ', '', ' t-1']) {
      expect((await traces({ source: 'native', traceId })).body.reason, JSON.stringify(traceId)).toBe('service_required');
    }
    expect((await traces({ source: 'native', traceIds: ['t-1'] })).body.reason).toBe('service_required');
    expect((await traces({ source: 'native' })).body.reason).toBe('service_required');
    expect((await traces({ source: 'native', serviceId: RISK.id })).status).toBe(403);
  });
});

describe('the gate itself', () => {
  it('runs a draft template only for someone who may write templates', async () => {
    const { as } = await build();
    const url = '/api/layer/general/topology?previewConfig=%7B%7D';
    expect((await call(as('viewer'), 'GET', url)).body.reason).toBe('preview_needs_template_write');
    expect((await call(as('editor'), 'GET', url)).status).toBe(200);
    // A draft in any other shape is still a draft: a parser could coerce it.
    expect((await call(as('viewer'), 'GET', `${url}&previewConfig=%7B%7D`)).body.reason).toBe('preview_needs_template_write');
    const relation = '/api/layer/general/ebpf/network/process-relation-metrics';
    const body = { source: { serviceName: PAY.name, processName: 'p' }, dest: { serviceName: PAY.name, processName: 'q' } };
    expect((await call(as('viewer'), 'POST', relation, { ...body, previewConfig: ['{}'] })).body.reason).toBe('preview_needs_template_write');
  });

  it('hands the menu its access object', async () => {
    const { as } = await build();
    expect((await call(as('viewer'), 'GET', '/api/menu')).body).toEqual({ access: true });
  });

  it('refuses to register a per-service route the scope table does not list', async () => {
    const cfg = config();
    const probe = Fastify();
    probe.addHook('onRoute', makeRouteAuthHook({ config: cfg, sessions: new SessionStore({ ttlMinutes: 60 }) }));
    ROUTE_POLICY['GET /api/layer/:key/unlisted'] = 'metrics:read';
    try {
      expect(() => probe.get('/api/layer/:key/unlisted', async () => ({}))).toThrow(/ROUTE_SCOPE/);
    } finally {
      delete ROUTE_POLICY['GET /api/layer/:key/unlisted'];
      await probe.close();
    }
  });
});
