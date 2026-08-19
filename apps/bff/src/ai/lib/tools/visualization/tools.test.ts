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

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted above const declarations, so the factories must be
// self-contained; the mocked fns are pulled back in via import + cast below.
vi.mock('../../../../logic/dashboard/run.js', () => ({ runWidgets: vi.fn() }));
vi.mock('../../../../logic/oap/hierarchy.js', () => ({ getServiceHierarchy: vi.fn() }));
// The map tools now call the shared logic/oap builders (the same fan-out the
// layer routes use) and attach the response as spec.replayData.
vi.mock('../../../../logic/oap/service-topology.js', () => ({ buildServiceTopology: vi.fn() }));
vi.mock('../../../../logic/oap/instance-topology.js', () => ({ buildInstanceTopology: vi.fn() }));
vi.mock('../../../../logic/oap/deployment.js', () => ({ buildDeployment: vi.fn() }));
vi.mock('../../../../logic/oap/endpoint-dependency.js', () => ({ buildEndpointDependency: vi.fn() }));
vi.mock('../../../../logic/layers/effective.js', () => ({ resolveEffectiveLayer: vi.fn() }));
// Only the map CONFIG resolvers are stubbed. The widget resolvers stay
// REAL so `show_widget`'s lookup runs the same whole-scope enumeration
// production does — stubbing it would prove the stub, not the resolution.
vi.mock('../../../../logic/layers/loader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../logic/layers/loader.js')>()),
  topologyConfigFor: vi.fn(() => ({ nodeMetrics: [], linkServerMetrics: [], linkClientMetrics: [] })),
  deploymentConfigFor: vi.fn(() => null),
  instanceTopologyConfigFor: vi.fn(() => ({ nodeMetrics: [], linkServerMetrics: [], linkClientMetrics: [] })),
  endpointDependencyConfigFor: vi.fn(() => ({ nodeMetrics: [], linkMetrics: [] })),
}));
// Catalog resolves the service row (id + normal) used to build the entity.
vi.mock('../../../../logic/services/service-layer-catalog.js', () => ({
  serviceLayerCatalog: () => ({
    get: () =>
      Promise.resolve({
        byLayer: new Map([
          [
            'GENERAL',
            [
              { name: 'agent::songs', id: 'svc-1', normal: true },
              { name: 'agent::gateway', id: 'svc-2', normal: true },
            ],
          ],
        ]),
      }),
  }),
}));

import { visualizationTools } from './tools.js';
import { runWidgets } from '../../../../logic/dashboard/run.js';
import { getServiceHierarchy } from '../../../../logic/oap/hierarchy.js';
import { buildServiceTopology } from '../../../../logic/oap/service-topology.js';
import { buildInstanceTopology } from '../../../../logic/oap/instance-topology.js';
import { resolveEffectiveLayer } from '../../../../logic/layers/effective.js';
import type { ToolContext } from '../../tool-context.js';
import type { StructuredToolInterface } from '@langchain/core/tools';

const runWidgetsMock = runWidgets as unknown as ReturnType<typeof vi.fn>;
const getHierarchy = getServiceHierarchy as unknown as ReturnType<typeof vi.fn>;
const buildTopo = buildServiceTopology as unknown as ReturnType<typeof vi.fn>;
const buildInstTopo = buildInstanceTopology as unknown as ReturnType<typeof vi.fn>;
const resolveEff = resolveEffectiveLayer as unknown as ReturnType<typeof vi.fn>;

function mockCtx(hasVerb = true) {
  const emitFigure = vi.fn();
  const emitHierarchy = vi.fn();
  const emitTopology = vi.fn();
  const emitInstanceTopology = vi.fn();
  const emitDeployment = vi.fn();
  const emitEndpointDependency = vi.fn();
  const ctx = {
    hasVerb: () => hasVerb,
    emitFigure,
    emitHierarchy,
    emitTopology,
    emitInstanceTopology,
    emitDeployment,
    emitEndpointDependency,
    opts: {},
    config: { current: { performance: {} } },
    uiTemplateClient: () => ({}),
    fetch: undefined,
    window: {},
    range: { startMs: 0, endMs: 600_000, step: 'MINUTE' },
    bulkSize: 5,
  } as unknown as ToolContext;
  return { ctx, emitFigure, emitHierarchy, emitTopology, emitInstanceTopology, emitDeployment, emitEndpointDependency };
}
function byName(ctx: ToolContext): Record<string, StructuredToolInterface> {
  const map: Record<string, StructuredToolInterface> = {};
  for (const tl of visualizationTools(ctx)) map[tl.name] = tl;
  return map;
}
const base = { title: 'T', layer: 'GENERAL', service: 'agent::songs' };

