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
import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { useTraceQLTracePopout } from './useTraceQLTracePopout';

const Blank = { template: '<div />' };

async function harness(path: string) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/layer/:layerKey/service', component: Blank, meta: { layerRow: 'service' } },
      { path: '/layer/:layerKey/traceql-otlp-trace', component: Blank, meta: { layerRow: 'traceql-otlp-trace' } },
      { path: '/layer/:layerKey/traceql-native-trace', component: Blank, meta: { layerRow: 'traceql-native-trace' } },
    ],
  });
  await router.push(path);
  await router.isReady();
  let api!: ReturnType<typeof useTraceQLTracePopout>;
  mount(defineComponent({ setup() { api = useTraceQLTracePopout(); return () => h('div'); } }), { global: { plugins: [router] } });
  return { router, api };
}

describe('useTraceQLTracePopout', () => {
  it('opens on the current page and closes back to it', async () => {
    const { router, api } = await harness('/layer/otlp_virtual_database/service?service=db');
    api.openTrace('abc123', 'otlp');
    await router.isReady();
    await new Promise((r) => setTimeout(r));
    expect(router.currentRoute.value.path).toBe('/layer/otlp_virtual_database/service');
    expect(router.currentRoute.value.query).toEqual({ service: 'db', traceqlId: 'abc123', ds: 'otlp' });
    expect(api.open.value).toEqual({ traceId: 'abc123', ds: 'otlp' });
    api.closeTrace();
    await new Promise((r) => setTimeout(r));
    expect(router.currentRoute.value.query).toEqual({ service: 'db' });
    expect(api.open.value).toBeNull();
  });

  it('stands aside on the TraceQL row of the store it names, whose view opens the id itself', async () => {
    const { api } = await harness('/layer/otlp_service/traceql-otlp-trace?traceqlId=abc123&ds=otlp');
    expect(api.open.value).toBeNull();
  });

  it('opens on a TraceQL row of another store, from the store it names', async () => {
    const { router, api } = await harness('/layer/general/traceql-native-trace?traceqlId=abc123&ds=otlp');
    expect(api.open.value).toEqual({ traceId: 'abc123', ds: 'otlp' });
    api.closeTrace();
    await new Promise((r) => setTimeout(r));
    expect(router.currentRoute.value.query).toEqual({});
  });

  it('keeps the judged span and lookup time in a shareable evaluation URL and clears them on close', async () => {
    const { router, api } = await harness('/layer/general/service?service=db');
    api.openTrace('trace', 'otlp', { spanId: 'span', atMs: 1788393600000, evaluation: true });
    await new Promise((r) => setTimeout(r));
    expect(api.open.value).toEqual({ traceId: 'trace', ds: 'otlp', spanId: 'span', atMs: 1788393600000, evaluation: true });
    expect(router.currentRoute.value.query).toMatchObject({ traceqlSpanId: 'span', traceqlAt: '1788393600000', evaluationTrace: '1' });
    api.closeTrace();
    await new Promise((r) => setTimeout(r));
    expect(router.currentRoute.value.query).toEqual({ service: 'db' });
  });

  it('does not carry the previous evaluation focus into an ordinary trace', async () => {
    const { router, api } = await harness('/layer/general/service?traceqlId=old&ds=otlp&traceqlSpanId=old-span&traceqlAt=1000&evaluationTrace=1');
    api.openTrace('next', 'otlp');
    await new Promise((r) => setTimeout(r));
    expect(router.currentRoute.value.query).toEqual({ traceqlId: 'next', ds: 'otlp' });
    expect(api.open.value).toEqual({ traceId: 'next', ds: 'otlp' });
  });

  it('needs a known datasource', async () => {
    const { api } = await harness('/layer/general/service?traceqlId=abc123&ds=tempo');
    expect(api.open.value).toBeNull();
  });
});
