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
 * Profiling is read on the page's layer and a task's service: a segment or a
 * schedule is analyzed only as one of that task's, and a network-profiling
 * call only as one of the profiled instance's.
 */

import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { ServiceIdentityResolver, serviceIdOf } from '../../logic/services/service-identity.js';
import { resetServiceLayerCatalog, serviceLayerCatalog } from '../../logic/services/service-layer-catalog.js';
import { registerProfileRoutes } from './profile.js';
import { registerEBPFRoutes } from './ebpf.js';
import { registerContinuousProfilingRoutes } from './continuous-profiling.js';

const PAY = serviceIdOf('payments::checkout', true);
const RISK = serviceIdOf('risk::scorer', true);
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const sent: string[] = [];
const oap: FetchLike = async (_url, init) => {
  const { query = '' } = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
  sent.push(query);
  if (query.includes('HorizonServiceCatalogLayers')) return json({ data: { layers: ['GENERAL'] } });
  if (query.includes('HorizonServiceCatalogServices')) {
    return json({
      data: {
        _0: [
          { id: PAY, name: 'payments::checkout', normal: true, group: 'payments' },
          { id: RISK, name: 'risk::scorer', normal: true, group: 'risk' },
        ],
      },
    });
  }
  if (query.includes('getProfileTaskSegmentList')) {
    return json({ data: { segmentList: [{ traceId: 't', spans: [{ spanId: 0, segmentId: 'seg-1' }, { spanId: 1, segmentId: 'seg-2' }] }] } });
  }
  if (query.includes('getProfileAnalyze')) return json({ data: { analyze: { tip: null, trees: [{ elements: [] }] } } });
  if (query.includes('queryEBPFSchedules')) {
    return json({
      data: {
        eBPFSchedules: [
          { scheduleId: 's-pay', taskId: 't', process: { serviceId: PAY } },
          { scheduleId: 's-risk', taskId: 't', process: { serviceId: RISK } },
        ],
      },
    });
  }
  if (query.includes('analysisEBPF')) return json({ data: { analysisEBPFResult: { tip: null, trees: [{ elements: [] }] } } });
  if (query.includes('HorizonContinuousProfilingPolicyTypes')) return json({ data: { targets: [{ type: 'ON_CPU' }] } });
  if (query.includes('getTimeInfo')) return json({ data: { getTimeInfo: { timezone: '+0000', currentTimestamp: Date.now() } } });
  return json({ data: {} });
};

