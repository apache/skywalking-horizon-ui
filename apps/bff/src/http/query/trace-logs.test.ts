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
 * A trace's logs: always read through a window around the trace, oldest
 * first, and only the rows of services the caller may read — a trace crosses
 * services, so no service is named and none can be required.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { ServiceIdentityResolver, serviceIdOf } from '../../logic/services/service-identity.js';
import type { ServiceCatalog, ServiceLayerCatalog } from '../../logic/services/service-layer-catalog.js';
import { registerColdStageHook } from '../../util/duration.js';
import { _resetCapabilitiesCache } from '../../logic/oap/capabilities.js';
import { registerLogRoute } from './log.js';

const PAY = { id: serviceIdOf('payments::checkout', true), name: 'payments::checkout', normal: true, group: 'payments' };
const RISK = { id: serviceIdOf('risk::scorer', true), name: 'risk::scorer', normal: true, group: 'risk' };
const ROLES = {
  admin: ['*'],
  payments: ['logs:read@GENERAL[payments]'],
};
const snapshot: ServiceCatalog = {
  layers: ['GENERAL'],
  byLayer: new Map([['GENERAL', [PAY, RISK]]]),
  byName: new Map(),
};
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function fakeOap(traceScopeFields = ['traceId', 'segmentId', 'spanId'], emptyFor: string[] = [], failFor: string[] = []) {
  const conditions: Record<string, unknown>[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const { query = '', variables = {} } = JSON.parse(String(init?.body ?? '{}')) as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    if (query.includes('getTimeInfo')) return json({ data: { getTimeInfo: { timezone: '+0000', currentTimestamp: Date.now() } } });
    if (query.includes('HorizonTraceScopeFields')) {
      return json({ data: { __type: { inputFields: traceScopeFields.map((name) => ({ name })) } } });
    }
    if (query.includes('HorizonOapCapabilities')) return json({ data: { __type: { fields: [] } } });
    if (query.includes('queryLogs')) {
      const condition = variables.condition as { relatedTrace?: { traceId?: string } };
      conditions.push(condition as Record<string, unknown>);
      const id = condition.relatedTrace?.traceId ?? '';
      if (failFor.includes(id)) return new Response('storage timed out', { status: 503 });
      const row = (svc: typeof PAY, ts: number) => ({ serviceId: svc.id, serviceName: svc.name, traceId: id, timestamp: ts, contentType: 'TEXT', content: 'x', tags: [] });
      return json({ data: { data: { logs: emptyFor.includes(id) ? [] : [row(PAY, 1), row(RISK, 2)] } } });
    }
    return json({ data: {} });
  };
  return { fetch, conditions };
}

