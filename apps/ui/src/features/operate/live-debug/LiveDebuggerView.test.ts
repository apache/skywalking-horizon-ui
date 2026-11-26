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

/** Leaving the Live debugger stops reading its running captures, so the page asks first. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { i18n } from '@/i18n';

const running = ref<string[]>([]);
vi.mock('./useDebugSession', () => ({ runningCaptures: running }));
vi.mock('./DebugMal.vue', () => ({ default: { template: '<div />' } }));
vi.mock('./DebugLal.vue', () => ({ default: { template: '<div />' } }));
vi.mock('./DebugOal.vue', () => ({ default: { template: '<div />' } }));
vi.mock('./DebugTal.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/shell/AdminFeatureWarning.vue', () => ({ default: { template: '<div />' } }));

const { default: LiveDebuggerView } = await import('./LiveDebuggerView.vue');

async function open() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/operate/live-debug/history', component: { template: '<div />' } },
      { path: '/operate/live-debug/:tab(mal|lal|oal|tal)?', component: LiveDebuggerView },
    ],
  });
  await router.push('/operate/live-debug/mal');
  await router.isReady();
  const app = mount({ template: '<router-view />' }, { global: { plugins: [i18n, router] } });
  await flushPromises();
  return { app, router };
}

describe('LiveDebuggerView', () => {
  afterEach(() => {
    running.value = [];
    vi.restoreAllMocks();
  });

  it('asks before leaving while a capture runs, and stays when the operator declines', async () => {
    running.value = ['mal', 'tal'];
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { app, router } = await open();
    await router.push('/operate/live-debug/history');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toContain('MAL, TAL');
    expect(router.currentRoute.value.path, 'declined: still on the debugger').toBe('/operate/live-debug/mal');

    confirm.mockReturnValue(true);
    await router.push('/operate/live-debug/history');
    expect(router.currentRoute.value.path).toBe('/operate/live-debug/history');
    app.unmount();
  });

  it('asks nothing to switch tabs, or to leave with no capture running', async () => {
    running.value = ['mal'];
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { app, router } = await open();
    await router.push('/operate/live-debug/oal');
    expect(router.currentRoute.value.path).toBe('/operate/live-debug/oal');
    running.value = [];
    await router.push('/operate/live-debug/history');
    expect(router.currentRoute.value.path).toBe('/operate/live-debug/history');
    expect(confirm).not.toHaveBeenCalled();
    app.unmount();
  });

  it('asks the browser to confirm a reload or a closed tab only while a capture runs', async () => {
    const { app } = await open();
    const unload = () => {
      const e = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(unload(), 'nothing running').toBe(false);
    running.value = ['oal'];
    expect(unload()).toBe(true);
    app.unmount();
    expect(unload(), 'the page is gone').toBe(false);
  });
});
