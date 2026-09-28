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
 * The deployment view names its service in every metric it runs. A service the
 * URL layer's roster does not hold must still be named — an empty name reads as
 * no service at all, and a `top_n` then ranks every service.
 */

import { describe, expect, it } from 'vitest';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { GraphqlOptions } from '../../client/graphql.js';
import { buildDeployment } from './deployment.js';

const SERVICE_ID = `${Buffer.from('payments::a').toString('base64')}.1`;
const INSTANCE_ID = `${SERVICE_ID}_${Buffer.from('pod-1').toString('base64')}`;

function oap(service: { id: string; name: string; normal: boolean } | null): { opts: GraphqlOptions; queries: string[] } {
  const queries: string[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const { query } = JSON.parse(String(init?.body ?? '{}')) as { query: string };
    queries.push(query);
    const data = query.includes('listServices')
      ? { services: [] }
      : query.includes('getServiceInstanceTopology')
        ? { topology: { nodes: [], calls: [] } }
        : query.includes('getService(')
          ? { service }
          : query.includes('listInstances')
            ? { instances: [{ id: INSTANCE_ID, name: 'pod-1', attributes: [] }] }
            : {};
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { opts: { queryUrl: 'http://oap:12800', timeoutMs: 5000, fetch }, queries };
}

const input = (opts: GraphqlOptions) => ({
  opts,
  perf: configSchema.parse({}).performance,
  window: { start: '2026-09-28 1000', end: '2026-09-28 1015', step: 'MINUTE' as const },
  coldStage: false,
  cfg: { nodeMetrics: [{ id: 'cpm', label: 'Load', mqe: 'top_n(service_instance_cpm,5,des)' }] },
  layerKey: 'banyandb',
  serviceId: SERVICE_ID,
});

describe('a deployment for a service outside the URL layer\'s roster', () => {
  it('names the service OAP returns for its id in every metric', async () => {
    const { opts, queries } = oap({ id: SERVICE_ID, name: 'payments::a', normal: true });
    const out = await buildDeployment(input(opts));
    expect(out.serviceName).toBe('payments::a');
    const metrics = queries.filter((q) => q.includes('execExpression'));
    expect(metrics.length).toBeGreaterThan(0);
    for (const q of metrics) expect(q).toContain('serviceName: "payments::a"');
  });

  it('runs no metric for a service OAP does not know', async () => {
    const { opts, queries } = oap(null);
    const out = await buildDeployment(input(opts));
    expect(out.error).toMatch(/Unknown service/);
    expect(queries.some((q) => q.includes('execExpression'))).toBe(false);
  });
});
