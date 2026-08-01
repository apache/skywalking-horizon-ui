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
 * The alarms cascade filter must carry the picked service's `normal` flag,
 * not just its name: OAP encodes the flag in the service id, so an alarm
 * query for a virtual (conjectural) service sent as normal matches nothing.
 */

import { describe, it, expect, vi } from 'vitest';
import { defineComponent, h, ref, type Ref } from 'vue';
import { mount } from '@vue/test-utils';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

const services = vi.fn(async () => ({
  layer: 'VIRTUAL_DATABASE',
  services: [
    { name: 'songs', normal: true },
    { name: 'mysql-a', normal: false },
    { name: 'legacy-flagless', normal: null },
  ],
}));

vi.mock('@/api/client', () => ({
  bff: { alarms: { services: () => services() } },
  bffClient: {
    layer: {
      instances: async () => ({ reachable: true, instances: [] }),
      endpoints: async () => ({ reachable: true, endpoints: [] }),
    },
  },
}));

const { useAlarmFilters, normalFor, emptyFilters } = await import('./useAlarmFilters');
type Filters = ReturnType<typeof useAlarmFilters>;

/** Mount the composable inside a throwaway component so vue-query has a
 *  provider + an owning scope, and hand the state machine back. */
function mountFilters(hasQueryAlarms: Ref<boolean> = ref(true)): Filters {
  let filters!: Filters;
  const Host = defineComponent({
    setup() {
      filters = useAlarmFilters(hasQueryAlarms);
      return () => h('div');
    },
  });
  mount(Host, {
    global: {
      plugins: [
        [
          VueQueryPlugin,
          { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        ],
      ],
    },
  });
  return filters;
}

/** Pick a layer and wait for its roster to land. */
async function pickLayer(f: Filters, layer: string): Promise<void> {
  f.draft.value.layer = layer;
  f.onLayerChange();
  await vi.waitFor(() => expect(f.serviceOptions.value.length).toBeGreaterThan(0));
}

describe('normalFor — roster lookup', () => {
  it('reads the flag off the matching entry', () => {
    const roster = [
      { name: 'songs', normal: true },
      { name: 'mysql-a', normal: false },
    ];
    expect(normalFor(roster, 'songs')).toBe(true);
    expect(normalFor(roster, 'mysql-a')).toBe(false);
  });

  it('defaults to normal for a name the roster does not hold', () => {
    expect(normalFor([{ name: 'songs', normal: true }], 'gone')).toBe(true);
    expect(normalFor([], '')).toBe(true);
  });
});

describe('useAlarmFilters — the picked service carries its normal flag', () => {
  it('starts out with no service and the normal default', () => {
    expect(emptyFilters()).toEqual({
      layer: '',
      service: '',
      serviceNormal: true,
      instance: '',
      endpoint: '',
      keyword: '',
    });
  });

  it('keeps {name, normal} per roster entry instead of names alone', async () => {
    const f = mountFilters();
    await pickLayer(f, 'VIRTUAL_DATABASE');
    expect(f.serviceOptions.value).toEqual([
      { name: 'songs', normal: true },
      { name: 'mysql-a', normal: false },
      { name: 'legacy-flagless', normal: true },
    ]);
  });

  it('applies normal:false when the operator picks a virtual service', async () => {
    const f = mountFilters();
    await pickLayer(f, 'VIRTUAL_DATABASE');
    f.draft.value.service = 'mysql-a';
    f.onServiceChange();
    f.applyFilters();
    expect(f.applied.value.service).toBe('mysql-a');
    expect(f.applied.value.serviceNormal).toBe(false);
  });

  it('applies normal:true when the operator picks a normal service', async () => {
    const f = mountFilters();
    await pickLayer(f, 'VIRTUAL_DATABASE');
    f.draft.value.service = 'songs';
    f.onServiceChange();
    f.applyFilters();
    expect(f.applied.value.serviceNormal).toBe(true);
  });

  it('resets the flag when the service or layer selection is dropped', async () => {
    const f = mountFilters();
    await pickLayer(f, 'VIRTUAL_DATABASE');
    f.draft.value.service = 'mysql-a';
    f.onServiceChange();
    expect(f.draft.value.serviceNormal).toBe(false);

    f.draft.value.service = '';
    f.onServiceChange();
    expect(f.draft.value.serviceNormal).toBe(true);

    f.draft.value.service = 'mysql-a';
    f.onServiceChange();
    f.onLayerChange();
    expect(f.draft.value.serviceNormal).toBe(true);

    f.draft.value.service = 'mysql-a';
    f.onServiceChange();
    f.applyFilters();
    f.clearFilters();
    expect(f.applied.value.serviceNormal).toBe(true);
  });
});
