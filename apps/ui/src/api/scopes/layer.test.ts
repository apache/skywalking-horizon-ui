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

import { describe, it, expect, vi } from 'vitest';
import { LayerApi } from './layer';
import type { BffClient } from '../client';

/**
 * Sub-client URL / body construction is what makes the entity round-
 * trip work. A wrong encoding (raw `::` not escaped) or a stale URL
 * shape silently sends the request to the wrong service / no service.
 * Mock the BffClient.request and assert the exact call shape.
 */
function makeStub(): { bff: BffClient; calls: Array<[string, string, unknown?]> } {
  const calls: Array<[string, string, unknown?]> = [];
  const bff = {
    request: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return {} as unknown;
    }),
  } as unknown as BffClient;
  return { bff, calls };
}

describe('LayerApi.landing', () => {
  it('POSTs to /api/layer/<key>/landing and forwards cfg + range', async () => {
    const { bff, calls } = makeStub();
    const api = new LayerApi(bff);
    await api.landing(
      'mesh',
      {
        priority: 1,
        topN: 5,
        orderBy: 'cpm',
        columns: [{ metric: 'cpm', label: 'CPM', mqe: 'service_cpm', aggregation: 'sum' }],
      },
      { step: 'MINUTE', startMs: 1, endMs: 2 },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('POST');
    expect(calls[0][1]).toBe('/api/layer/mesh/landing');
    expect(calls[0][2]).toMatchObject({
      topN: 5,
      orderBy: 'cpm',
      columns: [{ metric: 'cpm', label: 'CPM', mqe: 'service_cpm', aggregation: 'sum' }],
      step: 'MINUTE',
      startMs: 1,
      endMs: 2,
    });
  });

  it('omits range fields when no range arg passed', async () => {
    const { bff, calls } = makeStub();
    await new LayerApi(bff).landing('general', {
      priority: 1,
      topN: 5,
      orderBy: 'cpm',
      columns: [],
    });
    const body = calls[0][2] as Record<string, unknown>;
    expect(body.step).toBeUndefined();
    expect(body.startMs).toBeUndefined();
    expect(body.endMs).toBeUndefined();
  });

  it('encodes layer keys with reserved chars', async () => {
    const { bff, calls } = makeStub();
    await new LayerApi(bff).landing('aws_eks', {
      priority: 1,
      topN: 5,
      orderBy: 'cpm',
      columns: [],
    });
    expect(calls[0][1]).toBe('/api/layer/aws_eks/landing');
  });
});

describe('LayerApi.dashboard', () => {
  it('POSTs /api/layer/<key>/dashboard with the entity body verbatim', async () => {
    const { bff, calls } = makeStub();
    await new LayerApi(bff).dashboard('mesh', {
      service: 'mesh-svr::reviews',
      serviceInstance: 'reviews-pod-1',
      endpoint: '/api/orders',
      scope: 'endpoint',
    });
    expect(calls[0]).toEqual([
      'POST',
      '/api/layer/mesh/dashboard',
      {
        service: 'mesh-svr::reviews',
        serviceInstance: 'reviews-pod-1',
        endpoint: '/api/orders',
        scope: 'endpoint',
      },
    ]);
  });

  it('appends ?mockTop=N when mockTop opt is set; not otherwise', async () => {
    const { bff, calls } = makeStub();
    const api = new LayerApi(bff);
    await api.dashboard('general', {}, { mockTop: 20 });
    await api.dashboard('general', {});
    expect(calls[0][1]).toBe('/api/layer/general/dashboard?mockTop=20');
    expect(calls[1][1]).toBe('/api/layer/general/dashboard');
  });

  it('does NOT add mockTop when value is 0 or negative', async () => {
    const { bff, calls } = makeStub();
    const api = new LayerApi(bff);
    await api.dashboard('g', {}, { mockTop: 0 });
    await api.dashboard('g', {}, { mockTop: -5 });
    expect(calls[0][1]).toBe('/api/layer/g/dashboard');
    expect(calls[1][1]).toBe('/api/layer/g/dashboard');
  });
});

describe('LayerApi.dashboard — chunking oversize widget sets', () => {
  const widgetStub = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `w${i}`,
      title: `W${i}`,
      type: 'card' as const,
      expressions: [`m${i}`],
    }));
  function respStub() {
    const calls: Array<{ widgets: { id: string }[] }> = [];
    const bff = {
      request: vi.fn(async (_m: string, _p: string, body?: { widgets?: { id: string }[] }) => {
        const ws = body?.widgets ?? [];
        calls.push({ widgets: ws });
        return {
          layer: 'g', service: 's', generatedAt: 0, step: 'MINUTE',
          durationStart: '', durationEnd: '', reachable: true,
          widgets: ws.map((w) => ({ id: w.id })),
        } as unknown;
      }),
    } as unknown as BffClient;
    return { bff, calls };
  }

  it('sends a single request at exactly the cap (40)', async () => {
    const { bff, calls } = respStub();
    await new LayerApi(bff).dashboard('g', { widgets: widgetStub(40) });
    expect(calls).toHaveLength(1);
  });

  it('splits >40 into ceil(n/40) chunks of ≤40 and merges widgets in order', async () => {
    const { bff, calls } = respStub();
    const resp = await new LayerApi(bff).dashboard('g', { widgets: widgetStub(95) });
    expect(calls.map((c) => c.widgets.length)).toEqual([40, 40, 15]);
    expect(resp.widgets.map((w) => w.id)).toEqual(widgetStub(95).map((w) => w.id));
  });

  it('AND-folds reachable and surfaces the first chunk error', async () => {
    let n = 0;
    const bff = {
      request: vi.fn(async (_m: string, _p: string, body?: { widgets?: { id: string }[] }) => {
        const bad = n++ === 1;
        return {
          layer: 'g', service: 's', generatedAt: 0, step: 'MINUTE', durationStart: '', durationEnd: '',
          widgets: (body?.widgets ?? []).map((w) => ({ id: w.id })),
          reachable: !bad, ...(bad ? { error: 'chunk-1-failed' } : {}),
        } as unknown;
      }),
    } as unknown as BffClient;
    const resp = await new LayerApi(bff).dashboard('g', { widgets: widgetStub(85) });
    expect(resp.reachable).toBe(false);
    expect(resp.error).toBe('chunk-1-failed');
  });
});

