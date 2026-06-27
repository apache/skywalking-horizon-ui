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

import { ref, watch, type Ref } from 'vue';
import { bffClient } from '@/api/client';
import type { NetworkProcess } from '@/api/client';

/**
 * Processes reporting on a service instance. A network profiling task needs
 * at least one (OAP rejects an instance with none), so the create modal
 * fetches them lazily while `enabled` to validate + show them before Create.
 */
export function useNetworkProcesses(instanceId: Ref<string | null>, enabled: Ref<boolean>) {
  const processes = ref<NetworkProcess[]>([]);
  const loading = ref(false);
  watch([enabled, instanceId], async ([on, id]) => {
    if (!on || !id) {
      processes.value = [];
      loading.value = false;
      return;
    }
    loading.value = true;
    try {
      const resp = await bffClient.networkProfile.processes(id);
      if (!enabled.value || instanceId.value !== id) return; // stale
      processes.value = resp.processes ?? [];
    } catch {
      if (enabled.value && instanceId.value === id) processes.value = [];
    } finally {
      if (enabled.value && instanceId.value === id) loading.value = false;
    }
  });
  return { processes, loading };
}
