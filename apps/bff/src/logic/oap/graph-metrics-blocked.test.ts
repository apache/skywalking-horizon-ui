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
 * A graph draws every service OAP connects to the ones asked about; the
 * metrics of a service the caller may not read are not read. A node keeps its
 * name and says its metrics are blocked, and a call keeps its values when the
 * caller reads either end.
 */

import { describe, expect, it } from 'vitest';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import { buildServiceTopology } from './service-topology.js';
import { buildInstanceTopology } from './instance-topology.js';
import { buildEndpointDependency } from './endpoint-dependency.js';

const id = (name: string, normal = true) => `${Buffer.from(name).toString('base64')}.${normal ? 1 : 0}`;
const child = (serviceId: string, name: string) => `${serviceId}_${Buffer.from(name).toString('base64')}`;

// payments::a (readable) → risk::b → risk::c, and the virtual User → payments::a.
const A = id('payments::a');
const B = id('risk::b');
const C = id('risk::c');
const USER = id('User', false);
const readableOf = async () => new Set([A]);

const node = (nodeId: string, name: string, isReal = true) => ({ id: nodeId, name, type: null, isReal, layers: isReal ? ['GENERAL'] : [] });
const call = (source: string, target: string) => ({ id: `${source}-${target}`, source, target, detectPoints: ['SERVER', 'CLIENT'] });

/** Answers the graph queries with `graphs` and every metric with 5; records
 *  the metric queries it was sent. */
function oap(graphs: Record<string, unknown>) {
  const metricQueries: string[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const { query = '' } = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
    let data: Record<string, unknown> = {};
    if (query.includes('execExpression')) {
      metricQueries.push(query);
      for (const m of query.matchAll(/(\w+): execExpression/g)) data[m[1]!] = { type: 'TIME_SERIES_VALUES', results: [{ values: [{ value: '5' }] }] };
    } else {
      const key = Object.keys(graphs).find((k) => query.includes(k));
      data = key ? (graphs[key] as Record<string, unknown>) : {};
    }
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, metricQueries: () => metricQueries.join('\n') };
}

const base = {
  perf: configSchema.parse({}).performance,
  window: { start: '2026-09-29 1000', end: '2026-09-29 1015', step: 'MINUTE' as const },
  coldStage: false,
};
const opts = (fetch: FetchLike) => ({ queryUrl: 'http://oap:12800', timeoutMs: 5000, fetch });
const metric = { id: 'cpm', label: 'Load', mqe: 'service_cpm' };
const link = { id: 'cpm', label: 'Load', mqe: 'service_relation_server_cpm' };
const linkCli = { id: 'cpm', label: 'Load', mqe: 'service_relation_client_cpm' };

