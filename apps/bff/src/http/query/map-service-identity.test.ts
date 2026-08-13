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
 * The graph routes (service map, API dependency, deployment) and the
 * continuous-profiling policy reads take the same service identity every other
 * query route does — id + name, plus the `normal` flag where the OAP API keys
 * on the name — and never match either half against a roster.
 *
 * These routes are where a silent widen is worst: an empty seed is not "no
 * result", it is the WHOLE LAYER's map drawn under one service's title.
 *
 * The layer config comes in as an admin `previewConfig` draft so the tests
 * exercise the identity path without an OAP template store.
 */

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { registerTopologyRoute } from './topology.js';
import { registerEndpointDependencyRoute } from './endpoint-dependency.js';
import { registerDeploymentRoute } from './deployment.js';
import { registerContinuousProfilingRoutes } from './continuous-profiling.js';

const SERVICE_ID = 'c29uZ3M=.1';
const SERVICE_NAME = 'songs';
const PAIR = `serviceId=${encodeURIComponent(SERVICE_ID)}&service=${SERVICE_NAME}`;

const TOPO_PREVIEW = encodeURIComponent(
  JSON.stringify({ nodeMetrics: [{ id: 'cpm', mqe: 'service_cpm' }] }),
);
const EP_PREVIEW = encodeURIComponent(
  JSON.stringify({ nodeMetrics: [{ id: 'cpm', mqe: 'endpoint_cpm' }] }),
);
const DEP_PREVIEW = encodeURIComponent(
  JSON.stringify({ nodeMetrics: [{ id: 'cpm', mqe: 'service_instance_cpm' }] }),
);

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

/** An OAP whose roster is DELIBERATELY confusing: it holds a service whose NAME
 *  is the id under test and whose id is something else. Any surviving
 *  name-or-id matching would seed the wrong entity; carrying the pair cannot. */
function fakeOap(): { fetch: FetchLike; calls: Captured[]; asked: (f: string) => Captured[] } {
  const calls: Captured[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Captured;
    const query = body.query ?? '';
    calls.push({ query, variables: body.variables ?? {} });
    if (query.includes('getTimeInfo')) return json({ data: { time: { timezone: '+0000' } } });
    if (query.includes('listServices')) {
      return json({
        data: {
          services: [
            { id: 'ZGVjb3k=.1', name: SERVICE_ID, normal: true, group: '' },
            { id: SERVICE_ID, name: SERVICE_NAME, normal: true, group: '' },
          ],
        },
      });
    }
    if (query.includes('getServicesTopology')) {
      return json({ data: { topology: { nodes: [], calls: [] } } });
    }
    if (query.includes('findEndpoint')) {
      return json({ data: { endpoints: [{ id: 'ep-1', name: '/api' }] } });
    }
    if (query.includes('getEndpointDependencies')) {
      return json({
        data: {
          topology: {
            nodes: [
              { id: 'ep-1', name: '/api', serviceId: SERVICE_ID, serviceName: SERVICE_NAME, type: null, isReal: true },
            ],
            calls: [],
          },
        },
      });
    }
    if (query.includes('getServiceInstanceTopology')) {
      return json({ data: { topology: { nodes: [], calls: [] } } });
    }
    if (query.includes('listInstances')) return json({ data: { instances: [] } });
    if (query.includes('queryContinuousProfilingServiceTargets')) {
      return json({ data: { targets: [] } });
    }
    if (query.includes('queryPrepareCreateEBPFProfilingTaskData')) {
      return json({ data: { prepare: { couldProfiling: true } } });
    }
    return json({ data: {} });
  };
  return { fetch, calls, asked: (f) => calls.filter((c) => c.query.includes(f)) };
}

