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
 * New-mode cascade filter for the Alarms page — a small, alarm-agnostic
 * state machine.
 *
 * Two layers of state: `draft` is what the operator is composing;
 * `applied` is what the alarms query actually filters by. Nothing fires
 * the alarms query until `applyFilters()` (or pickPreset / onRefresh on
 * the page). The dependent service / instance / endpoint queries DO
 * fire off the draft (so the dropdowns populate as the operator
 * cascades), gated on `hasQueryAlarms` — legacy OAP exposes neither, so
 * the page falls back to keyword-only.
 *
 * Returned `applied` is the contract the page reads when building the
 * alarms query key; `draft` backs the picker inputs (AlarmFilterRow).
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { bff, bffClient } from '@/api/client';

export interface FilterValues {
  layer: string;
  service: string;
  instance: string;
  endpoint: string;
  keyword: string;
}
export function emptyFilters(): FilterValues {
  return { layer: '', service: '', instance: '', endpoint: '', keyword: '' };
}

export interface AlarmFilters {
  draft: Ref<FilterValues>;
  applied: Ref<FilterValues>;
  serviceOptions: ComputedRef<string[]>;
  instanceOptions: ComputedRef<string[]>;
  endpointOptions: ComputedRef<string[]>;
  servicesFetching: ComputedRef<boolean>;
  instancesFetching: ComputedRef<boolean>;
  endpointsFetching: ComputedRef<boolean>;
  isDirty: ComputedRef<boolean>;
  onLayerChange: () => void;
  onServiceChange: () => void;
  applyFilters: () => void;
  clearFilters: () => void;
}

export function useAlarmFilters(hasQueryAlarms: Ref<boolean>): AlarmFilters {
  const draft = ref<FilterValues>(emptyFilters());
  const applied = ref<FilterValues>(emptyFilters());

  const servicesQuery = useQuery({
    queryKey: computed(() => ['alarms/services', draft.value.layer]),
    queryFn: () => bff.alarms.services(draft.value.layer),
    enabled: computed(() => hasQueryAlarms.value && draft.value.layer.length > 0),
    staleTime: 30_000,
  });
  const serviceOptions = computed<string[]>(
    () => (servicesQuery.data.value?.services ?? []).map((s) => s.name),
  );

  const instancesQuery = useQuery({
    queryKey: computed(() => ['alarms/instances', draft.value.layer, draft.value.service]),
    queryFn: () => bffClient.layer.instances(draft.value.layer, draft.value.service),
    enabled: computed(
      () => hasQueryAlarms.value && draft.value.layer.length > 0 && draft.value.service.length > 0,
    ),
    staleTime: 30_000,
  });
  const instanceOptions = computed<string[]>(
    () => (instancesQuery.data.value?.instances ?? []).map((i) => i.name),
  );

  const endpointsQuery = useQuery({
    queryKey: computed(() => ['alarms/endpoints', draft.value.layer, draft.value.service]),
    queryFn: () => bffClient.layer.endpoints(draft.value.layer, draft.value.service, '', 50),
    enabled: computed(
      () => hasQueryAlarms.value && draft.value.layer.length > 0 && draft.value.service.length > 0,
    ),
    staleTime: 30_000,
  });
  const endpointOptions = computed<string[]>(
    () => (endpointsQuery.data.value?.endpoints ?? []).map((e) => e.name),
  );

  function onLayerChange(): void {
    draft.value.service = '';
    draft.value.instance = '';
    draft.value.endpoint = '';
  }
  function onServiceChange(): void {
    draft.value.instance = '';
    draft.value.endpoint = '';
  }
  function applyFilters(): void {
    applied.value = { ...draft.value };
  }
  function clearFilters(): void {
    draft.value = emptyFilters();
    applied.value = emptyFilters();
  }
  const isDirty = computed<boolean>(() => {
    const d = draft.value;
    const a = applied.value;
    return (
      d.layer !== a.layer ||
      d.service !== a.service ||
      d.instance !== a.instance ||
      d.endpoint !== a.endpoint ||
      d.keyword !== a.keyword
    );
  });

  return {
    draft,
    applied,
    serviceOptions,
    instanceOptions,
    endpointOptions,
    servicesFetching: computed(() => servicesQuery.isFetching.value),
    instancesFetching: computed(() => instancesQuery.isFetching.value),
    endpointsFetching: computed(() => endpointsQuery.isFetching.value),
    isDirty,
    onLayerChange,
    onServiceChange,
    applyFilters,
    clearFilters,
  };
}
