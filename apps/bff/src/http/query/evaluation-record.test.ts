/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to you under the Apache License, Version 2.0
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

import { beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { resetServiceLayerCatalog } from '../../logic/services/service-layer-catalog.js';
import { fetchEvaluationRecords, registerEvaluationRecordRoute } from './evaluation-record.js';
import { registerLandingRoute } from './landing.js';

interface Paging { pageNum: number; pageSize: number }

function slice<T>(rows: readonly T[], paging: Paging): T[] {
  const from = paging.pageSize * (paging.pageNum - 1);
  return rows.slice(from, from + paging.pageSize);
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

function fakeConfig(): ConfigSource {
  const cfg = configSchema.parse({
    oap: { queryUrl: 'http://evaluation-test.invalid' },
    rbac: { roles: { admin: ['*'], 'logs-only': ['logs:read'] } },
  });
  return { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
}

interface CapturedCall {
  query: string;
  variables: Record<string, unknown>;
}

function fakeRouteOap(): { fetch: FetchLike; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const request = JSON.parse(String(init?.body ?? '{}')) as CapturedCall;
    calls.push(request);
    if (request.query.includes('getTimeInfo')) return json({ data: { time: { timezone: '+0800' } } });
    if (request.query.includes('listLayers')) return json({ data: { layers: ['VIRTUAL_GENAI'] } });
    if (request.query.includes('HorizonServiceCatalogServices')) {
      return json({ data: { _0: [{ id: 'service-openai-id', name: 'openai', normal: false, group: '' }] } });
    }
    if (request.query.includes('QueryGenAIEvaluationRecordFacets')) {
      return json({ data: { data: { genAIEvaluationRecordList: [{ serviceName: 'openai', evaluationLevel: 'GOOD' }] } } });
    }
    if (request.query.includes('QueryGenAIEvaluationRecords')) {
      return json({ data: { data: { genAIEvaluationRecordList: [] } } });
    }
    return json({ data: {} });
  };
  return { fetch, calls };
}

async function buildRoute(fetch: FetchLike, role = 'admin'): Promise<{ app: FastifyInstance; sid: string }> {
  const config = fakeConfig();
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const app = Fastify();
  await app.register(cookie);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
  registerEvaluationRecordRoute(app, { config, sessions, fetch });
  registerLandingRoute(app, { config, sessions, fetch });
  await app.ready();
  return { app, sid: sessions.create('op', [role]).sid };
}

beforeEach(() => resetServiceLayerCatalog());

describe('evaluation-record paging', () => {
  it('keeps page 2 at the requested size and probes page 3 without skipping a row', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({
      traceRef: { type: i % 2 === 0 ? 'SKYWALKING_NATIVE' : 'OTLP', traceId: `trace-${i}` },
      valueType: 'SCORE',
      scoreValue: i,
      evaluationTime: i,
    }));
    let variables: Record<string, { paging: Paging }> = {};
    const fetch: FetchLike = async (_url, init) => {
      const request = JSON.parse(String(init?.body ?? '{}')) as {
        variables: Record<string, { paging: Paging }>;
      };
      variables = request.variables;
      return new Response(JSON.stringify({
        data: {
          data: { genAIEvaluationRecordList: slice(rows, variables.condition.paging) },
          probe: { genAIEvaluationRecordList: slice(rows, variables.probe.paging) },
        },
      }), { headers: { 'content-type': 'application/json' } });
    };

    const result = await fetchEvaluationRecords(
      { queryUrl: 'http://oap.invalid', timeoutMs: 1_000, fetch },
      { traceType: 'OTLP' },
      { start: '2026-01-01 000000', end: '2026-01-01 010000' },
      { pageNum: 2, pageSize: 50 },
      false,
    );

    expect(variables.condition).not.toHaveProperty('relatedTrace');
    expect(variables.probe).not.toHaveProperty('relatedTrace');
    expect(result.records).toHaveLength(50);
    expect(new Set(result.records.map((row) => row.traceRef?.type)).size).toBe(2);
    expect(variables.condition.paging).toEqual({ pageNum: 2, pageSize: 50 });
    expect(variables.probe.paging).toEqual({ pageNum: 101, pageSize: 1 });
    expect(result.records[0]?.traceId).toBe('trace-50');
    expect(result.records.at(-1)?.traceId).toBe('trace-99');
    expect(result.hasNext).toBe(true);
  });

  it('soft-fails when OAP cannot be reached', async () => {
    const fetch: FetchLike = async () => { throw new Error('network down'); };
    const result = await fetchEvaluationRecords(
      { queryUrl: 'http://oap.invalid', timeoutMs: 1_000, fetch },
      {},
      { start: '2026-01-01 000000', end: '2026-01-01 010000' },
      { pageNum: 1, pageSize: 50 },
      false,
    );
    expect(result).toMatchObject({ reachable: false, records: [], error: 'network down' });
  });
});