describe('LayerApi.dashboardConfig', () => {
  it('GETs without query when scope omitted', async () => {
    const { bff, calls } = makeStub();
    await new LayerApi(bff).dashboardConfig('mesh');
    expect(calls[0]).toEqual(['GET', '/api/layer/mesh/dashboard/config', undefined]);
  });

  it('GETs with ?scope=<scope> when scope provided and URL-encodes', async () => {
    const { bff, calls } = makeStub();
    await new LayerApi(bff).dashboardConfig('mesh', 'instance');
    expect(calls[0][1]).toBe('/api/layer/mesh/dashboard/config?scope=instance');
  });
});

describe('LayerApi.endpoints / instances — entity query params', () => {
  it('endpoints encodes service / q / limit', async () => {
    const { bff, calls } = makeStub();
    await new LayerApi(bff).endpoints('mesh', 'mesh-svr::reviews', '/api/', 50);
    // URLSearchParams encodes `::` as %3A%3A
    expect(calls[0][1]).toBe(
      '/api/layer/mesh/endpoints?service=mesh-svr%3A%3Areviews&q=%2Fapi%2F&limit=50',
    );
  });

  it('endpoints defaults limit to 20', async () => {
    const { bff, calls } = makeStub();
    await new LayerApi(bff).endpoints('mesh', 'svc', '');
    expect(calls[0][1]).toBe('/api/layer/mesh/endpoints?service=svc&q=&limit=20');
  });

  it('instances encodes the service param', async () => {
    const { bff, calls } = makeStub();
    await new LayerApi(bff).instances('mesh_dp', 'mesh-svr::app.sample-services');
    expect(calls[0][1]).toBe(
      '/api/layer/mesh_dp/instances?service=mesh-svr%3A%3Aapp.sample-services',
    );
  });
});

describe('LayerApi.topology / endpointDependency', () => {
  it('topology defaults depth=1, omits service param when undefined', async () => {
    const { bff, calls } = makeStub();
    await new LayerApi(bff).topology('mesh');
    expect(calls[0][1]).toBe('/api/layer/mesh/topology?depth=1');
  });

  it('topology forwards service + depth when provided', async () => {
    const { bff, calls } = makeStub();
    await new LayerApi(bff).topology('mesh', 'mesh-svr::reviews', 3);
    expect(calls[0][1]).toBe(
      '/api/layer/mesh/topology?service=mesh-svr%3A%3Areviews&depth=3',
    );
  });

  it('endpointDependency requires + encodes service + endpoint', async () => {
    const { bff, calls } = makeStub();
    await new LayerApi(bff).endpointDependency('general', 'frontend', '/api/order');
    expect(calls[0][1]).toBe(
      '/api/layer/general/endpoint-dependency?service=frontend&endpoint=%2Fapi%2Forder',
    );
  });
});
