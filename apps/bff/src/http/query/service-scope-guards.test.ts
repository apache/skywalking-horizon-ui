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
 * The entity-scoped query routes' scoping contract: a `service` the caller
 * asked for and OAP does not know REFUSES the read. It must never fall through
 * as "no service", because every one of these OAP conditions treats a missing
 * serviceId as "all services" — the operator would read another service's
 * traces / logs / errors / profiling tasks under the name they picked.
 *
 * The mirror obligation is here too: a caller that deliberately supplies NO
 * service still gets the cross-service query it asked for.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { invalidateTraceQueryApiCache } from '../../util/trace-protocol-cache.js';
import { registerTraceRoutes } from './trace.js';
import { registerLogRoute } from './log.js';
import { registerBrowserErrorsRoute } from './browser-errors.js';
import { registerEBPFRoutes } from './ebpf.js';
import { registerProfileRoutes } from './profile.js';
import { registerAsyncProfileRoutes } from './async-profile.js';

const SERVICE_NAME = 'songs.sample-services';
const SERVICE_ID = 'c29uZ3M=.1';
const INSTANCE_ID = 'c29uZ3M=.1_aW5zdC0x';

interface Captured {
  query: string;
  variables: Record<string, unknown>;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fake OAP that answers every query these routes issue and records them, so
 *  a test can assert BOTH what was asked and — the point of this file — that
 *  the data query was never asked at all. */
function fakeOap(known: Array<{ id: string; name: string }>): {
  fetch: FetchLike;
  calls: Captured[];
  asked: (fragment: string) => Captured[];
} {
  const calls: Captured[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Captured;
    const query = body.query ?? '';
    calls.push({ query, variables: body.variables ?? {} });
    if (query.includes('hasQueryTracesV2Support')) return json({ data: { hasQueryTracesV2Support: false } });
    if (query.includes('listServices')) return json({ data: { services: known } });
    if (query.includes('queryBasicTraces')) {
      return json({
        data: {
          data: {
            traces: [
              {
                key: 'seg-1',
                endpointNames: ['/api'],
                duration: 12,
                start: '1',
                isError: false,
                traceIds: ['t-1'],
              },
            ],
          },
        },
      });
    }
    if (query.includes('queryLogs')) {
      return json({
        data: { data: { logs: [{ timestamp: 1, contentType: 'TEXT', content: 'hello', tags: [] }] } },
      });
    }
    if (query.includes('queryBrowserErrorLogs')) {
      return json({
        data: {
          data: {
            logs: [
              {
                service: 'app',
                serviceVersion: 'v1',
                time: 1,
                pagePath: '/',
                category: 'AJAX',
                firstReportedError: true,
              },
            ],
          },
        },
      });
    }
    if (query.includes('queryEBPFProfilingTasks')) {
      return json({ data: { queryEBPFTasks: [{ taskId: 'ebpf-1', taskStartTime: 1 }] } });
    }
    if (query.includes('queryPrepareCreateEBPFProfilingTaskData')) {
      return json({ data: { createTaskData: { couldProfiling: true, processLabels: [] } } });
    }
    if (query.includes('getProfileTaskList')) return json({ data: { taskList: [{ id: 'trace-task-1' }] } });
    if (query.includes('queryAsyncProfilerTaskList')) {
      return json({ data: { asyncTaskList: { tasks: [{ id: 'async-1' }] } } });
    }
    if (query.includes('queryPprofTaskList')) {
      return json({ data: { pprofTaskList: { tasks: [{ id: 'pprof-1' }] } } });
    }
    return json({ data: {} });
  };
  return { fetch, calls, asked: (fragment) => calls.filter((c) => c.query.includes(fragment)) };
}

function fakeConfig(): ConfigSource {
  const cfg = configSchema.parse({});
  return { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
}

type Register = (
  app: FastifyInstance,
  deps: { config: ConfigSource; sessions: SessionStore; fetch: FetchLike },
) => void;

async function build(register: Register, fetchImpl: FetchLike): Promise<{ app: FastifyInstance; sid: string }> {
  const config = fakeConfig();
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const app = Fastify();
  await app.register(cookie);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
  register(app, { config, sessions, fetch: fetchImpl });
  await app.ready();
  return { app, sid: sessions.create('op', ['admin']).sid };
}

/** The `serviceId` an OAP condition/request variable carries, or undefined. */
function scopedTo(call: Captured | undefined, path: 'condition' | 'request' | 'root'): unknown {
  if (!call) return undefined;
  if (path === 'root') return call.variables.serviceId;
  const holder = call.variables[path] as Record<string, unknown> | undefined;
  return holder?.serviceId;
}

// Every OAP target shares the process-global trace-API probe cache; clear it so
// each test's fake OAP answers the probe itself.
beforeEach(() => invalidateTraceQueryApiCache());

describe('traces refuse an unresolvable service instead of listing every service', () => {
  const post = async (fetchImpl: FetchLike, body: Record<string, unknown>) => {
    const { app, sid } = await build(registerTraceRoutes, fetchImpl);
    const res = await app.inject({
      method: 'POST',
      url: '/api/layer/mesh/traces',
      headers: { cookie: `horizon_sid=${sid}`, 'content-type': 'application/json' },
      payload: { source: 'native', ...body },
    });
    return res.json();
  };

  it('answers a stale service name with a not-found reason and NO trace query', async () => {
    const oap = fakeOap([{ id: SERVICE_ID, name: SERVICE_NAME }]);
    const out = await post(oap.fetch, { service: 'retired-service' });
    expect(out.native.reachable).toBe(false);
    expect(out.native.error).toContain('retired-service');
    expect(out.native.traces).toHaveLength(0);
    expect(oap.asked('queryBasicTraces')).toHaveLength(0);
  });

  it('resolves a real name and scopes the query to its id', async () => {
    const oap = fakeOap([{ id: SERVICE_ID, name: SERVICE_NAME }]);
    const out = await post(oap.fetch, { service: SERVICE_NAME });
    expect(out.native.reachable).toBe(true);
    expect(out.native.traces).toHaveLength(1);
    expect(scopedTo(oap.asked('queryBasicTraces')[0], 'condition')).toBe(SERVICE_ID);
  });

  it('takes a service id straight from the body without a lookup', async () => {
    const oap = fakeOap([]);
    const out = await post(oap.fetch, { serviceId: SERVICE_ID });
    expect(out.native.reachable).toBe(true);
    expect(scopedTo(oap.asked('queryBasicTraces')[0], 'condition')).toBe(SERVICE_ID);
    expect(oap.asked('listServices')).toHaveLength(0);
  });

  it('keeps the deliberate all-services query when no service is supplied', async () => {
    const oap = fakeOap([]);
    const out = await post(oap.fetch, {});
    expect(out.native.reachable).toBe(true);
    expect(out.native.traces).toHaveLength(1);
    expect(scopedTo(oap.asked('queryBasicTraces')[0], 'condition')).toBeUndefined();
  });
});

describe('logs refuse an unresolvable service instead of streaming every service', () => {
  const post = async (fetchImpl: FetchLike, url: string, body: Record<string, unknown>) => {
    const { app, sid } = await build(registerLogRoute, fetchImpl);
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { cookie: `horizon_sid=${sid}`, 'content-type': 'application/json' },
      payload: body,
    });
    return res.json();
  };

  it('answers a stale service name with a not-found reason and NO log query', async () => {
    const oap = fakeOap([{ id: SERVICE_ID, name: SERVICE_NAME }]);
    const out = await post(oap.fetch, '/api/layer/mesh/logs', { service: 'retired-service' });
    expect(out.reachable).toBe(false);
    expect(out.error).toContain('retired-service');
    expect(out.logs).toHaveLength(0);
    expect(oap.asked('queryLogs')).toHaveLength(0);
  });

  it('resolves a real name and scopes the query to its id', async () => {
    const oap = fakeOap([{ id: SERVICE_ID, name: SERVICE_NAME }]);
    const out = await post(oap.fetch, '/api/layer/mesh/logs', { service: SERVICE_NAME });
    expect(out.reachable).toBe(true);
    expect(out.logs).toHaveLength(1);
    expect(scopedTo(oap.asked('queryLogs')[0], 'condition')).toBe(SERVICE_ID);
  });

  it('keeps the deliberate all-services query when no service is supplied', async () => {
    const oap = fakeOap([]);
    const out = await post(oap.fetch, '/api/layer/mesh/logs', {});
    expect(out.reachable).toBe(true);
    expect(scopedTo(oap.asked('queryLogs')[0], 'condition')).toBeUndefined();
  });

  // The facet rail counts a bigger sample than the page: unscoped, it would
  // attribute other services' log volume to the one on screen.
  it('refuses the facet sample for a stale service name too', async () => {
    const oap = fakeOap([{ id: SERVICE_ID, name: SERVICE_NAME }]);
    const out = await post(oap.fetch, '/api/layer/mesh/logs/facets', { service: 'retired-service' });
    expect(out.reachable).toBe(false);
    expect(out.error).toContain('retired-service');
    expect(oap.asked('queryLogs')).toHaveLength(0);
  });
});

