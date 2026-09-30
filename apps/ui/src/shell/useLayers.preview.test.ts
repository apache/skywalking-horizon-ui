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
 * Previewing a layer split by service group: its entries show the layer's
 * one draft, and the draft is not added as an entry of its own — which the
 * layer page would never open, since a split layer's URLs name its entries.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { LayerDef } from '@skywalking-horizon-ui/api-client';
import { bffClient } from '@/api/client';
import { setPreviewMode } from '@/controls/previewMode';
import { usePreviewOverride } from '@/controls/previewOverride';
import { useLayers } from './useLayers';

const entry = (key: string, serviceGroup?: string): LayerDef =>
  ({ key, name: key, color: '#fff', serviceCount: 1, active: true, level: null, slots: {}, caps: { dashboards: true }, serviceGroup }) as LayerDef;

afterEach(() => {
  setPreviewMode(false);
  usePreviewOverride().clear('horizon.layer.GENERAL');
  vi.restoreAllMocks();
});

async function menuInPreview(): Promise<LayerDef[]> {
  vi.spyOn(bffClient.menu, 'get').mockResolvedValue({
    layers: [entry('general', ''), entry('general', 'payments'), entry('mesh')],
    generatedAt: 0,
    oap: { reachable: true, queryUrl: '' },
  } as never);
  usePreviewOverride().set('horizon.layer.GENERAL', { key: 'GENERAL', components: { service: true, topology: true } });
  setPreviewMode(true, 'remote');
  let layers: LayerDef[] = [];
  const Probe = defineComponent({
    setup() {
      const l = useLayers();
      return () => h('div', (layers = l.layers.value, ''));
    },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const w = mount(Probe, { global: { plugins: [[VueQueryPlugin, { queryClient }]] } });
  await flushPromises();
  await flushPromises();
  w.unmount();
  return layers;
}

describe('a layer the live menu does not list, in preview', () => {
  it('is added under the key the menu uses, which is what its URLs name', async () => {
    vi.spyOn(bffClient.menu, 'get').mockResolvedValue({ layers: [entry('mesh')], generatedAt: 0, oap: { reachable: true, queryUrl: '' } } as never);
    usePreviewOverride().set('horizon.layer.CUSTOM_MQ', { key: 'CUSTOM_MQ', components: { service: true } });
    setPreviewMode(true, 'remote');
    let layers: LayerDef[] = [];
    const Probe = defineComponent({ setup() { const l = useLayers(); return () => h('div', (layers = l.layers.value, '')); } });
    const w = mount(Probe, { global: { plugins: [[VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }]] } });
    await flushPromises();
    await flushPromises();
    w.unmount();
    usePreviewOverride().clear('horizon.layer.CUSTOM_MQ');
    expect(layers.map((L) => L.key)).toEqual(['mesh', 'custom_mq']);
  });
});

describe('a split layer in preview', () => {
  it('shows the layer\'s draft on every one of its entries, and adds no entry of its own', async () => {
    const layers = await menuInPreview();
    expect(layers.map((L) => L.key)).toEqual(['general/', 'general/payments', 'mesh']);
    for (const L of layers.filter((x) => x.key.startsWith('general/'))) {
      expect(L.caps.serviceMap, L.key).toBe(true);
    }
    expect(layers.find((L) => L.key === 'mesh')!.caps.serviceMap).toBeFalsy();
  });
});
