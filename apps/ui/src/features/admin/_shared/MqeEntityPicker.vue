<!--
  Licensed to the Apache Software Foundation (ASF) under one or more
  contributor license agreements.  See the NOTICE file distributed with
  this work for additional information regarding copyright ownership.
  The ASF licenses this file to You under the Apache License, Version 2.0
  (the "License"); you may not use this file except in compliance with
  the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
-->

<!--
  One entity for an MQE run: a service, optionally narrowed to one of its
  instances or endpoints. The layer is FIXED by the caller — it is the
  template being edited, and exploring another layer's services from inside
  it would only produce results that can never apply.

  Emits the pair the MQE wire needs (`serviceName` + `normal`), never an OAP
  id: `normal` cannot be rebuilt from a bare name, and a wrong flag addresses
  a service that was never stored.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import TypeaheadSelect from '@/components/primitives/TypeaheadSelect.vue';
import { useLayerServices } from '@/layer/useLayerServices';
import { useLayerInstances } from '@/layer/useLayerInstances';
import { useLayerEndpoints } from '@/layer/useLayerEndpoints';
import { serviceRef } from '@/utils/serviceRef';

/** Which halves of the entity this site actually needs filled. */
export type EntityShape = 'service' | 'instance' | 'endpoint' | 'process';

export interface PickedEntity {
  /** Empty means LAYER-WIDE — the entity carries no service name at all,
   *  which is what a `top_n(...)` column needs: it ranks across the layer,
   *  and naming one service makes OAP fail the query outright. */
  serviceName: string;
  normal: boolean;
  instanceName?: string;
  endpointName?: string;
  processName?: string;
}

const props = defineProps<{
  layerKey: string;
  shape: EntityShape;
  /** Prefix for the field labels — "Source" / "Destination" on a relation
   *  metric, absent on a single-entity one. */
  legend?: string;
  /** Layer-wide is meaningful only on a SINGLE-entity site: a relation is
   *  defined by naming two services, so a blank half addresses OAP's `_blank`
   *  service and comes back empty with nothing to say why. */
  allowLayerWide?: boolean;
  /** When set, the service is FIXED to this name and shown read-only — the
   *  deployment graph is intra-service, so its destination side may only
   *  choose an instance. Empty means the operator picks freely. */
  lockedService?: string;
}>();
const emit = defineEmits<{ pick: [PickedEntity | null] }>();

const { t } = useI18n({ useScope: 'global' });

const layerRef = computed(() => props.layerKey);
// The panel owns its own window and never joins the refresh round, so the
// roster must not subscribe to the ticker either.
const { services, isLoading: servicesLoading, isError: servicesError } = useLayerServices(layerRef, {
  rideTicker: false,
});

/** Sentinel for the layer-wide pick. Not an OAP id — no service has one. */
const LAYER_WIDE = '__layer_wide__';

const serviceId = ref('');
const isLocked = computed(() => !!props.lockedService);
const serviceOptions = computed(() => {
  const rows = services.value.map((s) => ({ value: s.id, label: s.name, hint: s.group || undefined }));
  // Only a bare service entity can be layer-wide; instances and endpoints
  // hang off a specific service, and a relation names two of them.
  return props.shape === 'service' && props.allowLayerWide
    ? [{ value: LAYER_WIDE, label: t('All services (layer-wide)'), hint: t('for top_n') }, ...rows]
    : rows;
});
const picked = computed(() => services.value.find((s) => s.id === serviceId.value) ?? null);

// Seeded from the roster, and re-seeded when a layer switch invalidates the
// pick. Must stay BELOW `services` — `immediate: true` runs during setup,
// where a later `const` is still in the TDZ and throws with no rendered error.
watch(
  [services, () => props.lockedService],
  ([rows, locked]) => {
    if (rows.length === 0) {
      serviceId.value = '';
      return;
    }
    if (locked) {
      // The lock names a service, not an id — resolve it against this layer's
      // roster so the emitted entity still carries the `normal` flag.
      const hit = rows.find((r) => r.name === locked);
      serviceId.value = hit ? hit.id : '';
      return;
    }
    // The layer-wide sentinel is a deliberate pick, not a stale id — keep it.
    if (serviceId.value === LAYER_WIDE) return;
    if (!rows.some((r) => r.id === serviceId.value)) serviceId.value = rows[0]!.id;
  },
  { immediate: true },
);

const svcRef = computed(() => (picked.value ? serviceRef(picked.value.id, picked.value.name, picked.value.normal) : null));

const needsInstance = computed(() => props.shape === 'instance' || props.shape === 'process');
const { instances, isFetching: instancesLoading, error: instancesError } = useLayerInstances(
  computed(() => (needsInstance.value ? props.layerKey : '')),
  computed(() => (needsInstance.value ? svcRef.value : null)),
);
const instanceName = ref('');
const instanceOptions = computed(() => instances.value.map((i) => ({ value: i.name, label: i.name })));
watch(instances, (rows) => {
  if (!needsInstance.value) return;
  if (rows.length === 0) {
    instanceName.value = '';
    return;
  }
  if (!rows.some((r) => r.name === instanceName.value)) instanceName.value = rows[0]!.name;
}, { immediate: true });

// The keyword goes to OAP's own `findEndpoint`, the way the runtime picker
// searches — an endpoint roster is unbounded, so client-side filtering over
// a fixed page would hide most of it.
const endpointQuery = ref('');
const { endpoints, isFetching: endpointsLoading, error: endpointsError } = useLayerEndpoints(
  computed(() => (props.shape === 'endpoint' ? props.layerKey : '')),
  computed(() => (props.shape === 'endpoint' ? svcRef.value : null)),
  endpointQuery,
  ref(50),
);
const endpointName = ref('');
const endpointOptions = computed(() => endpoints.value.map((e) => ({ value: e.name, label: e.name })));
watch(endpoints, (rows) => {
  if (props.shape !== 'endpoint') return;
  if (rows.length === 0) {
    endpointName.value = '';
    return;
  }
  if (!rows.some((r) => r.name === endpointName.value)) endpointName.value = rows[0]!.name;
}, { immediate: true });

