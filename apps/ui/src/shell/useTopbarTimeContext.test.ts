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
 * The global time picker is off on a tab that owns its time range, whichever
 * entry of a layer it sits under — a group entry's URL has one more segment.
 */

import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { layerRoutes } from './router/index';
import { useTopbarTimeContext } from './useTopbarTimeContext';

async function ownsTimeRange(url: string): Promise<boolean> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' }, children: [...layerRoutes(), { path: 'alarms', component: { template: '<div />' } }] },
    ],
  });
  await router.push(url);
  let owns = false;
  const Probe = defineComponent({
    setup() {
      const ctx = useTopbarTimeContext();
      return () => h('div', String((owns = ctx.ownsTimeRange.value)));
    },
  });
  mount(Probe, { global: { plugins: [router, createPinia()] } }).unmount();
  return owns;
}

describe('the topbar time picker', () => {
  it('is off on a tab owning its time range, on a group entry too', async () => {
    for (const url of ['/layer/general/trace', '/layer/general/payments/trace', '/layer/general/payments/logs', '/layer/mesh/pprof', '/alarms']) {
      expect(await ownsTimeRange(url), url).toBe(true);
    }
  });

  it('stays on for dashboards, including a group named like a tab', async () => {
    for (const url of ['/layer/general/service', '/layer/general/payments/service', '/layer/general/trace/service', '/layer/general/service/page/logs']) {
      expect(await ownsTimeRange(url), url).toBe(false);
    }
  });
});
