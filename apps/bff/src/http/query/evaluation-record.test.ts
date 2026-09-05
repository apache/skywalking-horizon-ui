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

interface Paging { pageNum: number; pageSize: number }

function slice<T>(rows: readonly T[], paging: Paging): T[] {
  const from = paging.pageSize * (paging.pageNum - 1);
  return rows.slice(from, from + paging.pageSize);
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

function fakeConfig(): ConfigSource {
  const cfg = configSchema.parse({ oap: { queryUrl: 'http://evaluation-test.invalid' } });
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

async function buildRoute(fetch: FetchLike): Promise<{ app: FastifyInstance; sid: string }> {
  const config = fakeConfig();
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const app = Fastify();
  await app.register(cookie);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
  registerEvaluationRecordRoute(app, { config, sessions, fetch });
  await app.ready();
  return { app, sid: sessions.create('op', ['admin']).sid };
}

beforeEach(() => resetServiceLayerCatalog());

describe('evaluation-record paging', () => {
  it('keeps page 2 at the requested size and probes page 3 without skipping a row', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({
      traceRef: { type: 'SKYWALKING_NATIVE', traceId: `trace-${i}` },
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
      {},
      { start: '2026-01-01 000000', end: '2026-01-01 010000' },
      { pageNum: 2, pageSize: 50 },
      false,
    );

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
    expect(res.json()).not.toHaveProperty('total');
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
