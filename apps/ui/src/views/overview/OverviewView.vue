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
<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { useLayers } from '@/composables/useLayers';
import { useLandingLayers } from '@/composables/useLandingOrder';
import LayerLandingCard from './LayerLandingCard.vue';

const { availableLayers, oapReachable, oapError, isLoading } = useLayers();
const enabledLayers = useLandingLayers(availableLayers);

// "No one opted in yet" → guide the operator to Setup before anything
// useful can render.
const empty = computed(() => !isLoading.value && enabledLayers.value.length === 0);
</script>

<template>
  <div class="overview">
    <header class="page-head">
      <div>
        <div class="kicker">Overview</div>
        <h1>Cross-layer landing</h1>
        <p class="lede">
          Auto-built from the layers you've enabled in
          <RouterLink to="/setup">Setup</RouterLink>, in the order each layer's priority defines.
          Each card shows the top services for that layer with its configured metrics.
        </p>
      </div>
    </header>

    <div v-if="!oapReachable && !isLoading" class="banner err">
      <strong>OAP unreachable.</strong>
      {{ oapError ?? 'Check that the OAP query host is up and reachable from the BFF.' }}
    </div>

    <div v-if="empty" class="empty">
      <div class="empty-card">
        <h2>Nothing on the landing yet</h2>
        <p v-if="availableLayers.length === 0">
          No layer is reporting services right now. Once data starts flowing through OAP, the
          layers appear in <RouterLink to="/setup">Setup</RouterLink> for you to enable here.
        </p>
        <p v-else>
          {{ availableLayers.length }} layer{{ availableLayers.length === 1 ? '' : 's' }} reporting,
          none enabled on the landing yet. Open <RouterLink to="/setup">Setup</RouterLink>, toggle
          "Show this layer on the landing" for the ones you care about, and they'll appear here in
          priority order.
        </p>
        <RouterLink class="sw-btn is-primary" to="/setup">
          Open Setup
        </RouterLink>
      </div>
    </div>

    <div v-else class="cards">
      <LayerLandingCard v-for="L in enabledLayers" :key="L.key" :layer="L" />
    </div>
  </div>
</template>

<style scoped>
.overview {
  padding: 20px 20px 60px;
  max-width: 1140px;
  margin: 0 auto;
}
.page-head {
  margin-bottom: 18px;
}
.kicker {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sw-accent);
  margin-bottom: 6px;
}
.page-head h1 {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--sw-fg-0);
  margin: 0 0 8px;
}
.lede {
  font-size: 12.5px;
  color: var(--sw-fg-1);
  line-height: 1.5;
  margin: 0;
  max-width: 720px;
}
.lede a {
  color: var(--sw-accent-2);
  text-decoration: none;
}
.banner.err {
  margin: 0 0 16px;
  padding: 10px 12px;
  background: var(--sw-err-soft);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  color: #f87171;
  font-size: 12px;
  line-height: 1.5;
}
.empty {
  margin-top: 20px;
}
.empty-card {
  background: var(--sw-bg-1);
  border: 1px dashed var(--sw-line-2);
  border-radius: 10px;
  padding: 28px;
  text-align: center;
  max-width: 600px;
  margin: 0 auto;
}
.empty-card h2 {
  font-size: 15px;
  color: var(--sw-fg-0);
  margin: 0 0 8px;
}
.empty-card p {
  font-size: 12px;
  color: var(--sw-fg-2);
  margin: 0 0 16px;
  line-height: 1.5;
}
.empty-card .sw-btn {
  display: inline-flex;
  text-decoration: none;
}
.empty-card a {
  color: var(--sw-accent-2);
  text-decoration: none;
}
.cards {
  display: flex;
  flex-direction: column;
}
</style>