describe('browser errors refuse an unresolvable service', () => {
  const post = async (fetchImpl: FetchLike, body: Record<string, unknown>) => {
    const { app, sid } = await build(registerBrowserErrorsRoute, fetchImpl);
    const res = await app.inject({
      method: 'POST',
      url: '/api/layer/browser/browser-errors',
      headers: { cookie: `horizon_sid=${sid}`, 'content-type': 'application/json' },
      payload: body,
    });
    return res.json();
  };

  it('answers a stale service name with a not-found reason and NO error-log query', async () => {
    const oap = fakeOap([{ id: SERVICE_ID, name: SERVICE_NAME }]);
    const out = await post(oap.fetch, { service: 'retired-app' });
    expect(out.reachable).toBe(false);
    expect(out.error).toContain('retired-app');
    expect(out.logs).toHaveLength(0);
    expect(oap.asked('queryBrowserErrorLogs')).toHaveLength(0);
  });

  it('resolves a real name and scopes the query to its id', async () => {
    const oap = fakeOap([{ id: SERVICE_ID, name: SERVICE_NAME }]);
    const out = await post(oap.fetch, { service: SERVICE_NAME });
    expect(out.reachable).toBe(true);
    expect(out.logs).toHaveLength(1);
    expect(scopedTo(oap.asked('queryBrowserErrorLogs')[0], 'condition')).toBe(SERVICE_ID);
  });

  it('keeps the deliberate all-services query when no service is supplied', async () => {
    const oap = fakeOap([]);
    const out = await post(oap.fetch, {});
    expect(out.reachable).toBe(true);
    expect(scopedTo(oap.asked('queryBrowserErrorLogs')[0], 'condition')).toBeUndefined();
  });
});

