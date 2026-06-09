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
  Per-layer Topology tab shell. The service map is the page; the instance
  map is a drill-down reached by clicking a call edge → "Instance map →"
  (which sets `?view=instance&client=&server=`). There is deliberately no
  Service-map/Instance-map tab toggle — the instance map is an in-context
  drill-down with its own "back to service map" affordance, not a
  standalone entrance. A stray `?view=instance` on a layer that doesn't
  enable instance topology falls back to the service map.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import type { LayerDef } from '@/api/client';
import { useLayers } from '@/shell/useLayers';
import LayerServiceMapView from '@/layer/service-map/LayerServiceMapView.vue';
import LayerInstanceTopologyView from '@/layer/service-map/LayerInstanceTopologyView.vue';

const route = useRoute();
const layerKey = computed(() => String(route.params.layerKey ?? ''));
const { layers } = useLayers();
const layer = computed<LayerDef | null>(() => layers.value.find((l) => l.key === layerKey.value) ?? null);
const showInstance = computed(
  () => Boolean(layer.value?.caps?.instanceTopology) && route.query.view === 'instance',
);
</script>

<template>
  <LayerInstanceTopologyView v-if="showInstance" />
  <LayerServiceMapView v-else />
</template>
