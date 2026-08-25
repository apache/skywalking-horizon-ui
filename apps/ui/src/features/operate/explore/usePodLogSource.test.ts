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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import type { PodContainersResponse } from '@/api/scopes/log';

const mocks = vi.hoisted(() => ({
  instances: vi.fn(),
  podContainers: vi.fn(),
}));

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/api/client', () => ({
  bff: {
    layer: { instances: mocks.instances },
    log: { podContainers: mocks.podContainers },
  },
}));

const { usePodLogSource } = await import('./usePodLogSource');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => { resolve = ok; });
  return { promise, resolve };
}

function containers(names: string[]): PodContainersResponse {
  return { containers: names, errorReason: null, reachable: true, generatedAt: 1 };
}

function instanceResponse(id: string) {
  return {
    layer: 'k8s',
    service: 'service',
    generatedAt: 1,
    instances: [{ id, name: id, language: null, attributes: [] }],
    reachable: true,
  };
}

function mountSource() {
  const logSource = ref('pods');
  const invalidateEntityRequests = vi.fn();
  const availableLayers = ref([{ key: 'k8s', name: 'Kubernetes', caps: { podLogs: true } }]);
  const pickLayer = ref('k8s');
  const pickServiceId = ref('');
  const pickServiceName = ref('');
  const pickInstanceId = ref('');
  const instances = ref<Array<{ id: string; name: string }>>([]);
  let api!: ReturnType<typeof usePodLogSource>;
  const Host = defineComponent({
    setup() {
      api = usePodLogSource({
        logSource,
        availableLayers: availableLayers as never,
        pickLayer,
        pickServiceId,
        pickServiceName,
        pickInstanceId,
        instances,
        loadServices: vi.fn(async () => undefined),
        loadInstances: vi.fn(async () => undefined),
        loadEndpoints: vi.fn(async () => undefined),
        invalidateEntityRequests,
      });
      return () => h('div');
    },
  });
  const wrapper = mount(Host);
  return {
    api,
    wrapper,
    logSource,
    pickServiceId,
    pickServiceName,
    pickInstanceId,
    instances,
    invalidateEntityRequests,
  };
}

beforeEach(() => {
  mocks.instances.mockReset();
  mocks.podContainers.mockReset();
});

describe('usePodLogSource request ownership', () => {
  it('keeps the newest service pods when the previous service answers last', async () => {
    const serviceA = deferred<ReturnType<typeof instanceResponse>>();
    const serviceB = deferred<ReturnType<typeof instanceResponse>>();
    mocks.instances.mockImplementation((_layer: string, service: { id: string }) => (
      service.id === 'service-a' ? serviceA.promise : serviceB.promise
    ));
    mocks.podContainers.mockResolvedValue(containers(['app-b']));
    const { api, wrapper, pickServiceId, pickServiceName, pickInstanceId, instances } = mountSource();

    pickServiceName.value = 'Service A';
    pickServiceId.value = 'service-a';
    await nextTick();
    pickServiceName.value = 'Service B';
    pickServiceId.value = 'service-b';
    await nextTick();

    serviceB.resolve(instanceResponse('pod-b'));
    await flushPromises();
    expect(instances.value.map((pod) => pod.id)).toEqual(['pod-b']);
    expect(pickInstanceId.value).toBe('pod-b');
    expect(api.podContainer.value).toBe('app-b');

    serviceA.resolve(instanceResponse('pod-a'));
    await flushPromises();
    expect(instances.value.map((pod) => pod.id)).toEqual(['pod-b']);
    expect(pickInstanceId.value).toBe('pod-b');
    expect(api.podContainer.value).toBe('app-b');
    wrapper.unmount();
  });

  it('keeps the newest container list when the previous pod answers last', async () => {
    const podA = deferred<PodContainersResponse>();
    const podB = deferred<PodContainersResponse>();
    mocks.podContainers.mockImplementation((_layer: string, id: string) => (
      id === 'pod-a' ? podA.promise : podB.promise
    ));
    const { api, wrapper, pickInstanceId } = mountSource();

    pickInstanceId.value = 'pod-a';
    await nextTick();
    pickInstanceId.value = 'pod-b';
    await nextTick();
    podB.resolve(containers(['app-b']));
    await flushPromises();
    expect(api.podContainers.value).toEqual(['app-b']);
    expect(api.podContainer.value).toBe('app-b');

    podA.resolve(containers(['app-a']));
    await flushPromises();
    expect(api.podContainers.value).toEqual(['app-b']);
    expect(api.podContainer.value).toBe('app-b');
    wrapper.unmount();
  });

  it('snapshots the full log condition, rejects stale publication, and serializes one generation', async () => {
    mocks.podContainers.mockResolvedValue(containers(['app']));
    const { api, wrapper, pickInstanceId } = mountSource();
    pickInstanceId.value = 'pod-a';
    await nextTick();
    await flushPromises();

    const oldRequest = api.beginPodLogRequest();
    expect(oldRequest).not.toBeNull();
    expect(api.beginPodLogRequest()).toBeNull();

    // The direct comparison closes the gap before Vue's scheduled watcher
    // increments the generation.
    api.podIncludes.value = ['ERROR'];
    expect(api.isPodLogRequestCurrent(oldRequest!)).toBe(false);
    await nextTick();

    const newRequest = api.beginPodLogRequest();
    expect(newRequest?.body).toMatchObject({
      serviceInstanceId: 'pod-a',
      container: 'app',
      windowSeconds: 60,
      keywordsOfContent: ['ERROR'],
    });
    expect(api.isPodLogRequestCurrent(oldRequest!)).toBe(false);
    expect(api.isPodLogRequestCurrent(newRequest!)).toBe(true);
    api.finishPodLogRequest(oldRequest!);
    expect(api.beginPodLogRequest()).toBeNull();
    api.finishPodLogRequest(newRequest!);
    expect(api.beginPodLogRequest()).not.toBeNull();
    wrapper.unmount();
  });

  /**
   * The view resets the entity picker only when pods is on one side of the
   * switch; between raw and browser it keeps it. Orphaning the cascade there
   * stranded the picker empty — its request abandoned, its indicator cleared,
   * and nothing to start another.
   */
  it('leaves the entity cascade alone when switching between raw and browser', async () => {
    const { logSource, invalidateEntityRequests } = mountSource();
    logSource.value = 'raw';
    await nextTick();
    invalidateEntityRequests.mockClear();

    logSource.value = 'browser';
    await nextTick();

    expect(invalidateEntityRequests).not.toHaveBeenCalled();
  });

  it('orphans the entity cascade when pods is on either side of the switch', async () => {
    const { logSource, invalidateEntityRequests } = mountSource();
    logSource.value = 'raw';
    await nextTick();
    invalidateEntityRequests.mockClear();

    logSource.value = 'pods';
    await nextTick();

    expect(invalidateEntityRequests).toHaveBeenCalled();
  });
});