describe('the service map', () => {
  const graph = {
    getServicesTopology: {
      topology: {
        nodes: [node(A, 'payments::a'), node(B, 'risk::b'), node(C, 'risk::c'), node(USER, 'User', false)],
        calls: [call(A, B), call(B, C), call(USER, A)],
      },
    },
    listServices: { services: [] },
  };

  async function build(withCheck: boolean) {
    const o = oap(graph);
    const res = await buildServiceTopology({
      ...base,
      opts: opts(o.fetch),
      cfg: { nodeMetrics: [metric], linkServerMetrics: [link], linkClientMetrics: [linkCli] },
      layerKey: 'GENERAL',
      serviceArg: A,
      depth: 2,
      ...(withCheck ? { readableOf } : {}),
    });
    return { res, queries: o.metricQueries() };
  }

  it('draws every connected service, and reads no metric of one the caller may not read', async () => {
    const { res, queries } = await build(true);
    expect(res.nodes.map((n) => n.name).sort()).toEqual(['User', 'payments::a', 'risk::b', 'risk::c']);
    const b = res.nodes.find((n) => n.id === B)!;
    expect(b.metricsBlocked).toBe(true);
    expect(b.metrics).toEqual({ cpm: null });
    expect(res.nodes.find((n) => n.id === A)).toMatchObject({ metrics: { cpm: 5 } });
    expect(res.nodes.find((n) => n.id === A)!.metricsBlocked).toBeUndefined();
    // A virtual service has no metrics of its own to block.
    expect(res.nodes.find((n) => n.id === USER)!.metricsBlocked).toBeUndefined();
    expect(queries).not.toMatch(/scope: Service, serviceName: "risk::/);
  });

  it('keeps both sides of a call the caller reads one end of, and none of one it reads neither end of', async () => {
    const { res } = await build(true);
    const ab = res.calls.find((c) => c.id === `${A}-${B}`)!;
    expect(ab.metricsBlocked).toBeUndefined();
    expect(ab).toMatchObject({ serverMetrics: { cpm: 5 }, clientMetrics: { cpm: 5 } });
    const bc = res.calls.find((c) => c.id === `${B}-${C}`)!;
    expect(bc.metricsBlocked).toBe(true);
    expect(bc).toMatchObject({ serverMetrics: { cpm: null }, clientMetrics: { cpm: null } });
    expect(res.calls.find((c) => c.id === `${USER}-${A}`)).toMatchObject({ serverMetrics: { cpm: 5 } });
  });

  it('reads every value for a caller who may read every service', async () => {
    const { res } = await build(false);
    expect(res.nodes.find((n) => n.id === B)).toMatchObject({ metrics: { cpm: 5 } });
    expect(res.calls.find((c) => c.id === `${B}-${C}`)).toMatchObject({ serverMetrics: { cpm: 5 } });
    expect(res.nodes.some((n) => n.metricsBlocked) || res.calls.some((c) => c.metricsBlocked)).toBe(false);
  });
});

describe('the instance map', () => {
  const a1 = child(A, 'a-1');
  const b1 = child(B, 'b-1');
  const graph = {
    getServiceInstanceTopology: {
      topology: {
        nodes: [
          { id: a1, name: 'a-1', serviceId: A, serviceName: 'payments::a', isReal: true },
          { id: b1, name: 'b-1', serviceId: B, serviceName: 'risk::b', isReal: true },
        ],
        calls: [call(b1, a1)],
      },
    },
    listServices: { services: [] },
  };

  it('draws the other service\'s instances without their metrics, and keeps the calls between them', async () => {
    const o = oap(graph);
    const res = await buildInstanceTopology({
      ...base,
      opts: opts(o.fetch),
      cfg: { nodeMetrics: [{ id: 'cpm', label: 'Load', mqe: 'service_instance_cpm' }], linkServerMetrics: [link], linkClientMetrics: [] },
      layerKey: 'GENERAL',
      clientServiceId: B,
      serverServiceId: A,
      readableOf,
    });
    expect(res.nodes.find((n) => n.id === b1)).toMatchObject({ metricsBlocked: true, metrics: { cpm: null } });
    expect(res.nodes.find((n) => n.id === a1)).toMatchObject({ metrics: { cpm: 5 } });
    expect(res.calls[0]).toMatchObject({ serverMetrics: { cpm: 5 } });
    expect(o.metricQueries()).not.toMatch(/scope: ServiceInstance, serviceName: "risk::b"/);
  });
});

describe('the API dependency graph', () => {
  const pay = child(A, 'POST:/pay');
  const score = child(B, 'POST:/score');
  const graph = {
    findEndpoint: { endpoints: [{ id: pay, name: 'POST:/pay' }] },
    getEndpointDependencies: {
      topology: {
        nodes: [
          { id: pay, name: 'POST:/pay', serviceId: A, serviceName: 'payments::a', type: null, isReal: true },
          { id: score, name: 'POST:/score', serviceId: B, serviceName: 'risk::b', type: null, isReal: true },
        ],
        calls: [call(score, pay)],
      },
    },
  };

  it('keeps an endpoint of a service the caller may not read, marked, instead of dropping it for having no values', async () => {
    const o = oap(graph);
    const res = await buildEndpointDependency({
      ...base,
      opts: opts(o.fetch),
      cfg: { nodeMetrics: [{ id: 'cpm', label: 'Load', mqe: 'endpoint_cpm' }], linkMetrics: [{ id: 'cpm', label: 'Load', mqe: 'endpoint_relation_cpm' }] },
      layerKey: 'GENERAL',
      service: { id: A, name: 'payments::a', normal: true },
      endpointArg: 'POST:/pay',
      readableOf,
    });
    expect(res.nodes.find((n) => n.id === score)).toMatchObject({ metricsBlocked: true, metrics: { cpm: null } });
    expect(res.nodes.find((n) => n.id === pay)).toMatchObject({ metrics: { cpm: 5 } });
    expect(res.calls[0]).toMatchObject({ metrics: { cpm: 5 } });
    expect(o.metricQueries()).not.toMatch(/scope: Endpoint,\s*serviceName: "risk::b"/);
  });
});
