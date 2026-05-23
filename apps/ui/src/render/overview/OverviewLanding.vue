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
  Root landing. Resolves a sensible first destination via a cascade so
  the user never sees a blank "nothing to show" screen:

    1. First available public overview (already gated by service
       availability via `useOverviewDashboards`).
    2. Else first layer with services (`availableLayers`).
    3. Else first layer the BFF knows about (bundled template), even
       with no services yet — gives operators the layer page to land
       on while data is starting to flow.
    4. Else fall back to a page the user's verbs allow — `/alarms` is
       ungated for logged-in users; admins also land on the templates
       editor where they can configure the empty deployment.
-->
<script setup lang="ts">
import { computed, watchEffect } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useOverviewDashboards } from '@/render/overview/useOverviewDashboards';
import { firstLayerTab, useLayers } from '@/shell/useLayers';

const router = useRouter();
const route = useRoute();
const { publicOverviews, isLoading: overviewsLoading } = useOverviewDashboards();
const {
  oapReachable,
  oapError,
  availableLayers,
  isLoading: layersLoading,
} = useLayers();

/** Render the empty card (no redirect cascade) when the route is the
 *  dedicated `/landing-empty` path — set either by a direct visit or
 *  by the cascade itself when there's nothing to land on. */
const forceEmpty = computed<boolean>(() => route.name === 'landing-empty');

watchEffect(() => {
  // Wait for both data sources — without `layers`, a fresh boot would
  // briefly fall through while the menu is still in flight.
  if (overviewsLoading.value || layersLoading.value) return;
  // Direct visit to `/landing-empty` — render the card, no redirect.
  if (forceEmpty.value) return;

  // 1. First available public overview.
  const overview = publicOverviews.value[0];
  if (overview) {
    void router.replace({ name: 'overview-dashboard', params: { id: overview.id } });
    return;
  }

  // 2. First layer with services. We deliberately do NOT fall back to a
  //    bundled-but-inactive layer here: the sidebar filters layers by
  //    `serviceCount > 0`, so landing on an inactive layer would put
  //    the user on a page that doesn't appear in their menu (no way
  //    back). When no service-backed layer exists, the empty landing
  //    is the honest answer.
  const layer = availableLayers.value[0];
  if (layer) {
    void router.replace({ path: `/layer/${layer.key}/${firstLayerTab(layer)}` });
    return;
  }

  // 3. No overview, no service-backed layer — show the empty landing
  //    automatically. Same component re-mounts with
  //    `route.name === 'landing-empty'` so the watchEffect short-
  //    circuits next tick (no redirect loop).
  void router.replace({ name: 'landing-empty' });
});
</script>

<template>
  <div class="landing">
    <div v-if="!oapReachable && !overviewsLoading && !layersLoading" class="banner err">
      <strong>OAP unreachable.</strong>
      {{ oapError ?? 'Check that the OAP query host is up and reachable from the BFF.' }}
    </div>
    <!-- Empty landing — rendered for the dedicated `/landing-empty`
         route. Cascade lands here automatically when there's no
         available overview and no available layer dashboard. Two
         distinct empty states with distinct messaging:

           - no services reported → it's a data problem (agents /
             receivers), not a dashboard problem.
           - services reported but no overview configured → it's a
             dashboard problem.
    -->
    <div v-else-if="forceEmpty" class="empty">
      <div v-if="availableLayers.length === 0" class="empty-card">
        <h2>No data is flowing yet</h2>
        <p>
          OAP hasn't received any service data. The relevant overview will appear here
          automatically as soon as data starts arriving.
        </p>
        <p class="empty-ask">
          Ask your operations team to verify that the agents or receivers for your
          services are configured and pointing at this OAP.
        </p>
      </div>
      <div v-else class="empty-card">
        <h2>No dashboard configured yet</h2>
        <p>
          {{ availableLayers.length }} layer{{ availableLayers.length === 1 ? '' : 's' }}
          {{ availableLayers.length === 1 ? 'is' : 'are' }} reporting services, but no
          overview dashboard has been set up for them.
        </p>
        <p class="empty-ask">
          Ask your operations team to set up a dashboard for you.
        </p>
      </div>
    </div>
    <div v-else class="empty">Routing…</div>
  </div>
</template>

<style scoped>
.landing { padding: 20px 20px 60px; max-width: 1440px; margin: 0 auto; }
.banner.err {
  margin: 0 0 16px; padding: 10px 12px;
  background: var(--sw-err-soft);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px; color: #f87171; font-size: 12px; line-height: 1.5;
}
.empty { padding: 60px 20px; text-align: center; color: var(--sw-fg-3); font-size: 13px; }
.empty-card {
  background: var(--sw-bg-1);
  border: 1px dashed var(--sw-line-2);
  border-radius: 10px;
  padding: 28px;
  text-align: center;
  max-width: 600px;
  margin: 0 auto;
}
.empty-card h2 { font-size: 15px; color: var(--sw-fg-0); margin: 0 0 8px; }
.empty-card p { font-size: 12px; color: var(--sw-fg-2); margin: 0 0 16px; line-height: 1.5; }
.empty-ask {
  margin-top: 18px !important;
  font-size: 12.5px !important;
  color: var(--sw-fg-1) !important;
  font-weight: 500;
}
</style>