function fakeConfig(): ConfigSource {
  const cfg = configSchema.parse({});
  return { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
}

type Register = (
  app: FastifyInstance,
  deps: { config: ConfigSource; sessions: SessionStore; fetch: FetchLike },
) => void;

async function get(register: Register, fetchImpl: FetchLike, url: string) {
  const config = fakeConfig();
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const app = Fastify();
  await app.register(cookie);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
  register(app, { config, sessions, fetch: fetchImpl });
  await app.ready();
  const sid = sessions.create('op', ['admin']).sid;
  const res = await app.inject({ method: 'GET', url, headers: { cookie: `horizon_sid=${sid}` } });
  return { status: res.statusCode, body: res.json() };
}

describe('the service map seeds on the id it was given', () => {
  it('refuses a name with no id instead of drawing the whole layer', async () => {
    const oap = fakeOap();
    const { status, body } = await get(
      registerTopologyRoute,
      oap.fetch,
      `/api/layer/mesh/topology?service=${SERVICE_NAME}&previewConfig=${TOPO_PREVIEW}`,
    );
    expect(status).toBe(400);
    expect(body.error).toBe('incomplete_service');
    expect(oap.asked('getServicesTopology')).toHaveLength(0);
  });

  it('seeds the pair by its id, never by the roster row that shares the string', async () => {
    const oap = fakeOap();
    const { status } = await get(
      registerTopologyRoute,
      oap.fetch,
      `/api/layer/mesh/topology?${PAIR}&previewConfig=${TOPO_PREVIEW}`,
    );
    expect(status).toBe(200);
    expect(oap.asked('getServicesTopology')[0]?.variables.serviceIds).toEqual([SERVICE_ID]);
  });

  // The roster used to have to CONTAIN the seed — an id it had not caught up
  // with was answered "service not found" and no map was drawn at all.
  it('seeds an id the roster snapshot has never seen', async () => {
    const oap = fakeOap();
    const { status, body } = await get(
      registerTopologyRoute,
      oap.fetch,
      `/api/layer/mesh/topology?serviceId=cmVjZW50.1&service=recent&previewConfig=${TOPO_PREVIEW}`,
    );
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    expect(oap.asked('getServicesTopology')[0]?.variables.serviceIds).toEqual(['cmVjZW50.1']);
  });

  it('still seeds the whole layer when no service was asked for', async () => {
    const oap = fakeOap();
    await get(registerTopologyRoute, oap.fetch, `/api/layer/mesh/topology?previewConfig=${TOPO_PREVIEW}`);
    expect(oap.asked('getServicesTopology')[0]?.variables.serviceIds).toEqual(['ZGVjb3k=.1', SERVICE_ID]);
  });
});

describe('API dependency takes the whole roster row', () => {
  const url = (qs: string) => `/api/layer/mesh/endpoint-dependency?${qs}&endpoint=/api&previewConfig=${EP_PREVIEW}`;

  it('refuses a name with no id', async () => {
    const oap = fakeOap();
    const { status, body } = await get(registerEndpointDependencyRoute, oap.fetch, url(`service=${SERVICE_NAME}`));
    expect(status).toBe(400);
    expect(body.error).toBe('incomplete_service');
    expect(oap.asked('getEndpointDependencies')).toHaveLength(0);
  });

  // The endpoint MQE entity is name-scoped and the flag is half of the id it
  // stands for — defaulting it would silently query an entity that is not there.
  it('refuses the pair when the normal flag did not travel with it', async () => {
    const oap = fakeOap();
    const { status, body } = await get(registerEndpointDependencyRoute, oap.fetch, url(PAIR));
    expect(status).toBe(400);
    expect(body.error).toBe('incomplete_service');
    expect(oap.asked('getEndpointDependencies')).toHaveLength(0);
  });

  it('finds the endpoint by the id and builds the entity from the name + flag, with no roster lookup', async () => {
    const oap = fakeOap();
    const { status } = await get(registerEndpointDependencyRoute, oap.fetch, url(`${PAIR}&normal=false`));
    expect(status).toBe(200);
    expect(oap.asked('findEndpoint')[0]?.variables.serviceId).toBe(SERVICE_ID);
    expect(oap.asked('listServices')).toHaveLength(0);
    const metrics = oap.calls.find((c) => c.query.includes('execExpression'));
    expect(metrics?.query).toContain(`serviceName: "${SERVICE_NAME}"`);
    expect(metrics?.query).toContain('normal: false');
  });
});

describe('deployment takes the identity, not a bare handle', () => {
  const url = (qs: string) => `/api/layer/mesh/deployment?${qs}&previewConfig=${DEP_PREVIEW}`;

  it('refuses a name with no id', async () => {
    const oap = fakeOap();
    const { status, body } = await get(registerDeploymentRoute, oap.fetch, url(`service=${SERVICE_NAME}`));
    expect(status).toBe(400);
    expect(body.error).toBe('incomplete_service');
    expect(oap.asked('getServiceInstanceTopology')).toHaveLength(0);
  });

  it('queries the intra-service graph by the id half', async () => {
    const oap = fakeOap();
    const { status } = await get(registerDeploymentRoute, oap.fetch, url(PAIR));
    expect(status).toBe(200);
    const call = oap.asked('getServiceInstanceTopology')[0];
    expect(call?.variables.clientServiceId).toBe(SERVICE_ID);
    expect(call?.variables.serverServiceId).toBe(SERVICE_ID);
  });
});

describe('continuous-profiling policies read by id', () => {
  it('refuses a name with no id', async () => {
    const oap = fakeOap();
    const { body } = await get(
      registerContinuousProfilingRoutes,
      oap.fetch,
      `/api/continuous-profiling/policies?service=${SERVICE_NAME}`,
    );
    expect(String(body.error)).toContain('serviceId');
    expect(oap.asked('queryContinuousProfilingServiceTargets')).toHaveLength(0);
  });

  it('reads the policy of the id half', async () => {
    const oap = fakeOap();
    const { status } = await get(
      registerContinuousProfilingRoutes,
      oap.fetch,
      `/api/continuous-profiling/policies?${PAIR}`,
    );
    expect(status).toBe(200);
    expect(oap.asked('queryContinuousProfilingServiceTargets')[0]?.variables.serviceId).toBe(SERVICE_ID);
  });
});