async function send(method: 'GET' | 'POST', url: string, payload?: unknown, role = 'admin') {
  const cfg = configSchema.parse({ rbac: { builtinRoles: 'keep', roles: { payments: ['profile:read@GENERAL[payments]'], 'payments-editor': ['profile:read@GENERAL[payments]', 'layer-template:write'] } } });
  const config: ConfigSource = { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
  const sessions = new SessionStore({ ttlMinutes: 60 });
  resetServiceLayerCatalog();
  const catalog = serviceLayerCatalog({ config, fetch: oap });
  const app = Fastify();
  await app.register(cookie);
  app.addHook(
    'onRoute',
    makeRouteAuthHook({
      config,
      sessions,
      access: { services: new ServiceIdentityResolver({ config, catalog, fetch: oap }), classify: async () => ({ isOperate: () => false }) },
    }),
  );
  registerProfileRoutes(app, { config, sessions, fetch: oap });
  registerEBPFRoutes(app, { config, sessions, fetch: oap });
  registerContinuousProfilingRoutes(app, { config, sessions, fetch: oap });
  await app.ready();
  const sid = sessions.create('op', [role]).sid;
  const res = await app.inject({ method, url, headers: { cookie: `horizon_sid=${sid}` }, ...(payload ? { payload } : {}) });
  await app.close();
  resetServiceLayerCatalog();
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

const range = { start: 1, end: 2 };

describe('profiling analysis', () => {
  it('analyzes a segment only as one of the task\'s', async () => {
    const url = `/api/layer/general/profile/tasks/1700000000000_${encodeURIComponent(PAY)}/analyze`;
    expect((await send('POST', url, { queries: [{ segmentId: 'seg-1', timeRange: range }, { segmentId: 'seg-2', timeRange: range }] })).status).toBe(200);
    expect((await send('POST', url, { queries: [{ segmentId: 'seg-9', timeRange: range }] })).body).toMatchObject({ reason: 'segment_not_in_task' });
  });

  it('analyzes a schedule only as one of the task\'s, on the named service', async () => {
    const url = '/api/layer/general/ebpf/tasks/t/analyze';
    const body = (id: string) => ({ serviceId: PAY, scheduleIdList: [id], timeRanges: [range] });
    expect((await send('POST', url, body('s-pay'))).status).toBe(200);
    expect((await send('POST', url, body('s-risk'))).body).toMatchObject({ reason: 'schedule_not_in_task' });
  });

  it('lists the task\'s schedules on the named service\'s processes', async () => {
    const res = await send('GET', `/api/layer/general/ebpf/tasks/t/schedules?serviceId=${encodeURIComponent(PAY)}`);
    expect((res.body.schedules as Array<{ scheduleId: string }>).map((s) => s.scheduleId)).toEqual(['s-pay']);
  });

  // The built-in viewer has no cluster:read, so it does not read every layer:
  // a task id names no service, and leaving the service out would list or
  // analyze another layer's processes.
  it('needs a service from a role that does not read every layer', async () => {
    const all = '/api/layer/general/ebpf/tasks/t/schedules';
    expect((await send('GET', all, undefined, 'viewer')).body).toMatchObject({ reason: 'service_required' });
    expect(((await send('GET', all)).body.schedules as unknown[]).length).toBe(2);
    const analyze = '/api/layer/general/ebpf/tasks/t/analyze';
    const body = { scheduleIdList: ['s-risk'], timeRanges: [range] };
    expect((await send('POST', analyze, body, 'viewer')).body).toMatchObject({ reason: 'service_required' });
    expect((await send('POST', analyze, body)).status).toBe(200);
  });

  it('keeps the named-service reads open to the built-in viewer', async () => {
    const res = await send('GET', `/api/layer/general/ebpf/tasks/t/schedules?serviceId=${encodeURIComponent(PAY)}`, undefined, 'viewer');
    expect((res.body.schedules as Array<{ scheduleId: string }>).map((s) => s.scheduleId)).toEqual(['s-pay']);
    const analyze = await send('POST', '/api/layer/general/ebpf/tasks/t/analyze', { serviceId: PAY, scheduleIdList: ['s-pay'], timeRanges: [range] }, 'viewer');
    expect(analyze.status).toBe(200);
  });
});

describe('a network-profiling call', () => {
  it('is read only when one end is a process of the profiled instance', async () => {
    const url = '/api/layer/general/ebpf/network/process-relation-metrics';
    const instance = `${PAY}_${Buffer.from('pay-1').toString('base64')}`;
    const end = (serviceName: string, serviceInstanceName: string) => ({ serviceName, serviceInstanceName, processName: 'p' });
    const own = await send('POST', url, { serviceInstanceId: instance, source: end('payments::checkout', 'pay-1'), dest: end('risk::scorer', 'r-1') });
    expect(own.status).toBe(200);
    const other = await send('POST', url, { serviceInstanceId: instance, source: end('risk::scorer', 'r-1'), dest: end('risk::scorer', 'r-2') });
    expect(other.body).toMatchObject({ reason: 'not_the_profiled_instance' });
  });

  // OAP reads a `baseline` by the entity's service name, which is the source's,
  // so the source decides it even when the profiled instance is the dest.
  it('runs a baseline only when the calling service can be read', async () => {
    const url = '/api/layer/general/ebpf/network/process-relation-metrics';
    const instance = `${PAY}_${Buffer.from('pay-1').toString('base64')}`;
    const end = (serviceName: string, serviceInstanceName: string) => ({ serviceName, serviceInstanceName, processName: 'p' });
    const previewConfig = JSON.stringify({
      edgeMetrics: [
        { id: 'cpm', label: 'CPM', mqe: 'process_relation_client_write_cpm', side: 'client' },
        { id: 'base', label: 'Baseline', mqe: 'baseline(process_relation_client_write_cpm, value)', side: 'client' },
      ],
    });
    const run = async (source: ReturnType<typeof end>) => {
      sent.length = 0;
      const res = await send('POST', url, { serviceInstanceId: instance, previewConfig, source, dest: end('payments::checkout', 'pay-1') }, 'payments-editor');
      expect(res.status).toBe(200);
      const relation = sent.filter((q) => q.includes('execExpression')).join('\n');
      expect(relation).toContain('process_relation_client_write_cpm');
      return relation.includes('baseline(');
    };
    expect(await run(end('risk::scorer', 'r-1'))).toBe(false);
    expect(await run(end('payments::checkout', 'pay-1'))).toBe(true);
  });
});

describe('the continuous-profiling policy summary', () => {
  const names = async (role: string) => {
    const res = await send('GET', '/api/continuous-profiling/policy-summary?layer=GENERAL', undefined, role);
    return (res.body.services as Array<{ name: string }>).map((s) => s.name);
  };

  it('lists the layer\'s services a role reads, and only those', async () => {
    expect(await names('admin')).toEqual(['payments::checkout', 'risk::scorer']);
    expect(await names('viewer')).toEqual(['payments::checkout', 'risk::scorer']);
    expect(await names('payments')).toEqual(['payments::checkout']);
  });
});
