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

import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { LayerDef } from '@skywalking-horizon-ui/api-client';
import { usePageTraceSource } from './usePageTraceSource';

const menu = ref([
  { key: 'general', traces: { sources: ['native'] } },
  { key: 'mesh', traces: { sources: ['zipkin', 'traceql-otlp'] } },
] as unknown as LayerDef[]);
vi.mock('@/shell/useLayers', () => ({ useLayers: () => ({ layers: menu }) }));

const Blank = { template: '<div />' };

async function sourceOn(path: string): Promise<string> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/layer/:layerKey/log', component: Blank, meta: { layerRow: 'log' } },
      { path: '/layer/:layerKey/zipkin-trace', component: Blank, meta: { layerRow: 'zipkin-trace' } },
      { path: '/operate/log-inspect', component: Blank },
    ],
  });
  await router.push(path);
  await router.isReady();
  let source = '';
  mount(defineComponent({ setup() { source = usePageTraceSource().value; return () => h('div'); } }), { global: { plugins: [router] } });
  return source;
}

describe('the trace source of a page\'s own traces, for a log row\'s trace link', () => {
  it('is Zipkin on a layer whose trace row is Zipkin, and on the Zipkin Traces row', async () => {
    expect(await sourceOn('/layer/mesh/log')).toBe('zipkin');
    expect(await sourceOn('/layer/general/zipkin-trace')).toBe('zipkin');
  });

  it('is native everywhere else, including pages outside a layer', async () => {
    expect(await sourceOn('/layer/general/log')).toBe('native');
    expect(await sourceOn('/operate/log-inspect')).toBe('native');
  });
});
