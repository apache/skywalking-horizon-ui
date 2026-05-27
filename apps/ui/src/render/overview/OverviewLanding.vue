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
import { computed, ref, watchEffect } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useOverviewDashboards } from '@/render/overview/useOverviewDashboards';
import { firstLayerTab, useLayers } from '@/shell/useLayers';

const { t } = useI18n({ useScope: 'global' });
const router = useRouter();
const route = useRoute();
const { publicOverviews, isLoading: overviewsLoading } = useOverviewDashboards();
const {
  oapReachable,
  oapError,
  availableLayers,
  isLoading: layersLoading,
  refetch: refetchLayers,
} = useLayers();

/** Render the empty card (no redirect cascade) when the route is the
 *  dedicated `/landing-empty` path — set either by a direct visit or
 *  by the cascade itself when there's nothing to land on. */
const forceEmpty = computed<boolean>(() => route.name === 'landing-empty');

/** Block dashboard render when OAP is unreachable. The landing page
 *  is the only surface that fully blocks (per the team policy — see
 *  PR #19 thread): per-layer pages still show their bundled-fallback
 *  view so an operator can verify a template they just edited.
 *  Cascade is suppressed alongside so we don't redirect into an
 *  empty overview / layer page that would just re-show the same
 *  error one level deeper. */
const blockForOapDown = computed<boolean>(
  () => !oapReachable.value && !overviewsLoading.value && !layersLoading.value,
);

const retrying = ref(false);
async function retryOap(): Promise<void> {
  if (retrying.value) return;
  retrying.value = true;
  try {
    await refetchLayers();
  } finally {
    retrying.value = false;
  }
}

watchEffect(() => {
  // Wait for both data sources — without `layers`, a fresh boot would
  // briefly fall through while the menu is still in flight.
  if (overviewsLoading.value || layersLoading.value) return;
  // OAP down → freeze the cascade so the operator sits on the warning
  // page until they retry (or background refetch lands a success).
  if (blockForOapDown.value) return;
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
    <!-- OAP query host unreachable — render a full-page warning and
         freeze the redirect cascade. Distinct from `admin host
         unreachable` (which is acceptable: operators can still browse
         existing dashboards, admin pages drop to read-only). A dead
         query port means no service data anywhere, so showing an
         "empty" dashboard would mislead operators into chasing a
         dashboard-config problem when the real problem is upstream.
         Retry button re-runs the menu fetch; the topbar's global
         retry-poll also keeps firing in the background. -->
    <div v-if="blockForOapDown" class="oap-down">
      <div class="oap-down-card">
        <h2>{{ t('OAP query host is unreachable') }}</h2>
        <p>
          {{ oapError ?? t('Check that the OAP query host is up and reachable from the BFF. Dashboards stay hidden until OAP responds — bundled fallbacks would show empty data and look like a dashboard misconfiguration.') }}
        </p>
        <div class="oap-down-actions">
          <button type="button" class="sw-btn is-primary" :disabled="retrying" @click="retryOap">
            {{ retrying ? t('Retrying…') : t('Retry now') }}
          </button>
        </div>
        <p class="oap-down-foot">
          {{ t('Auto-retries every 30s in the background. Admin pages remain available in read-only mode.') }}
        </p>
      </div>
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
        <h2>{{ t('No data is flowing yet') }}</h2>
        <p>
          {{ t('OAP hasn\'t received any service data. The relevant overview will appear here automatically as soon as data starts arriving.') }}
        </p>
        <p class="empty-ask">
          {{ t('Ask your operations team to verify that the agents or receivers for your services are configured and pointing at this OAP.') }}
        </p>
      </div>
      <div v-else class="empty-card">
        <h2>{{ t('No dashboard configured yet') }}</h2>
        <p>
          {{ t('{n} layer reporting services but no overview dashboard is set up.', { n: availableLayers.length }) }}
        </p>
        <p class="empty-ask">
          {{ t('Ask your operations team to set up a dashboard for you.') }}
        </p>
      </div>
    </div>
    <div v-else class="empty">{{ t('Routing…') }}</div>
  </div>
</template>

<style scoped>
.landing { padding: 20px 20px 60px; max-width: 1440px; margin: 0 auto; }

/* OAP query host unreachable — full-page warning card replacing
 * the redirect cascade. Centered, large enough to be unmissable,
 * but not so loud the operator can't see the topbar banner above. */
.oap-down { padding: 60px 20px; display: flex; justify-content: center; }
.oap-down-card {
  max-width: 600px;
  width: 100%;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-err);
  border-left: 3px solid var(--sw-err);
  border-radius: 8px;
  padding: 28px;
  text-align: left;
}
.oap-down-card h2 {
  margin: 0 0 12px;
  font-size: var(--sw-fs-lg);
  color: var(--sw-err);
  font-weight: var(--sw-fw-semibold);
}
.oap-down-card p {
  margin: 0 0 16px;
  font-size: var(--sw-fs-base);
  color: var(--sw-fg-1);
  line-height: var(--sw-lh-relaxed);
}
.oap-down-foot {
  margin: 16px 0 0 !important;
  font-size: var(--sw-fs-sm) !important;
  color: var(--sw-fg-3) !important;
}
.oap-down-actions { display: flex; gap: 8px; }

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
