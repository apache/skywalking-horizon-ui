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
  Per-layer Traces tab dispatcher. Routes `/layer/:key/trace` to either
  `LayerTracesView.vue` (SkyWalking-native) or `LayerZipkinTracesView.vue`
  based on the layer template's `traces.source` flag.

  The router can't make this decision statically (it has no menu data
  at route-resolve time), so this dispatcher reads `useLayers()`
  client-side and swaps the inner component.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import type { LayerDef } from '@skywalking-horizon-ui/api-client';
import { useLayers } from '@/shell/useLayers';
import LayerTracesView from './LayerTracesView.vue';
import LayerZipkinTracesView from './LayerZipkinTracesView.vue';
import { traceRowIsZipkin } from '@skywalking-horizon-ui/api-client';

const route = useRoute();
const layerKey = computed(() => String(route.params.layerKey ?? ''));
const { layers } = useLayers();
const layer = computed<LayerDef | null>(() => layers.value.find((l) => l.key === layerKey.value) ?? null);



/**
 * Which trace store to render. Native and Zipkin spans have different formats
 * and query conditions, so a layer that names both stores gets TWO sidebar
 * rows — `/trace` and `/zipkin-trace` — rather than one row with an in-place
 * toggle. This entry is route-driven:
 *   - the `/zipkin-trace` route always renders the Zipkin view;
 *   - the `/trace` route renders Zipkin only for a layer that names the Zipkin
 *     store and no native one.
 */
const isZipkinRoute = computed(() => /\/zipkin-trace(\/|$|\?)/.test(route.path));
const showZipkin = computed(
  () => isZipkinRoute.value || traceRowIsZipkin(layer.value?.traces),
);
</script>

<template>
  <div class="trc-entry">
    <LayerZipkinTracesView v-if="showZipkin" />
    <LayerTracesView v-else />
  </div>
</template>

<style scoped>
.trc-entry { display: flex; flex-direction: column; gap: 8px; }
</style>
