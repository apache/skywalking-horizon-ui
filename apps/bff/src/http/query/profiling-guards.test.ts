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
 * The profiling routes' refusal contract: a value we cannot honour is REFUSED,
 * never repaired, and a backend we could not reach is reported as unreachable,
 * never as "nothing found". Both are answers an operator acts on, and a
 * silently-substituted one is worse than an error.
 */

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { registerEBPFRoutes } from './ebpf.js';
import { registerAsyncProfileRoutes } from './async-profile.js';
import { registerContinuousProfilingRoutes } from './continuous-profiling.js';

function fakeConfig(): ConfigSource {
  const cfg = configSchema.parse({});
  return { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
}

const gql = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

async function build(
  register: (app: FastifyInstance, deps: { config: ConfigSource; sessions: SessionStore; fetch: FetchLike }) => void,
  fetchImpl: FetchLike,
): Promise<{ app: FastifyInstance; sid: string }> {
  const config = fakeConfig();
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const app = Fastify();
  await app.register(cookie);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
  register(app, { config, sessions, fetch: fetchImpl });
  await app.ready();
  return { app, sid: sessions.create('op', ['admin']).sid };
}

/** Which trigger type a captured GraphQL body asked for. */
function triggerOf(init: RequestInit | undefined): string {
  return JSON.parse(String(init?.body ?? '{}')).variables?.triggerType ?? '';
}

const SERVICE = 'bWVzaA==.1';

describe('eBPF task reads never turn a failure into "no tasks"', () => {
  it('reports unreachable when BOTH trigger-type queries fail', async () => {
    const { app, sid } = await build(registerEBPFRoutes, async () => new Response('boom', { status: 500 }));
    const res = await app.inject({
      method: 'GET',
      url: `/api/layer/mesh/ebpf/tasks?service=${encodeURIComponent(SERVICE)}`,
      headers: { cookie: `horizon_sid=${sid}` },
    });
    const body = res.json();
    expect(body.reachable).toBe(false);
    expect(body.error).toBeTruthy();
    expect(body.tasks ?? []).toHaveLength(0);
  });

  it('reports unreachable when only the CONTINUOUS_PROFILING half fails', async () => {
    // The dangerous case: half the answer is real, so a swallowed error yields a
    // plausible-looking list that is quietly missing every policy-started task.
    const fetchImpl: FetchLike = async (url, init) => {
      const u = String(url);
      if (u.includes('graphql') && triggerOf(init) === 'CONTINUOUS_PROFILING') {
        return new Response('boom', { status: 500 });
      }
      if (u.includes('graphql') && triggerOf(init) === 'FIXED_TIME') {
        return gql({ data: { queryEBPFTasks: [{ taskId: 'fixed-1', taskStartTime: 2 }] } });
      }
      return gql({ data: { services: [{ id: SERVICE, name: 'mesh', normal: true }], createTaskData: {} } });
    };
    const { app, sid } = await build(registerEBPFRoutes, fetchImpl);
    const res = await app.inject({
      method: 'GET',
      url: `/api/layer/mesh/ebpf/tasks?service=${encodeURIComponent(SERVICE)}`,
      headers: { cookie: `horizon_sid=${sid}` },
    });
    const body = res.json();
    expect(body.reachable).toBe(false);
    expect(body.tasks ?? []).toHaveLength(0);
  });

  it('merges both trigger types newest-first when both answer', async () => {
    const fetchImpl: FetchLike = async (url, init) => {
      const u = String(url);
      if (!u.includes('graphql')) return gql({ data: {} });
      const trig = triggerOf(init);
      if (trig === 'FIXED_TIME') {
        return gql({ data: { queryEBPFTasks: [{ taskId: 'fixed', taskStartTime: 100 }] } });
      }
      if (trig === 'CONTINUOUS_PROFILING') {
        return gql({ data: { queryEBPFTasks: [{ taskId: 'cont', taskStartTime: 300 }] } });
      }
      return gql({ data: { services: [{ id: SERVICE, name: 'mesh', normal: true }], createTaskData: {} } });
    };
    const { app, sid } = await build(registerEBPFRoutes, fetchImpl);
    const res = await app.inject({
      method: 'GET',
      url: `/api/layer/mesh/ebpf/tasks?service=${encodeURIComponent(SERVICE)}`,
      headers: { cookie: `horizon_sid=${sid}` },
    });
    const body = res.json();
    expect(body.reachable).toBe(true);
    expect(body.tasks.map((t: { taskId: string }) => t.taskId)).toEqual(['cont', 'fixed']);
  });
});

describe('pprof dumpPeriod is refused, never defaulted', () => {
  const post = async (dumpPeriod: unknown) => {
    const { app, sid } = await build(registerAsyncProfileRoutes, async () => gql({ data: { task: { id: 'x' } } }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/layer/mesh/pprof/tasks',
      headers: { cookie: `horizon_sid=${sid}`, 'content-type': 'application/json' },
      payload: { serviceId: SERVICE, serviceInstanceIds: ['i-1'], events: 'BLOCK', duration: 5, dumpPeriod },
    });
    return res.json();
  };

  // dumpPeriod is a sampling RATE: lower means MORE samples, so substituting 1
  // for a bad value would turn a rejected request into the most expensive
  // profile the agent can produce.
  it.each([0, -5, 1.5, Number.NaN, 'fast', null])('refuses %p', async (bad) => {
    expect(await post(bad)).toMatchObject({ errorReason: expect.stringContaining('dumpPeriod') });
  });

  it('forwards a valid rate untouched', async () => {
    const out = await post(1_000_000);
    expect(out.errorReason).toBeUndefined();
    expect(out.id).toBe('x');
  });
});

describe('continuous-profiling policy period/count are whole numbers', () => {
  const save = async (item: Record<string, unknown>) => {
    const { app, sid } = await build(registerContinuousProfilingRoutes, async () =>
      gql({ data: { result: { status: true } } }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/continuous-profiling/policies',
      headers: { cookie: `horizon_sid=${sid}`, 'content-type': 'application/json' },
      payload: {
        serviceId: SERVICE,
        targets: [{ type: 'ON_CPU', checkItems: [{ type: 'PROCESS_CPU', threshold: '75', period: 60, count: 3, ...item }] }],
      },
    });
    return res.json();
  };

  it('refuses a fractional period instead of rounding it', async () => {
    // count deliberately 1, so the failure can only come from `period` itself
    // and not from the count-must-not-exceed-period rule.
    expect(await save({ period: 1.5, count: 1 })).toMatchObject({
      errorReason: expect.stringContaining('period must be a whole number'),
    });
  });

  it('refuses a fractional count instead of rounding it', async () => {
    expect(await save({ count: 2.4 })).toMatchObject({
      errorReason: expect.stringContaining('count must be a whole number'),
    });
  });

  it.each([0, -1, Number.NaN, 'sixty'])('refuses period %p', async (bad) => {
    expect(await save({ period: bad, count: 1 })).toMatchObject({
      errorReason: expect.stringContaining('period must be a whole number'),
    });
  });

  it('refuses a count larger than the period, as OAP does', async () => {
    expect(await save({ period: 10, count: 20 })).toMatchObject({
      errorReason: expect.stringContaining('count'),
    });
  });

  it('accepts whole numbers and sends them unchanged', async () => {
    expect(await save({ period: 120, count: 2 })).toMatchObject({ status: true });
  });
});

describe('continuous-profiling thresholds are validated at the API boundary', () => {
  // The UI checks the same rule at the field, but the route is the boundary and
  // must not depend on it. All five mirror OAP's validatePolicyItem.
  const save = async (item: Record<string, unknown>) => {
    const { app, sid } = await build(registerContinuousProfilingRoutes, async () =>
      gql({ data: { result: { status: true } } }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/continuous-profiling/policies',
      headers: { cookie: `horizon_sid=${sid}`, 'content-type': 'application/json' },
      payload: {
        serviceId: SERVICE,
        targets: [{ type: 'ON_CPU', checkItems: [{ type: 'PROCESS_CPU', threshold: '75', period: 60, count: 3, ...item }] }],
      },
    });
    return res.json();
  };

  it.each(['4.5', '0.5', '1e2', '75%', 'high', '', '  '])('refuses a non-integer threshold %p', async (bad) => {
    expect(await save({ threshold: bad })).toMatchObject({ errorReason: expect.stringContaining('threshold') });
  });

  it('refuses a threshold of 0', async () => {
    expect(await save({ threshold: '0' })).toMatchObject({
      errorReason: expect.stringContaining('greater than 0'),
    });
  });

  it('refuses a negative threshold (the sign fails the whole-number check first)', async () => {
    expect(await save({ threshold: '-1' })).toMatchObject({
      errorReason: expect.stringContaining('whole number'),
    });
  });

  it('refuses a PROCESS_CPU percentage above 100, as OAP does', async () => {
    expect(await save({ threshold: '101' })).toMatchObject({ errorReason: expect.stringContaining('1..100') });
  });

  it('refuses an HTTP_ERROR_RATE above 100', async () => {
    expect(await save({ type: 'HTTP_ERROR_RATE', threshold: '150' })).toMatchObject({
      errorReason: expect.stringContaining('1..100'),
    });
  });

  it('accepts a large value where OAP sets no ceiling', async () => {
    expect(await save({ type: 'HTTP_AVG_RESPONSE_TIME', threshold: '5000' })).toMatchObject({ status: true });
  });

  it('accepts the percentage boundary', async () => {
    expect(await save({ threshold: '100' })).toMatchObject({ status: true });
  });
});

describe('profiling task durations are refused, never rounded', () => {
  it('refuses a fractional async duration instead of forwarding a shorter or zero task', async () => {
    const { app, sid } = await build(registerAsyncProfileRoutes, async () => gql({ data: { task: { id: 'x' } } }));
    // 0.4 rounding to 0 previously forwarded a ZERO-second task as if it were valid.
    const res = await app.inject({
      method: 'POST',
      url: '/api/layer/mesh/async/tasks',
      headers: { cookie: `horizon_sid=${sid}`, 'content-type': 'application/json' },
      payload: { serviceId: SERVICE, serviceInstanceIds: ['i-1'], duration: 0.4 },
    });
    expect(res.json()).toMatchObject({ errorReason: expect.stringContaining('duration') });
  });

  it('refuses a fractional pprof duration', async () => {
    const { app, sid } = await build(registerAsyncProfileRoutes, async () => gql({ data: { task: { id: 'x' } } }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/layer/mesh/pprof/tasks',
      headers: { cookie: `horizon_sid=${sid}`, 'content-type': 'application/json' },
      payload: { serviceId: SERVICE, serviceInstanceIds: ['i-1'], events: 'CPU', duration: 1.6 },
    });
    expect(res.json()).toMatchObject({ errorReason: expect.stringContaining('duration') });
  });

  it('refuses a fractional eBPF duration', async () => {
    const { app, sid } = await build(registerEBPFRoutes, async () => gql({ data: { task: { id: 'x' } } }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/layer/mesh/ebpf/tasks',
      headers: { cookie: `horizon_sid=${sid}`, 'content-type': 'application/json' },
      payload: { serviceId: SERVICE, targetType: 'ON_CPU', processLabels: ['x'], duration: 65.5 },
    });
    expect(res.json()).toMatchObject({ errorReason: expect.stringContaining('duration') });
  });

  it('accepts a whole-number async duration unchanged', async () => {
    const { app, sid } = await build(registerAsyncProfileRoutes, async () => gql({ data: { task: { id: 'x' } } }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/layer/mesh/async/tasks',
      headers: { cookie: `horizon_sid=${sid}`, 'content-type': 'application/json' },
      payload: { serviceId: SERVICE, serviceInstanceIds: ['i-1'], duration: 60 },
    });
    expect(res.json()).toMatchObject({ id: 'x' });
  });
});

describe('pprof duration stays genuinely optional for point-in-time events', () => {
  it('accepts an omitted duration (HEAP / GOROUTINE / ALLOCS / THREADCREATE carry none)', async () => {
    const { app, sid } = await build(registerAsyncProfileRoutes, async () => gql({ data: { task: { id: 'x' } } }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/layer/mesh/pprof/tasks',
      headers: { cookie: `horizon_sid=${sid}`, 'content-type': 'application/json' },
      payload: { serviceId: SERVICE, serviceInstanceIds: ['i-1'], events: 'HEAP' },
    });
    expect(res.json()).toMatchObject({ id: 'x' });
  });
});
