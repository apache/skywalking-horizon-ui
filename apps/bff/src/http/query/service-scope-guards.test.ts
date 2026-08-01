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
 * The entity-scoped query routes' scoping contract.
 *
 * Every one of them takes the service IDENTITY the roster returned — the id and
 * the name together — and resolves NOTHING: no `listServices` round-trip on any
 * path, ever. The query lands on the id, so a name that arrived without one has
 * nothing to scope with and REFUSES: every OAP condition here reads a missing
 * serviceId as "all services", and the operator would read another service's
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
import { registerInstanceRoute } from './instance.js';
import { registerEndpointRoute } from './endpoint.js';

const SERVICE_NAME = 'songs.sample-services';
const SERVICE_ID = 'c29uZ3M=.1';
const INSTANCE_ID = 'c29uZ3M=.1_aW5zdC0x';
/** The pair as every picker holds it, spelled for a query string. */
const PAIR = `serviceId=${encodeURIComponent(SERVICE_ID)}&service=${encodeURIComponent(SERVICE_NAME)}`;

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
 *  the roster was never asked at all. */
function fakeOap(): {
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
    if (query.includes('listInstances')) return json({ data: { instances: [{ id: INSTANCE_ID, name: 'inst-1' }] } });
    if (query.includes('findEndpoint')) return json({ data: { endpoints: [{ id: 'ep-1', name: '/api' }] } });
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

/** GET one of these routes as a logged-in operator, decoded. */
async function get(register: Register, fetchImpl: FetchLike, url: string) {
  const { app, sid } = await build(register, fetchImpl);
  const res = await app.inject({ method: 'GET', url, headers: { cookie: `horizon_sid=${sid}` } });
  return res.json();
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

describe('traces scope on the id they were given, and refuse a lone name', () => {
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

  it('answers a name with no id with a refusal and NO trace query', async () => {
    const oap = fakeOap();
    const out = await post(oap.fetch, { service: SERVICE_NAME });
    expect(out.native.reachable).toBe(false);
    expect(out.native.error).toContain(SERVICE_NAME);
    expect(out.native.traces).toHaveLength(0);
    expect(oap.asked('queryBasicTraces')).toHaveLength(0);
    expect(oap.asked('listServices')).toHaveLength(0);
  });

  it('queries the pair by its id, without asking the roster', async () => {
    const oap = fakeOap();
    const out = await post(oap.fetch, { serviceId: SERVICE_ID, service: SERVICE_NAME });
    expect(out.native.reachable).toBe(true);
    expect(out.native.traces).toHaveLength(1);
    expect(scopedTo(oap.asked('queryBasicTraces')[0], 'condition')).toBe(SERVICE_ID);
    expect(oap.asked('listServices')).toHaveLength(0);
  });

  it('keeps the deliberate all-services query when no service is supplied', async () => {
    const oap = fakeOap();
    const out = await post(oap.fetch, {});
    expect(out.native.reachable).toBe(true);
    expect(out.native.traces).toHaveLength(1);
    expect(scopedTo(oap.asked('queryBasicTraces')[0], 'condition')).toBeUndefined();
  });
});

describe('logs scope on the id they were given, and refuse a lone name', () => {
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

  it('answers a name with no id with a refusal and NO log query', async () => {
    const oap = fakeOap();
    const out = await post(oap.fetch, '/api/layer/mesh/logs', { service: SERVICE_NAME });
    expect(out.reachable).toBe(false);
    expect(out.error).toContain(SERVICE_NAME);
    expect(out.logs).toHaveLength(0);
    expect(oap.asked('queryLogs')).toHaveLength(0);
    expect(oap.asked('listServices')).toHaveLength(0);
  });

  it('queries the pair by its id', async () => {
    const oap = fakeOap();
    const out = await post(oap.fetch, '/api/layer/mesh/logs', {
      serviceId: SERVICE_ID,
      service: SERVICE_NAME,
    });
    expect(out.reachable).toBe(true);
    expect(out.logs).toHaveLength(1);
    expect(scopedTo(oap.asked('queryLogs')[0], 'condition')).toBe(SERVICE_ID);
    expect(oap.asked('listServices')).toHaveLength(0);
  });

  it('keeps the deliberate all-services query when no service is supplied', async () => {
    const oap = fakeOap();
    const out = await post(oap.fetch, '/api/layer/mesh/logs', {});
    expect(out.reachable).toBe(true);
    expect(scopedTo(oap.asked('queryLogs')[0], 'condition')).toBeUndefined();
  });

  // The facet rail counts a bigger sample than the page: unscoped, it would
  // attribute other services' log volume to the one on screen.
  it('refuses the facet sample for a lone name too', async () => {
    const oap = fakeOap();
    const out = await post(oap.fetch, '/api/layer/mesh/logs/facets', { service: SERVICE_NAME });
    expect(out.reachable).toBe(false);
    expect(out.error).toContain(SERVICE_NAME);
    expect(oap.asked('queryLogs')).toHaveLength(0);
  });
});

describe('browser errors scope on the id they were given', () => {
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

  it('answers a name with no id with a refusal and NO error-log query', async () => {
    const oap = fakeOap();
    const out = await post(oap.fetch, { service: 'retired-app' });
    expect(out.reachable).toBe(false);
    expect(out.error).toContain('retired-app');
    expect(out.logs).toHaveLength(0);
    expect(oap.asked('queryBrowserErrorLogs')).toHaveLength(0);
    expect(oap.asked('listServices')).toHaveLength(0);
  });

  it('queries the pair by its id', async () => {
    const oap = fakeOap();
    const out = await post(oap.fetch, { serviceId: SERVICE_ID, service: SERVICE_NAME });
    expect(out.reachable).toBe(true);
    expect(out.logs).toHaveLength(1);
    expect(scopedTo(oap.asked('queryBrowserErrorLogs')[0], 'condition')).toBe(SERVICE_ID);
  });

  it('keeps the deliberate all-services query when no service is supplied', async () => {
    const oap = fakeOap();
    const out = await post(oap.fetch, {});
    expect(out.reachable).toBe(true);
    expect(scopedTo(oap.asked('queryBrowserErrorLogs')[0], 'condition')).toBeUndefined();
  });
});

describe('profiling task lists refuse a lone name and never look one up', () => {
  it('eBPF: reports the missing id instead of a silent empty list', async () => {
    const oap = fakeOap();
    const out = await get(registerEBPFRoutes, oap.fetch, `/api/layer/mesh/ebpf/tasks?service=${encodeURIComponent(SERVICE_NAME)}`);
    expect(out.reachable).toBe(false);
    expect(out.error).toContain(SERVICE_NAME);
    expect(oap.asked('queryEBPFProfilingTasks')).toHaveLength(0);
    expect(oap.asked('listServices')).toHaveLength(0);
  });

  it('eBPF: the pair lists that service\'s tasks, with no roster lookup', async () => {
    const oap = fakeOap();
    const out = await get(registerEBPFRoutes, oap.fetch, `/api/layer/mesh/ebpf/tasks?${PAIR}`);
    expect(out.reachable).toBe(true);
    expect(scopedTo(oap.asked('queryEBPFProfilingTasks')[0], 'root')).toBe(SERVICE_ID);
    expect(oap.asked('listServices')).toHaveLength(0);
  });

  it('eBPF network: a lone name never widens to the whole fleet', async () => {
    const oap = fakeOap();
    const out = await get(
      registerEBPFRoutes,
      oap.fetch,
      `/api/layer/mesh/ebpf/network/tasks?service=${encodeURIComponent(SERVICE_NAME)}`,
    );
    expect(out.reachable).toBe(false);
    expect(out.error).toContain(SERVICE_NAME);
    expect(oap.asked('queryEBPFProfilingTasks')).toHaveLength(0);
  });

  it('eBPF network: an instance-only call stays a legitimate instance-scoped query', async () => {
    const oap = fakeOap();
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

  it('trace profiling: reports the missing id instead of a silent empty list', async () => {
    const oap = fakeOap();
    const out = await get(registerProfileRoutes, oap.fetch, `/api/layer/mesh/profile/tasks?service=${encodeURIComponent(SERVICE_NAME)}`);
    expect(out.reachable).toBe(false);
    expect(out.error).toContain(SERVICE_NAME);
    expect(oap.asked('getProfileTaskList')).toHaveLength(0);
  });

  it('trace profiling: the pair lists that service\'s tasks', async () => {
    const oap = fakeOap();
    const out = await get(registerProfileRoutes, oap.fetch, `/api/layer/mesh/profile/tasks?${PAIR}`);
    expect(out.reachable).toBe(true);
    expect(out.tasks).toHaveLength(1);
    expect(scopedTo(oap.asked('getProfileTaskList')[0], 'root')).toBe(SERVICE_ID);
    expect(oap.asked('listServices')).toHaveLength(0);
  });

  it('async profiler: reports the missing id instead of a silent empty list', async () => {
    const oap = fakeOap();
    const out = await get(
      registerAsyncProfileRoutes,
      oap.fetch,
      `/api/layer/mesh/async/tasks?service=${encodeURIComponent(SERVICE_NAME)}`,
    );
    expect(out.reachable).toBe(false);
    expect(out.error).toContain(SERVICE_NAME);
    expect(oap.asked('queryAsyncProfilerTaskList')).toHaveLength(0);
  });

  it('pprof: reports the missing id instead of a silent empty list', async () => {
    const oap = fakeOap();
    const out = await get(
      registerAsyncProfileRoutes,
      oap.fetch,
      `/api/layer/mesh/pprof/tasks?service=${encodeURIComponent(SERVICE_NAME)}`,
    );
    expect(out.reachable).toBe(false);
    expect(out.error).toContain(SERVICE_NAME);
    expect(oap.asked('queryPprofTaskList')).toHaveLength(0);
  });

  it('pprof: the pair scopes the task list to its id', async () => {
    const oap = fakeOap();
    const out = await get(registerAsyncProfileRoutes, oap.fetch, `/api/layer/mesh/pprof/tasks?${PAIR}`);
    expect(out.reachable).toBe(true);
    expect(out.tasks).toHaveLength(1);
    expect(scopedTo(oap.asked('queryPprofTaskList')[0], 'request')).toBe(SERVICE_ID);
    expect(oap.asked('listServices')).toHaveLength(0);
  });
});

// An id is `base64(<name>).<0|1>` — a shape an ordinary name can wear (`api.1`,
// `orders.2026`) — and a name can equally be another service's id string.
// Neither half is inspected: the query goes to the id slot's value, whatever
// either of them looks like.
describe('the two halves are never traded for each other', () => {
  const CONFUSING = [
    { name: 'api.1', id: 'YXBpLjE=.1' },
    { name: 'orders.2026', id: 'b3JkZXJzLjIwMjY=.1' },
    // The name IS another service's id string; the id slot still decides.
    { name: 'c29uZ3M=.1', id: 'Z2F0ZXdheQ==.1' },
  ];

  it.each(CONFUSING)('instances: $name is queried as id $id', async ({ name, id }) => {
    const oap = fakeOap();
    const out = await get(
      registerInstanceRoute,
      oap.fetch,
      `/api/layer/mesh/instances?serviceId=${encodeURIComponent(id)}&service=${encodeURIComponent(name)}`,
    );
    expect(out.reachable).toBe(true);
    expect(out.error).toBeUndefined();
    expect(scopedTo(oap.asked('listInstances')[0], 'root')).toBe(id);
    expect(oap.asked('listServices')).toHaveLength(0);
  });

  it.each(CONFUSING)('endpoints: $name is queried as id $id', async ({ name, id }) => {
    const oap = fakeOap();
    const out = await get(
      registerEndpointRoute,
      oap.fetch,
      `/api/layer/mesh/endpoints?serviceId=${encodeURIComponent(id)}&service=${encodeURIComponent(name)}&q=`,
    );
    expect(out.reachable).toBe(true);
    expect(out.error).toBeUndefined();
    expect(scopedTo(oap.asked('findEndpoint')[0], 'root')).toBe(id);
    expect(oap.asked('listServices')).toHaveLength(0);
  });
});

// The picker feeds refuse rather than answer for a service they cannot address.
// Both refusals are 400s: they are malformed requests, not empty results.
describe('the picker feeds require the identity, not half of it', () => {
  it('instances: a name with no id is refused, and nothing is listed', async () => {
    const oap = fakeOap();
    const { app, sid } = await build(registerInstanceRoute, oap.fetch);
    const res = await app.inject({
      method: 'GET',
      url: `/api/layer/mesh/instances?service=${encodeURIComponent(SERVICE_NAME)}`,
      headers: { cookie: `horizon_sid=${sid}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('incomplete_service');
    expect(oap.asked('listInstances')).toHaveLength(0);
    expect(oap.asked('listServices')).toHaveLength(0);
  });

  it('endpoints: a name with no id is refused, and nothing is searched', async () => {
    const oap = fakeOap();
    const { app, sid } = await build(registerEndpointRoute, oap.fetch);
    const res = await app.inject({
      method: 'GET',
      url: `/api/layer/mesh/endpoints?service=${encodeURIComponent(SERVICE_NAME)}&q=`,
      headers: { cookie: `horizon_sid=${sid}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('incomplete_service');
    expect(oap.asked('findEndpoint')).toHaveLength(0);
  });

  it('neither half filled is still a 400, not an unscoped list', async () => {
    const oap = fakeOap();
    const { app, sid } = await build(registerInstanceRoute, oap.fetch);
    const res = await app.inject({
      method: 'GET',
      url: '/api/layer/mesh/instances',
      headers: { cookie: `horizon_sid=${sid}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'missing_service' });
    expect(oap.asked('listInstances')).toHaveLength(0);
  });
});