async function read(
  role: keyof typeof ROLES,
  url: string,
  headers: Record<string, string> = {},
  traceScopeFields?: string[],
  emptyFor?: string[],
  failFor?: string[],
) {
  const oap = fakeOap(traceScopeFields, emptyFor, failFor);
  const cfg = configSchema.parse({ rbac: { roles: ROLES } });
  const config: ConfigSource = { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const catalog = { get: async () => snapshot } as unknown as ServiceLayerCatalog;
  const app = Fastify();
  await app.register(cookie);
  registerColdStageHook(app);
  app.addHook(
    'onRoute',
    makeRouteAuthHook({
      config,
      sessions,
      access: { services: new ServiceIdentityResolver({ config, catalog, fetch: oap.fetch }), classify: async () => ({ isOperate: () => false }) },
    }),
  );
  registerLogRoute(app, { config, sessions, fetch: oap.fetch });
  await app.ready();
  const sid = sessions.create(role, [role]).sid;
  const res = await app.inject({ method: 'GET', url, headers: { cookie: `horizon_sid=${sid}`, ...headers } });
  await app.close();
  return { status: res.statusCode, body: res.json(), conditions: oap.conditions };
}

const START = Date.UTC(2026, 10, 13, 8, 0, 0);
const END = START + 1500;
const WINDOW = `startMs=${START}&endMs=${END}`;

describe('GET /api/trace/:traceId/logs', () => {
  beforeEach(() => _resetCapabilitiesCache());

  it('reads the trace id oldest first, through the trace window widened by five minutes', async () => {
    const { status, body, conditions } = await read('admin', `/api/trace/t-1/logs?${WINDOW}`);
    expect(status).toBe(200);
    expect(conditions[0]).toMatchObject({
      relatedTrace: { traceId: 't-1' },
      queryOrder: 'ASC',
      queryDuration: { start: '2026-11-13 075500', end: '2026-11-13 080501', step: 'SECOND' },
    });
    expect(conditions[0]).not.toHaveProperty('serviceId');
    expect(body).toMatchObject({ startMs: START - 300_000, endMs: END + 300_000, reachable: true, windowClipped: false });
    expect(body.logs).toHaveLength(2);
  });

  it('searches the last week of a longer trace, and says where that began', async () => {
    const longStart = END - 9 * 24 * 3600_000;
    const { body, conditions } = await read('admin', `/api/trace/t-1/logs?startMs=${longStart}&endMs=${END}`);
    const weekBefore = END + 300_000 - 7 * 24 * 3600_000;
    expect(body).toMatchObject({ startMs: weekBefore, endMs: END + 300_000, windowClipped: true });
    expect(conditions[0]).toMatchObject({ queryDuration: { start: '2026-11-06 080501', end: '2026-11-13 080501' } });
  });

  it('narrows to one native span, span 0 included', async () => {
    const { conditions } = await read('admin', `/api/trace/t-1/logs?${WINDOW}&segmentId=seg-1&spanId=0`);
    expect(conditions[0].relatedTrace).toEqual({ traceId: 't-1', segmentId: 'seg-1', spanId: 0 });
  });

  it('reads cold storage when the Cold pill is on', async () => {
    const { conditions } = await read('admin', `/api/trace/t-1/logs?${WINDOW}`, { 'x-horizon-cold-stage': '1' });
    expect(conditions[0].queryDuration).toMatchObject({ coldStage: true });
  });

  it('refuses a read with no window, or half of a native span', async () => {
    for (const url of [
      '/api/trace/t-1/logs',
      `/api/trace/t-1/logs?startMs=${END}&endMs=${START}`,
      `/api/trace/t-1/logs?${WINDOW}&spanId=0`,
      `/api/trace/t-1/logs?${WINDOW}&segmentId=seg-1`,
      `/api/trace/t-1/logs?${WINDOW}&segmentId=seg-1&spanId=x`,
    ]) {
      const { status, conditions } = await read('admin', url);
      expect(status, url).toBe(400);
      expect(conditions, url).toHaveLength(0);
    }
  });

  it('narrows to one OTLP or Zipkin span on an OAP whose TraceScopeCondition takes otlpSpanId', async () => {
    const { status, conditions } = await read('admin', `/api/trace/t-1/logs?${WINDOW}&otlpSpanId=0123456789abcdef`, {}, [
      'traceId', 'segmentId', 'spanId', 'otlpSpanId',
    ]);
    expect(status).toBe(200);
    expect(conditions[0].relatedTrace).toEqual({ traceId: 't-1', otlpSpanId: '0123456789abcdef' });
  });

  it('sends no OTLP span id to an OAP that would reject the whole query for it', async () => {
    const { status, body, conditions } = await read('admin', `/api/trace/t-1/logs?${WINDOW}&otlpSpanId=0123456789abcdef`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ reachable: false, logs: [] });
    expect(body.error).toContain('11.2.0');
    expect(conditions).toHaveLength(0);
  });

  it('refuses an OTLP span id that is not 16 hex characters, or comes with a native span', async () => {
    for (const q of ['otlpSpanId=XYZ', 'otlpSpanId=0123456789ABCDEF', 'otlpSpanId=0123456789abcdef&segmentId=s&spanId=0']) {
      const { status, conditions } = await read('admin', `/api/trace/t-1/logs?${WINDOW}&${q}`);
      expect(status, q).toBe(400);
      expect(conditions, q).toHaveLength(0);
    }
  });

  it('serves a layer-limited role without naming a service, keeping only the rows it may read', async () => {
    const { status, body } = await read('payments', `/api/trace/t-1/logs?${WINDOW}`);
    expect(status).toBe(200);
    expect(body.logs.map((r: { serviceName: string }) => r.serviceName)).toEqual(['payments::checkout']);
    // Paged before the filter: the page says how many it left out.
    expect(body.withheld).toBe(1);
  });

  it('counts nothing as withheld for a caller who may read every row', async () => {
    const { body } = await read('admin', `/api/trace/t-1/logs?${WINDOW}`);
    expect(body.logs).toHaveLength(2);
    expect(body.withheld).toBe(0);
  });

  describe('a second spelling of the trace id', () => {
    const SHORT = 'a1b2c3d4e5f60718';
    const PADDED = `0000000000000000${SHORT}`;

    it('is read when the first finds nothing, and the reply names it', async () => {
      const { body, conditions } = await read('admin', `/api/trace/${SHORT}/logs?${WINDOW}&altTraceId=${PADDED}`, {}, undefined, [SHORT]);
      expect(conditions.map((c) => (c.relatedTrace as { traceId: string }).traceId)).toEqual([SHORT, PADDED]);
      expect(body).toMatchObject({ traceId: PADDED });
      expect(body.logs).toHaveLength(2);
    });

    it('is not read when the first answers', async () => {
      const { body, conditions } = await read('admin', `/api/trace/${SHORT}/logs?${WINDOW}&altTraceId=${PADDED}`);
      expect(conditions).toHaveLength(1);
      expect(body).toMatchObject({ traceId: SHORT });
    });

    it('reports its failure rather than the first spelling\'s empty answer', async () => {
      const { body, conditions } = await read('admin', `/api/trace/${SHORT}/logs?${WINDOW}&altTraceId=${PADDED}`, {}, undefined, [SHORT], [PADDED]);
      expect(conditions).toHaveLength(2);
      expect(body).toMatchObject({ reachable: false, traceId: PADDED, logs: [] });
      expect(body.error).toBeTruthy();
    });

    it('is not read past the first page', async () => {
      const { body, conditions } = await read('admin', `/api/trace/${SHORT}/logs?${WINDOW}&altTraceId=${PADDED}&page=2`, {}, undefined, [SHORT]);
      expect(conditions).toHaveLength(1);
      expect(body).toMatchObject({ traceId: SHORT, logs: [] });
    });
  });
});