/** A widget an operator added on an EXTENSION page only — absent from
 *  `dashboards.service`, so it is reachable solely through the whole-scope
 *  enumeration `show_widget` performs. */
const extPageTemplate = {
  key: 'GENERAL',
  dashboards: { service: [{ id: 'service_load', type: 'line', title: 'Load', expressions: ['service_cpm'] }] },
  dashboardExtPages: {
    service: [
      {
        id: 'runtime',
        name: 'Runtime',
        widgets: [
          {
            id: 'jvm_heap',
            type: 'line',
            title: 'JVM heap',
            expressions: ['instance_jvm_memory_heap'],
            unit: 'MB',
            tip: 'Heap after the last GC',
          },
        ],
      },
    ],
  },
};

beforeEach(() => {
  runWidgetsMock.mockReset();
  getHierarchy.mockReset();
  buildTopo.mockReset();
  buildInstTopo.mockReset();
  resolveEff.mockReset();
  // Default: template store reachable, layer resolves to an (empty) template.
  resolveEff.mockResolvedValue({ blocked: false, template: {} });
});

describe('visualization render tools', () => {
  it('denies without metrics:read and never runs a widget', async () => {
    const out = String(await byName(mockCtx(false).ctx).show_figure.invoke({ ...base, type: 'line', expressions: ['x'] }));
    expect(out).toMatch(/permission|metrics:read/i);
    expect(runWidgetsMock).not.toHaveBeenCalled();
  });

  it('rejects the impossible instance×endpoint scope before touching OAP', async () => {
    const out = String(
      await byName(mockCtx().ctx).show_figure.invoke({ ...base, type: 'line', expressions: ['x'], instance: 'i', endpoint: 'e' }),
    );
    expect(out).toMatch(/invalid scope/i);
    expect(runWidgetsMock).not.toHaveBeenCalled();
  });

  it('summarizes a card as a scalar and a line as a series', async () => {
    const tools = byName(mockCtx().ctx);
    runWidgetsMock.mockResolvedValueOnce({ widgets: [{ id: 'ai_fig', value: 42 }] });
    expect(String(await tools.show_figure.invoke({ ...base, type: 'card', expressions: ['latest(x)'] }))).toContain('value ≈ 42');
    runWidgetsMock.mockResolvedValueOnce({ widgets: [{ id: 'ai_fig', series: [{ data: [1, 2, 3] }] }] });
    const lineOut = String(await tools.show_figure.invoke({ ...base, type: 'line', expressions: ['x'] }));
    expect(lineOut).toContain('1 series');
    expect(lineOut).toContain('3 points');
    expect(lineOut).toContain('last ≈ 3');
  });

  it('show_hierarchy orders layers request-near first (level DESC) and keeps the focus', async () => {
    getHierarchy.mockResolvedValue({
      reachable: true,
      error: null,
      levels: [
        { layer: 'GENERAL', level: 5 },
        { layer: 'K8S_SERVICE', level: 1 },
      ],
      // Returned infra-first; the tool must re-order to request-near first.
      peers: [
        { layer: 'K8S_SERVICE', services: [{ id: 'k1', name: 'songs.default', normal: true, role: 'upper' }] },
        { layer: 'GENERAL', services: [{ id: 'svc-1', name: 'agent::songs', normal: true, role: 'self' }] },
      ],
    });
    const { ctx, emitHierarchy } = mockCtx();
    await byName(ctx).show_hierarchy.invoke({ layer: 'GENERAL', service: 'agent::songs' });
    expect(getHierarchy).toHaveBeenCalledWith(expect.anything(), 'svc-1', 'GENERAL', undefined);
    const spec = emitHierarchy.mock.calls[0][0] as {
      groups: Array<{ layer: string; peers: Array<{ role: string }> }>;
      replayData?: unknown;
    };
    expect(spec.groups.map((g) => g.layer)).toEqual(['GENERAL', 'K8S_SERVICE']);
    expect(spec.groups[0].peers[0].role).toBe('self');
    // Reachable ⇒ the raw hierarchy rides along as the seed for static replay.
    expect(spec.replayData).toBeDefined();
  });

  it('show_topology runs the depth-1 builder and emits the ego graph + snapshot', async () => {
    buildTopo.mockResolvedValue({
      layer: 'GENERAL',
      service: 'svc-1',
      depth: 1,
      reachable: true,
      generatedAt: 0,
      config: {
        nodeMetrics: [{ id: 'sla', label: 'SLA', unit: '%' }],
        linkServerMetrics: [{ id: 'cpm', label: 'Load', unit: 'rpm' }],
        linkClientMetrics: [],
      },
      nodes: [
        { id: 'svc-1', name: 'agent::songs', type: null, isReal: true, layers: ['GENERAL'], metrics: { sla: 100 } },
        { id: 'gw', name: 'agent::gateway', type: 'Tomcat', isReal: true, layers: ['GENERAL'], metrics: { sla: 99 } },
        { id: 'db', name: 'localhost:3306', type: 'mysql', isReal: false, layers: ['VIRTUAL_DATABASE'], metrics: {} },
      ],
      calls: [
        { id: 'c1', source: 'gw', target: 'svc-1', serverMetrics: { cpm: 5 }, clientMetrics: {}, serverMetricSeries: {}, clientMetricSeries: {} },
        { id: 'c2', source: 'svc-1', target: 'db', serverMetrics: { cpm: 2 }, clientMetrics: {}, serverMetricSeries: {}, clientMetricSeries: {} },
      ],
    });
    const { ctx, emitTopology } = mockCtx();
    const out = String(await byName(ctx).show_topology.invoke({ layer: 'GENERAL', service: 'agent::songs' }));
    expect(buildTopo).toHaveBeenCalledWith(expect.objectContaining({ layerKey: 'GENERAL', serviceArg: 'svc-1', depth: 1 }));
    const spec = emitTopology.mock.calls[0][0] as {
      upstream: Array<{ name: string }>;
      downstream: Array<{ name: string; isReal: boolean }>;
      replayData?: unknown;
    };
    // call target === focus ⇒ its source is upstream; call source === focus ⇒ downstream.
    expect(spec.upstream[0].name).toBe('agent::gateway');
    expect(spec.downstream[0].isReal).toBe(false);
    expect(spec.replayData).toBeDefined();
    expect(out).toMatch(/upstream caller/i);
  });

  it('show_topology still carries the snapshot on an unreachable read (frozen replay of the no-value state)', async () => {
    buildTopo.mockResolvedValue({
      layer: 'GENERAL', service: 'svc-1', depth: 1, reachable: false, generatedAt: 0,
      config: { nodeMetrics: [], linkServerMetrics: [], linkClientMetrics: [] },
      nodes: [], calls: [], error: 'oap down',
    });
    const { ctx, emitTopology } = mockCtx();
    const out = String(await byName(ctx).show_topology.invoke({ layer: 'GENERAL', service: 'agent::songs' }));
    const spec = emitTopology.mock.calls[0][0] as { replayData?: { reachable?: boolean } };
    // Always frozen — the block replays the captured (unreachable) state, never re-queries.
    expect(spec.replayData).toBeDefined();
    expect(spec.replayData?.reachable).toBe(false);
    expect(out).toMatch(/unreachable/i);
  });

  it('show_instance_topology resolves BOTH services and emits client=source, server=dest with a snapshot', async () => {
    buildInstTopo.mockResolvedValue({
      reachable: true,
      nodes: [{ id: 'i1', name: 'gw-1', serviceId: 'svc-2', serviceName: 'agent::gateway', isReal: true, metrics: {} }],
      calls: [],
      config: { nodeMetrics: [], linkServerMetrics: [], linkClientMetrics: [] },
      clientServiceName: 'agent::gateway',
      serverServiceName: 'agent::songs',
    });
    const { ctx, emitInstanceTopology } = mockCtx();
    const out = String(
      await byName(ctx).show_instance_topology.invoke({
        layer: 'GENERAL',
        sourceService: 'agent::gateway',
        destService: 'agent::songs',
      }),
    );
    const spec = emitInstanceTopology.mock.calls[0][0] as {
      clientService: string;
      clientServiceId: string;
      serverService: string;
      serverServiceId: string;
      windowMinutes?: number;
      replayData?: unknown;
    };
    // source → client, dest → server (must NOT be swapped).
    expect(spec.clientService).toBe('agent::gateway');
    expect(spec.clientServiceId).toBe('svc-2');
    expect(spec.serverService).toBe('agent::songs');
    expect(spec.serverServiceId).toBe('svc-1');
    expect(spec.windowMinutes).toBe(10); // (endMs 600_000 - 0) / 60_000
    expect(spec.replayData).toBeDefined();
    expect(out).toContain('agent::gateway');
  });

  it('show_instance_topology fails cleanly on an unknown source or dest and never emits', async () => {
    const { ctx, emitInstanceTopology } = mockCtx();
    const tools = byName(ctx);
    const badSrc = String(
      await tools.show_instance_topology.invoke({ layer: 'GENERAL', sourceService: 'nope', destService: 'agent::songs' }),
    );
    expect(badSrc).toMatch(/unknown source/i);
    const badDst = String(
      await tools.show_instance_topology.invoke({ layer: 'GENERAL', sourceService: 'agent::songs', destService: 'nope' }),
    );
    expect(badDst).toMatch(/unknown dest/i);
    expect(emitInstanceTopology).not.toHaveBeenCalled();
  });

  it('show_instance_topology denies without topology:read', async () => {
    const { ctx, emitInstanceTopology } = mockCtx(false);
    const out = String(
      await byName(ctx).show_instance_topology.invoke({
        layer: 'GENERAL',
        sourceService: 'agent::gateway',
        destService: 'agent::songs',
      }),
    );
    expect(out).toMatch(/permission|topology:read/i);
    expect(emitInstanceTopology).not.toHaveBeenCalled();
  });

  it('show_widget renders a widget that lives ONLY on an extension page', async () => {
    resolveEff.mockResolvedValue({ blocked: false, template: extPageTemplate });
    runWidgetsMock.mockResolvedValueOnce({ widgets: [{ id: 'jvm_heap', series: [{ data: [1, 2] }] }] });
    const { ctx, emitFigure } = mockCtx();
    const out = String(
      await byName(ctx).show_widget.invoke({ layer: 'GENERAL', service: 'agent::songs', widgetId: 'jvm_heap' }),
    );
    // The default grid holds only `service_load`, so finding this one is
    // what proves the lookup enumerates the extension pages — and it
    // arrives with the template's own config rather than a rebuilt spec.
    expect(runWidgetsMock).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'jvm_heap', unit: 'MB', tip: 'Heap after the last GC' })],
      expect.objectContaining({ service: 'agent::songs', serviceId: 'svc-1', scope: 'service' }),
      expect.anything(),
      expect.anything(),
    );
    const fig = emitFigure.mock.calls[0]![0] as { title: string; figures: Array<{ spec: { unit?: string } }> };
    expect(fig.title).toBe('JVM heap');
    expect(fig.figures[0]!.spec.unit).toBe('MB');
    expect(out).toContain('Heap after the last GC');
  });

  it('show_widget reports an unknown widget id without running anything', async () => {
    resolveEff.mockResolvedValue({ blocked: false, template: extPageTemplate });
    const { ctx, emitFigure } = mockCtx();
    const out = String(
      await byName(ctx).show_widget.invoke({ layer: 'GENERAL', service: 'agent::songs', widgetId: 'nope' }),
    );
    expect(out).toMatch(/no widget "nope"/i);
    expect(runWidgetsMock).not.toHaveBeenCalled();
    expect(emitFigure).not.toHaveBeenCalled();
  });
});