/** ProcessRelation names are temporal and may be virtual. The profiling
 *  process roster is therefore the wrong source here: it uses a different
 *  rolling window, needs `profile:read`, and deliberately removes virtual
 *  rows. Keep the process name editable so a metrics-only template author
 *  can address any process that exists in the panel's chosen time range. */
const processName = ref('');

function fieldLabel(key: string): string {
  const label = t(key);
  return props.legend ? `${props.legend} · ${label}` : label;
}

// A child entity from the previous parent must never be emitted with the new
// parent while the next roster request is in flight.
watch(serviceId, () => {
  instanceName.value = '';
  endpointName.value = '';
  endpointQuery.value = '';
  processName.value = '';
});
watch(instanceName, () => {
  if (props.shape === 'process') processName.value = '';
});

const current = computed<PickedEntity | null>(() => {
  // Layer-wide: a real pick that names no service.
  if (serviceId.value === LAYER_WIDE) return { serviceName: '', normal: true };
  const s = picked.value;
  if (!s) return null;
  const base: PickedEntity = { serviceName: s.name, normal: s.normal !== false };
  if (props.shape === 'instance' || props.shape === 'process') {
    if (!instanceName.value) return null;
    const withInstance = { ...base, instanceName: instanceName.value };
    if (props.shape === 'process') {
      const process = processName.value.trim();
      return process ? { ...withInstance, processName: process } : null;
    }
    return withInstance;
  }
  if (props.shape === 'endpoint') {
    if (!endpointName.value) return null;
    return { ...base, endpointName: endpointName.value };
  }
  return base;
});
watch(current, (v) => emit('pick', v), { immediate: true });

/** An unreadable roster and an empty layer are different facts and must not
 *  render the same: one is an outage, the other is the truth about the layer. */
const emptyReason = computed<string | null>(() => {
  if (servicesLoading.value) return t('Reading data…');
  if (servicesError.value) return t('Could not read the service list for this layer.');
  if (services.value.length === 0) return t('No services reported in this layer yet.');
  if (needsInstance.value && instancesError.value) {
    return t('Could not read the instances of this service.');
  }
  if (props.shape === 'endpoint' && endpointsError.value) {
    return t('Could not read the endpoints of this service.');
  }
  return null;
});
</script>

<template>
  <div class="mep">
    <label class="mep-field">
      <span class="mep-label">{{ fieldLabel('service') }}</span>
      <span v-if="isLocked" class="mep-locked" :title="t('Fixed to the source service — this graph does not cross services')">
        {{ lockedService }}
      </span>
      <TypeaheadSelect
        v-else
        v-model="serviceId"
        :options="serviceOptions"
        :placeholder="t('Pick a service')"
        :disabled="services.length === 0"
        :aria-label="fieldLabel('service')"
        block
      />
    </label>

    <label v-if="shape === 'instance' || shape === 'process'" class="mep-field">
      <span class="mep-label">{{ fieldLabel('instance') }}</span>
      <TypeaheadSelect
        v-model="instanceName"
        :options="instanceOptions"
        :placeholder="instancesLoading ? t('Reading data…') : t('Pick an instance')"
        :disabled="instanceOptions.length === 0"
        :aria-label="fieldLabel('instance')"
        block
      />
    </label>

    <label v-if="shape === 'process'" class="mep-field">
      <span class="mep-label">{{ fieldLabel('process') }}</span>
      <input
        v-model="processName"
        class="mep-input"
        type="text"
        :placeholder="t('process')"
        spellcheck="false"
        autocomplete="off"
      />
    </label>

    <template v-if="shape === 'endpoint'">
      <label class="mep-field">
        <span class="mep-label">{{ fieldLabel('endpoint search') }}</span>
        <input
          v-model="endpointQuery"
          class="mep-input"
          type="text"
          :placeholder="t('Filter endpoints…')"
          spellcheck="false"
        />
      </label>
      <label class="mep-field">
        <span class="mep-label">{{ fieldLabel('endpoint') }}</span>
        <TypeaheadSelect
          v-model="endpointName"
          :options="endpointOptions"
          :placeholder="endpointsLoading ? t('Reading data…') : t('Pick an endpoint')"
          :disabled="endpointOptions.length === 0"
          :aria-label="fieldLabel('endpoint')"
          block
        />
      </label>
    </template>

    <p v-if="emptyReason" class="mep-empty">{{ emptyReason }}</p>
  </div>
</template>

<style scoped>
.mep {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  align-items: flex-end;
}
.mep-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 180px;
  flex: 1 1 180px;
}
.mep-label {
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--sw-fg-3);
}
.mep-input {
  width: 100%;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--sw-fg-0);
  background: var(--sw-bg-0);
  border: 1px solid var(--sw-line);
  border-radius: 4px;
}
.mep-input:focus {
  outline: none;
  border-color: var(--sw-accent);
}
.mep-locked {
  display: block;
  padding: 4px 10px;
  font-family: var(--sw-mono);
  font-size: 12px;
  color: var(--sw-fg-1);
  background: var(--sw-bg-3);
  border: 1px solid var(--sw-line);
  border-radius: 4px;
}
.mep-empty {
  flex: 1 1 100%;
  margin: 0;
  font-size: 11.5px;
  color: var(--sw-fg-3);
}
</style>
