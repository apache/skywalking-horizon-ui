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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import type { PodContainersResponse, PodLogsResponse } from '@/api/scopes/log';

const mocks = vi.hoisted(() => ({
  podContainers: vi.fn(),
  podLogs: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  bff: { log: { podContainers: mocks.podContainers, podLogs: mocks.podLogs } },
}));

const { useLayerPodLogs } = await import('./useLayerPodLogs');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function containers(names: string[]): PodContainersResponse {
  return { containers: names, errorReason: null, reachable: true, generatedAt: 1 };
}

function logs(content: string): PodLogsResponse {
  return {
    lines: [{ content, timestamp: 1 }],
    errorReason: null,
    reachable: true,
    generatedAt: 1,
    window: { start: '0', end: '1', step: 'SECOND' },
  };
}

function mountPodLogs() {
  const layer = ref('k8s');
  const instance = ref<string | null>(null);
  let api!: ReturnType<typeof useLayerPodLogs>;
  const Host = defineComponent({
    setup() {
      api = useLayerPodLogs(layer, instance);
      return () => h('div');
    },
  });
  const wrapper = mount(Host);
  return { api, instance, layer, wrapper };
}

beforeEach(() => {
  mocks.podContainers.mockReset();
  mocks.podLogs.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useLayerPodLogs request ownership', () => {
  it('does not let a slow old pod replace the new pod container list', async () => {
    const podA = deferred<PodContainersResponse>();
    const podB = deferred<PodContainersResponse>();
    mocks.podContainers.mockImplementation((_layer: string, id: string) => (
      id === 'pod-a' ? podA.promise : podB.promise
    ));
    const { api, instance, wrapper } = mountPodLogs();

    instance.value = 'pod-a';
    await nextTick();
    instance.value = 'pod-b';
    await nextTick();

    podB.resolve(containers(['app-b']));
    await flushPromises();
    expect(api.containers.value).toEqual(['app-b']);
    expect(api.selectedContainer.value).toBe('app-b');

    podA.resolve(containers(['app-a']));
    await flushPromises();
    expect(api.containers.value).toEqual(['app-b']);
    expect(api.selectedContainer.value).toBe('app-b');
    wrapper.unmount();
  });

  it('serializes one polling target and discards its reply after a filter switch', async () => {
    vi.useFakeTimers();
    mocks.podContainers.mockResolvedValue(containers(['app']));
    const oldPoll = deferred<PodLogsResponse>();
    const newPoll = deferred<PodLogsResponse>();
    mocks.podLogs
      .mockReturnValueOnce(oldPoll.promise)
      .mockReturnValueOnce(newPoll.promise);
    const { api, instance, wrapper } = mountPodLogs();
    instance.value = 'pod-a';
    await nextTick();
    await flushPromises();

    api.startTail();
    expect(mocks.podLogs).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.podLogs).toHaveBeenCalledTimes(1);

    api.keywords.value = ['ERROR'];
    await nextTick();
    expect(mocks.podLogs).toHaveBeenCalledTimes(2);
    expect(mocks.podLogs.mock.calls[1]?.[1]).toMatchObject({
      serviceInstanceId: 'pod-a',
      container: 'app',
      keywordsOfContent: ['ERROR'],
    });

    newPoll.resolve(logs('new-filter-result'));
    await flushPromises();
    expect(api.lines.value.map((line) => line.content)).toEqual(['new-filter-result']);

    oldPoll.resolve(logs('stale-result'));
    await flushPromises();
    expect(api.lines.value.map((line) => line.content)).toEqual(['new-filter-result']);

    api.stopTail();
    api.selectedContainer.value = 'sidecar';
    await nextTick();
    expect(api.lines.value).toEqual([]);
    expect(api.lastUpdatedAt.value).toBeNull();
    wrapper.unmount();
  });
});
