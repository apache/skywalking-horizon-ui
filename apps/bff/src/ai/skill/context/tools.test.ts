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

vi.mock('../../../logic/services/service-layer-catalog.js', () => ({
  serviceLayerCatalog: () => ({
    get: async () => ({
      layers: ['GENERAL', 'K8S_SERVICE'],
      byLayer: new Map([
        ['GENERAL', [
          { id: 'g1', name: 'agent::gateway', normal: true },
          { id: 'g2', name: 'agent::songs', normal: true },
        ]],
        ['K8S_SERVICE', [{ id: 'k1', name: 'showcase::gateway.ns', normal: true }]],
      ]),
    }),
  }),
}));

import { contextTools } from './tools.js';
import type { AiRequestContext } from '../../context.js';

function tools(hasVerb = true) {
  const ctx = { hasVerb: () => hasVerb, config: {}, fetch: undefined } as unknown as AiRequestContext;
  const [listLayers, listServices] = contextTools(ctx);
  return { listLayers, listServices };
}
const parse = (s: unknown) => JSON.parse(String(s));

describe('list_services', () => {
  it('lists one layer when a layer is given, tagged with that layer', async () => {
    const out = parse(await tools().listServices.invoke({ layer: 'GENERAL' }));
    expect(out.services.map((s: { name: string }) => s.name)).toEqual(['agent::gateway', 'agent::songs']);
    expect(out.services.every((s: { layer: string }) => s.layer === 'GENERAL')).toBe(true);
    expect(out.total).toBe(2);
  });

  it('searches ACROSS all layers when the layer is omitted, each row carrying its layer', async () => {
    const out = parse(await tools().listServices.invoke({}));
    expect(out.total).toBe(3);
    const byName = Object.fromEntries(out.services.map((s: { name: string; layer: string }) => [s.name, s.layer]));
    expect(byName['agent::gateway']).toBe('GENERAL');
    expect(byName['showcase::gateway.ns']).toBe('K8S_SERVICE');
  });

  it('keyword filters across layers (finds a service without knowing its layer)', async () => {
    const out = parse(await tools().listServices.invoke({ keyword: 'gateway' }));
    expect(out.services.map((s: { name: string }) => s.name).sort()).toEqual(['agent::gateway', 'showcase::gateway.ns']);
    // Both matches keep their distinct layers.
    expect(new Set(out.services.map((s: { layer: string }) => s.layer))).toEqual(new Set(['GENERAL', 'K8S_SERVICE']));
  });

  it('denies without metrics:read', async () => {
    expect(String(await tools(false).listServices.invoke({}))).toMatch(/permission|metrics:read/i);
  });
});