describe('evaluation-record route scope and time window', () => {
  it('denies metric expressions to a logs-only user while allowing the evaluation catalog', async () => {
    const oap = fakeRouteOap();
    const { app, sid } = await buildRoute(oap.fetch, 'logs-only');
    try {
      const headers = { cookie: `horizon_sid=${sid}` };
      const denied = await app.inject({
        method: 'POST', url: '/api/layer/general/landing', headers,
        payload: { topN: 1, orderBy: 'x', columns: [{ metric: 'x', label: 'x', mqe: 'service_cpm' }] },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ error: 'permission_denied', verb: 'metrics:read' });
      expect(oap.calls).toHaveLength(0);
      const catalog = await app.inject({ method: 'GET', url: '/api/evaluation-record/caller-services', headers });
      expect(catalog.statusCode).toBe(200);
      expect(catalog.json().services).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'service-openai-id' })]));
      expect(oap.calls.some((call) => call.query.includes('execExpression'))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it.each([
    [0.0079, 7900, 7900], [0.0157, 15700, 15700],
    [0.0079001, 7901, 7900], [0.0156999, 15700, 15699],
    [5e-7, 1, 0], [-5e-7, 0, -1], [-0.0079001, -7900, -7901],
    [0, 0, 0], [1, 1_000_000, 1_000_000],
  ])('preserves decimal score %s in list, probe and facets bounds', async (score, minScore, maxScore) => {
    const oap = fakeRouteOap();
    await fetchEvaluationRecords(
      { queryUrl: 'http://oap.invalid', timeoutMs: 1_000, fetch: oap.fetch },
      { valueType: 'SCORE', minScore: score, maxScore: score },
      { start: '2026-01-01 000000', end: '2026-01-01 010000' },
      { pageNum: 2, pageSize: 50 }, false,
    );
    const list = oap.calls.find((call) => call.query.includes('QueryGenAIEvaluationRecords'))!;
    expect(list.variables.condition).toMatchObject({ minScore, maxScore });
    expect(list.variables.probe).toMatchObject({ minScore, maxScore });
    const { app, sid } = await buildRoute(oap.fetch);
    try {
      const res = await app.inject({
        method: 'POST', url: '/api/layer/virtual_genai/evaluation-records/facets',
        headers: { cookie: `horizon_sid=${sid}` },
        payload: { valueType: 'SCORE', minScore: score, maxScore: score },
      });
      expect(res.statusCode).toBe(200);
      const facets = oap.calls.find((call) => call.query.includes('QueryGenAIEvaluationRecordFacets'))!;
      expect(facets.variables.evaluationRecordCondition).toMatchObject({ minScore, maxScore });
    } finally {
      await app.close();
    }
  });
  it('resolves a service name and formats epoch milliseconds in the OAP timezone', async () => {
    const oap = fakeRouteOap();
    const { app, sid } = await buildRoute(oap.fetch);
    const res = await app.inject({
      method: 'POST',
      url: '/api/layer/virtual_genai/evaluation-records',
      headers: { cookie: `horizon_sid=${sid}` },
      payload: {
        service: 'openai',
        startTime: Date.parse('2026-01-01T00:00:00Z'),
        endTime: Date.parse('2026-01-01T01:00:00Z'),
      },
    });
    expect(res.statusCode).toBe(200);
    const call = oap.calls.find((c) => c.query.includes('QueryGenAIEvaluationRecords'));
    const condition = call?.variables.condition as Record<string, unknown>;
    expect(condition.serviceId).toBe('service-openai-id');
    expect(condition.queryDuration).toEqual({
      start: '2026-01-01 080000',
      end: '2026-01-01 090000',
      step: 'SECOND',
    });
  });

  it.each([
    [{ startTime: 1_000 }, 'startTime and endTime must be provided together'],
    [{ startTime: 2_000, endTime: 1_000 }, 'endTime must be greater than startTime'],
    [{ startTime: 1_000, endTime: 1_000 + 7 * 24 * 60 * 60_000 + 1 }, 'time window cannot exceed 7 days'],
  ])('rejects an invalid explicit window', async (payload, error) => {
    const oap = fakeRouteOap();
    const { app, sid } = await buildRoute(oap.fetch);
    const res = await app.inject({
      method: 'POST',
      url: '/api/layer/virtual_genai/evaluation-records',
      headers: { cookie: `horizon_sid=${sid}` },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error });
  });

  it('applies the active list filters to facets and reports only sampled rows', async () => {
    const oap = fakeRouteOap();
    const { app, sid } = await buildRoute(oap.fetch);
    const res = await app.inject({
      method: 'POST',
      url: '/api/layer/virtual_genai/evaluation-records/facets',
      headers: { cookie: `horizon_sid=${sid}` },
      payload: {
        service: 'openai', providerId: 'provider-1', modelId: 'model-1', valueType: 'SCORE',
        minScore: 0.25, maxScore: 0.75, taskName: 'quality', judgeModel: 'judge-1',
        traceId: 'trace-1', traceType: 'OTLP', windowMinutes: 30,
      },
    });
    expect(res.statusCode).toBe(200);
    const call = oap.calls.find((c) => c.query.includes('QueryGenAIEvaluationRecordFacets'));
    const condition = call?.variables.evaluationRecordCondition as Record<string, unknown>;
    expect(condition).toMatchObject({
      serviceId: 'service-openai-id', providerId: 'provider-1', modelId: 'model-1', valueType: 'SCORE',
      minScore: 250_000, maxScore: 750_000, taskName: 'quality', judgeModel: 'judge-1',
      relatedTrace: { type: 'OTLP', traceId: 'trace-1' },
    });
    expect(res.json()).toMatchObject({ sampled: 1, services: [{ name: 'openai', count: 1 }] });
    // The id rides along: it is what the Service condition filters by, and a
    // caller that only reports through the Zipkin receiver has no catalog row.
    expect(res.json().services[0]).toHaveProperty('id');
    expect(res.json()).not.toHaveProperty('total');
  });

  it('narrows the related trace to one span — segment and index for native, span id for OTLP', async () => {
    const oap = fakeRouteOap();
    const { app, sid } = await buildRoute(oap.fetch);
    const post = (url: string, payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url, headers: { cookie: `horizon_sid=${sid}` }, payload: { windowMinutes: 30, ...payload } });
    const related = (operation: string, variable: string) => {
      const call = oap.calls.find((c) => c.query.includes(operation));
      return (call?.variables[variable] as { relatedTrace?: unknown } | undefined)?.relatedTrace;
    };

    // The other scheme's field rides along and must be dropped, not forwarded.
    await post('/api/layer/virtual_genai/evaluation-records', {
      traceId: 'trace-1', traceType: 'SKYWALKING_NATIVE', traceSegmentId: 'seg-1', traceSpanIndex: 2, traceSpanId: 'stray',
    });
    expect(related('QueryGenAIEvaluationRecords', 'condition')).toEqual({ type: 'SKYWALKING_NATIVE', traceId: 'trace-1', segmentId: 'seg-1', spanIndex: 2 });

    oap.calls.length = 0;
    await post('/api/layer/virtual_genai/evaluation-records', {
      traceId: 'trace-2', traceType: 'OTLP', traceSpanId: 'span-9', traceSegmentId: 'stray', traceSpanIndex: 0,
    });
    expect(related('QueryGenAIEvaluationRecords', 'condition')).toEqual({ type: 'OTLP', traceId: 'trace-2', spanId: 'span-9' });

    // Index 0 is the first span, not "unset".
    oap.calls.length = 0;
    await post('/api/layer/virtual_genai/evaluation-records/facets', {
      traceId: 'trace-3', traceType: 'SKYWALKING_NATIVE', traceSegmentId: 'seg-3', traceSpanIndex: 0,
    });
    expect(related('QueryGenAIEvaluationRecordFacets', 'evaluationRecordCondition')).toEqual({ type: 'SKYWALKING_NATIVE', traceId: 'trace-3', segmentId: 'seg-3', spanIndex: 0 });
  });

  it.each(['OTLP', 'SKYWALKING_NATIVE'] as const)('ignores standalone %s type in facets without a trace ID', async (type) => {
    const oap = fakeRouteOap();
    const { app, sid } = await buildRoute(oap.fetch);
    try {
      const res = await app.inject({
        method: 'POST', url: '/api/layer/virtual_genai/evaluation-records/facets',
        headers: { cookie: `horizon_sid=${sid}` }, payload: { traceType: type },
      });
      expect(res.statusCode).toBe(200);
      const call = oap.calls.find((c) => c.query.includes('QueryGenAIEvaluationRecordFacets'));
      const condition = call?.variables.evaluationRecordCondition as Record<string, unknown>;
      expect(condition).not.toHaveProperty('relatedTrace');
      expect(condition.queryDuration).toBeDefined();
      expect(condition).not.toHaveProperty('traceType');
      expect(res.json()).toMatchObject({ sampled: 1 });
    } finally {
      await app.close();
    }
  });

  it('ignores an empty max score consistently with the list query', async () => {
    const oap = fakeRouteOap();
    const { app, sid } = await buildRoute(oap.fetch);
    const res = await app.inject({
      method: 'POST',
      url: '/api/layer/virtual_genai/evaluation-records/facets',
      headers: { cookie: `horizon_sid=${sid}` },
      payload: { valueType: 'SCORE', maxScore: '' },
    });
    expect(res.statusCode).toBe(200);
    const call = oap.calls.find((c) => c.query.includes('QueryGenAIEvaluationRecordFacets'));
    const condition = call?.variables.evaluationRecordCondition as Record<string, unknown>;
    expect(condition).not.toHaveProperty('maxScore');
  });
});
