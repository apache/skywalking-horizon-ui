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
 * A chat block mounts a real feature view scoped to one service. The tool that
 * produced the block matched the prompt's service against the layer roster, so
 * the spec holds BOTH halves — and the block must hand both to the view. Passing
 * only the name would leave the view to have the id resolved back out of it.
 */

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type { Component } from 'vue';
import { i18n } from '@/i18n';
import ChatLogsBlock from './ChatLogsBlock.vue';
import ChatTracesBlock from './ChatTracesBlock.vue';
import ChatBrowserErrorsBlock from './ChatBrowserErrorsBlock.vue';

const SERVICE = 'songs';
const SERVICE_ID = 'bWVzaC1zdnI6OnNvbmdz.1';

/** The block's inner feature view, stubbed so the assertion is about the props
 *  that cross the boundary, not about the view's own fetching. */
const ViewStub = { name: 'ViewStub', props: ['focusService', 'focusServiceId'], template: '<div />' };

function propsOfMountedView(
  block: Component,
  stubName: string,
  spec: Record<string, unknown>,
): Record<string, unknown> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const w = mount(block, {
    props: { n: 1, spec },
    global: {
      plugins: [createPinia(), i18n, [VueQueryPlugin, { queryClient }]],
      stubs: { [stubName]: ViewStub },
    },
  });
  return w.findComponent(ViewStub).props();
}

describe('chat blocks carry the service pair into the view they mount', () => {
  const cases: Array<[string, Component, string]> = [
    ['logs', ChatLogsBlock, 'LayerLogsView'],
    ['traces', ChatTracesBlock, 'LayerTracesView'],
    ['browser errors', ChatBrowserErrorsBlock, 'LayerBrowserErrorsView'],
  ];

  for (const [label, block, stubName] of cases) {
    it(`${label}: passes the spec's service AND serviceId`, () => {
      const props = propsOfMountedView(block, stubName, {
        title: `A ${label} block`,
        layer: 'MESH',
        service: SERVICE,
        serviceId: SERVICE_ID,
        windowMinutes: 30,
        replayData: { generatedAt: 0, reachable: true, total: 0, logs: [], traces: [] },
      });
      expect(props.focusService).toBe(SERVICE);
      expect(props.focusServiceId).toBe(SERVICE_ID);
    });
  }
});
