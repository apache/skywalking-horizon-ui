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
vi.mock('../../../logic/dashboard/run.js', () => ({ runWidgets: vi.fn() }));
vi.mock('../../../logic/oap/hierarchy.js', () => ({ getServiceHierarchy: vi.fn() }));
vi.mock('../../../logic/oap/topology.js', () => ({ getServiceEgoTopology: vi.fn() }));
// Catalog resolves the service row (id + normal) used to build the entity.
vi.mock('../../../logic/services/service-layer-catalog.js', () => ({
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
import { runWidgets } from '../../../logic/dashboard/run.js';
import { getServiceHierarchy } from '../../../logic/oap/hierarchy.js';
import { getServiceEgoTopology } from '../../../logic/oap/topology.js';
import type { AiRequestContext } from '../../context.js';
import type { StructuredToolInterface } from '@langchain/core/tools';

const runWidgetsMock = runWidgets as unknown as ReturnType<typeof vi.fn>;
const getHierarchy = getServiceHierarchy as unknown as ReturnType<typeof vi.fn>;
const getEgoTopology = getServiceEgoTopology as unknown as ReturnType<typeof vi.fn>;

function mockCtx(hasVerb = true) {
  const emitFigure = vi.fn();
  const emitHierarchy = vi.fn();
  const emitTopology = vi.fn();
  const emitInstanceTopology = vi.fn();
  const ctx = {
    hasVerb: () => hasVerb,
    emitFigure,
    emitHierarchy,
    emitTopology,
    emitInstanceTopology,
    opts: {},
    config: { current: {} },
    fetch: undefined,
    window: {},
    range: { startMs: 0, endMs: 600_000, step: 'MINUTE' },
    bulkSize: 5,
  } as unknown as AiRequestContext;
  return { ctx, emitFigure, emitHierarchy, emitTopology, emitInstanceTopology };
}
function byName(ctx: AiRequestContext): Record<string, StructuredToolInterface> {
  const map: Record<string, StructuredToolInterface> = {};
  for (const tl of visualizationTools(ctx)) map[tl.name] = tl;
  return map;
}
const base = { title: 'T', layer: 'GENERAL', service: 'agent::songs' };

beforeEach(() => {
  runWidgetsMock.mockReset();
  getHierarchy.mockReset();
  getEgoTopology.mockReset();
});

describe('visualization render tools', () => {
  it('denies without metrics:read and never runs a widget', async () => {
    const out = String(await byName(mockCtx(false).ctx).show_line.invoke({ ...base, expressions: ['x'] }));
    expect(out).toMatch(/permission|metrics:read/i);
    expect(runWidgetsMock).not.toHaveBeenCalled();
  });

  it('rejects the impossible instance×endpoint scope before touching OAP', async () => {
    const out = String(
      await byName(mockCtx().ctx).show_line.invoke({ ...base, expressions: ['x'], instance: 'i', endpoint: 'e' }),
    );
    expect(out).toMatch(/invalid scope/i);
    expect(runWidgetsMock).not.toHaveBeenCalled();
  });

  it('summarizes a card as a scalar and a line as a series', async () => {
    const tools = byName(mockCtx().ctx);
    runWidgetsMock.mockResolvedValueOnce({ widgets: [{ id: 'ai_fig', value: 42 }] });
    expect(String(await tools.show_card.invoke({ ...base, expressions: ['latest(x)'] }))).toContain('value ≈ 42');
    runWidgetsMock.mockResolvedValueOnce({ widgets: [{ id: 'ai_fig', series: [{ data: [1, 2, 3] }] }] });
    const lineOut = String(await tools.show_line.invoke({ ...base, expressions: ['x'] }));
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
    expect(getHierarchy).toHaveBeenCalledWith({}, 'svc-1', 'GENERAL', undefined);
    const spec = emitHierarchy.mock.calls[0][0] as {
      groups: Array<{ layer: string; peers: Array<{ role: string }> }>;
    };
    expect(spec.groups.map((g) => g.layer)).toEqual(['GENERAL', 'K8S_SERVICE']);
    expect(spec.groups[0].peers[0].role).toBe('self');
  });

  it('show_topology emits the resolved one-hop ego graph (upstream + downstream)', async () => {
    getEgoTopology.mockResolvedValue({
      reachable: true,
      focus: { id: 'svc-1', name: 'agent::songs' },
      upstream: [{ id: 'gw', name: 'agent::gateway', isReal: true, type: 'Tomcat', layer: 'GENERAL' }],
      downstream: [{ id: 'db', name: 'localhost:3306', isReal: false, type: 'mysql', layer: 'VIRTUAL_DATABASE' }],
    });
    const { ctx, emitTopology } = mockCtx();
    const out = String(await byName(ctx).show_topology.invoke({ layer: 'GENERAL', service: 'agent::songs' }));
    expect(getEgoTopology).toHaveBeenCalledWith({}, 'svc-1', 'agent::songs', expect.anything(), undefined);
    const spec = emitTopology.mock.calls[0][0] as {
      upstream: Array<{ name: string }>;
      downstream: Array<{ name: string; isReal: boolean }>;
    };
    expect(spec.upstream[0].name).toBe('agent::gateway');
    expect(spec.downstream[0].isReal).toBe(false);
    expect(out).toContain('1 upstream');
  });

  it('show_instance_topology resolves BOTH services and emits client=source, server=dest', async () => {
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
    };
    // source → client, dest → server (must NOT be swapped).
    expect(spec.clientService).toBe('agent::gateway');
    expect(spec.clientServiceId).toBe('svc-2');
    expect(spec.serverService).toBe('agent::songs');
    expect(spec.serverServiceId).toBe('svc-1');
    expect(spec.windowMinutes).toBe(10); // (endMs 600_000 - 0) / 60_000
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
});