describe('profiling task lists refuse an unresolvable service', () => {
  const get = async (register: Register, fetchImpl: FetchLike, url: string) => {
    const { app, sid } = await build(register, fetchImpl);
    const res = await app.inject({ method: 'GET', url, headers: { cookie: `horizon_sid=${sid}` } });
    return res.json();
  };

  it('eBPF: reports the unknown service instead of a silent empty list', async () => {
    const oap = fakeOap([{ id: SERVICE_ID, name: SERVICE_NAME }]);
    const out = await get(registerEBPFRoutes, oap.fetch, '/api/layer/mesh/ebpf/tasks?service=retired-service');
    expect(out.reachable).toBe(false);
    expect(out.error).toContain('retired-service');
    expect(oap.asked('queryEBPFProfilingTasks')).toHaveLength(0);
  });

  it('eBPF network: a stale service never widens to the whole fleet', async () => {
    const oap = fakeOap([{ id: SERVICE_ID, name: SERVICE_NAME }]);
    const out = await get(
      registerEBPFRoutes,
      oap.fetch,
      '/api/layer/mesh/ebpf/network/tasks?service=retired-service',
    );
    expect(out.reachable).toBe(false);
    expect(out.error).toContain('retired-service');
    expect(oap.asked('queryEBPFProfilingTasks')).toHaveLength(0);
  });

  it('eBPF network: an instance-only call stays a legitimate instance-scoped query', async () => {
    const oap = fakeOap([]);
    const out = await get(
      registerEBPFRoutes,
      oap.fetch,
      `/api/layer/mesh/ebpf/network/tasks?serviceInstance=${encodeURIComponent(INSTANCE_ID)}`,
    );
    expect(out.reachable).toBe(true);
    const call = oap.asked('queryEBPFProfilingTasks')[0];
    expect(scopedTo(call, 'root')).toBeUndefined();
    expect(call?.variables.serviceInstanceId).toBe(INSTANCE_ID);
  });

  it('trace profiling: reports the unknown service instead of a silent empty list', async () => {
    const oap = fakeOap([{ id: SERVICE_ID, name: SERVICE_NAME }]);
    const out = await get(registerProfileRoutes, oap.fetch, '/api/layer/mesh/profile/tasks?service=retired-service');
    expect(out.reachable).toBe(false);
    expect(out.error).toContain('retired-service');
    expect(oap.asked('getProfileTaskList')).toHaveLength(0);
  });

  it('trace profiling: a real name still lists that service\'s tasks', async () => {
    const oap = fakeOap([{ id: SERVICE_ID, name: SERVICE_NAME }]);
    const out = await get(
      registerProfileRoutes,
      oap.fetch,
      `/api/layer/mesh/profile/tasks?service=${encodeURIComponent(SERVICE_NAME)}`,
    );
    expect(out.reachable).toBe(true);
    expect(out.tasks).toHaveLength(1);
    expect(scopedTo(oap.asked('getProfileTaskList')[0], 'root')).toBe(SERVICE_ID);
  });

  it('async profiler: reports the unknown service instead of a silent empty list', async () => {
    const oap = fakeOap([{ id: SERVICE_ID, name: SERVICE_NAME }]);
    const out = await get(
      registerAsyncProfileRoutes,
      oap.fetch,
      '/api/layer/mesh/async/tasks?service=retired-service',
    );
    expect(out.reachable).toBe(false);
    expect(out.error).toContain('retired-service');
    expect(oap.asked('queryAsyncProfilerTaskList')).toHaveLength(0);
  });

  it('pprof: reports the unknown service instead of a silent empty list', async () => {
    const oap = fakeOap([{ id: SERVICE_ID, name: SERVICE_NAME }]);
    const out = await get(
      registerAsyncProfileRoutes,
      oap.fetch,
      '/api/layer/mesh/pprof/tasks?service=retired-service',
    );
    expect(out.reachable).toBe(false);
    expect(out.error).toContain('retired-service');
    expect(oap.asked('queryPprofTaskList')).toHaveLength(0);
  });

  it('pprof: a real name still scopes the task list to its id', async () => {
    const oap = fakeOap([{ id: SERVICE_ID, name: SERVICE_NAME }]);
    const out = await get(
      registerAsyncProfileRoutes,
      oap.fetch,
      `/api/layer/mesh/pprof/tasks?service=${encodeURIComponent(SERVICE_NAME)}`,
    );
    expect(out.reachable).toBe(true);
    expect(out.tasks).toHaveLength(1);
    expect(scopedTo(oap.asked('queryPprofTaskList')[0], 'request')).toBe(SERVICE_ID);
  });
});
