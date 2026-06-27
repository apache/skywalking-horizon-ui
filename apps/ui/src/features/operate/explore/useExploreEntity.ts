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
 * The OPTIONAL pick/type entity picker shared by the Trace inspect
 * (ExploreView) and Log inspect (ExploreLogView) power-tools. The entity
 * is layer-less by design: name a service by PICKING it (a layer-filtered
 * dropdown that cascade-loads instances + endpoints) or TYPING it (service
 * name + the real/normal flag the BFF encodes into the OAP id), or leave it
 * blank to query every service.
 *
 * The composable owns the picker STATE + loaders + option lists +
 * `currentEntity` / `seedTypeFromPick`; the consumer owns the watch wiring
 * (ExploreLogView branches its cascade on the active log source — pods vs
 * raw/browser — so the watches can't live here).
 */

import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { bffClient } from '@/api/client';
import type { ExploreEntity } from '@/api/client';

export type EntityMode = 'pick' | 'type';

export function useExploreEntity() {
  const { t } = useI18n();

  const entityMode = ref<EntityMode>('pick');

  const pickLayer = ref<string>('');
  const pickServiceId = ref<string>('');
  const pickInstanceId = ref<string>('');
  const pickEndpointId = ref<string>('');
  const services = ref<Array<{ id: string; name: string; normal: boolean | null }>>([]);
  const instances = ref<Array<{ id: string; name: string }>>([]);
  const endpoints = ref<Array<{ id: string; name: string }>>([]);
  const servicesLoading = ref(false);

  const pickServiceName = computed(
    () => services.value.find((s) => s.id === pickServiceId.value)?.name ?? '',
  );

  async function loadServices(): Promise<void> {
    services.value = [];
    instances.value = [];
    endpoints.value = [];
    pickServiceId.value = '';
    pickInstanceId.value = '';
    pickEndpointId.value = '';
    if (!pickLayer.value) return;
    servicesLoading.value = true;
    try {
      const res = await bffClient.layer.services(pickLayer.value);
      services.value = res.reachable ? res.services : [];
    } catch {
      services.value = [];
    } finally {
      servicesLoading.value = false;
    }
  }

  async function loadInstances(): Promise<void> {
    instances.value = [];
    pickInstanceId.value = '';
    const name = pickServiceName.value;
    if (!pickLayer.value || !name) return;
    try {
      const res = await bffClient.layer.instances(pickLayer.value, name);
      instances.value = res.reachable ? res.instances : [];
    } catch {
      instances.value = [];
    }
  }

  async function loadEndpoints(): Promise<void> {
    const name = pickServiceName.value;
    if (!pickLayer.value || !name) {
      endpoints.value = [];
      return;
    }
    try {
      const res = await bffClient.layer.endpoints(pickLayer.value, name, '', 50);
      endpoints.value = res.reachable ? res.endpoints : [];
    } catch {
      endpoints.value = [];
    }
  }

  const serviceOptions = computed(() =>
    services.value.map((s) => ({ value: s.id, label: s.name, hint: s.normal === false ? 'virtual' : undefined })),
  );
  const instanceOptions = computed(() => [
    { value: '', label: t('All instances') },
    ...instances.value.map((i) => ({ value: i.id, label: i.name })),
  ]);
  const endpointOptions = computed(() => [
    { value: '', label: t('All endpoints') },
    ...endpoints.value.map((e) => ({ value: e.id, label: e.name })),
  ]);
  const instanceSel = computed<string>({ get: () => pickInstanceId.value, set: (v) => (pickInstanceId.value = v ?? '') });
  const endpointSel = computed<string>({ get: () => pickEndpointId.value, set: (v) => (pickEndpointId.value = v ?? '') });

  const typeService = ref<string>('');
  const typeReal = ref<boolean>(true);
  const typeInstance = ref<string>('');
  const typeEndpoint = ref<string>('');

  /** Seed the Type form from the current Pick selection — pick to discover,
   *  then tweak the name/flag by hand. */
  function seedTypeFromPick(): void {
    if (!pickServiceName.value) return;
    typeService.value = pickServiceName.value;
    typeReal.value = services.value.find((s) => s.id === pickServiceId.value)?.normal !== false;
    typeInstance.value = instances.value.find((i) => i.id === pickInstanceId.value)?.name ?? '';
    typeEndpoint.value = endpoints.value.find((e) => e.id === pickEndpointId.value)?.name ?? '';
    entityMode.value = 'type';
  }

  function currentEntity(): ExploreEntity | null {
    if (entityMode.value === 'pick') {
      if (!pickServiceId.value) return null;
      return {
        mode: 'pick',
        serviceId: pickServiceId.value,
        instanceId: pickInstanceId.value || undefined,
        endpointId: pickEndpointId.value || undefined,
      };
    }
    const name = typeService.value.trim();
    if (!name) return null;
    return {
      mode: 'type',
      serviceName: name,
      isReal: typeReal.value,
      instanceName: typeInstance.value.trim() || undefined,
      endpointName: typeEndpoint.value.trim() || undefined,
    };
  }

  return {
    entityMode,
    pickLayer,
    pickServiceId,
    pickInstanceId,
    pickEndpointId,
    services,
    instances,
    endpoints,
    servicesLoading,
    pickServiceName,
    loadServices,
    loadInstances,
    loadEndpoints,
    serviceOptions,
    instanceOptions,
    endpointOptions,
    instanceSel,
    endpointSel,
    typeService,
    typeReal,
    typeInstance,
    typeEndpoint,
    seedTypeFromPick,
    currentEntity,
  };
}
