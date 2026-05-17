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
  Root landing. Resolves the first public overview dashboard available
  in this deployment and redirects there. The cross-layer KPI strip
  that used to live here has been retired — every overview is now a
  named dashboard under `/overview/:id`.
-->
<script setup lang="ts">
import { watchEffect } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { useOverviewDashboards } from '@/render/overview/useOverviewDashboards';
import { useLayers } from '@/shell/useLayers';

const router = useRouter();
const { publicOverviews, isLoading } = useOverviewDashboards();
const { oapReachable, oapError, availableLayers } = useLayers();

watchEffect(() => {
  if (isLoading.value) return;
  const first = publicOverviews.value[0];
  if (first) {
    void router.replace({ name: 'overview-dashboard', params: { id: first.id } });
  }
});
</script>

<template>
  <div class="landing">
    <div v-if="!oapReachable && !isLoading" class="banner err">
      <strong>OAP unreachable.</strong>
      {{ oapError ?? 'Check that the OAP query host is up and reachable from the BFF.' }}
    </div>
    <div v-else-if="isLoading" class="empty">Loading…</div>
    <div v-else-if="publicOverviews.length === 0" class="empty">
      <div class="empty-card">
        <h2>No public overview is currently active</h2>
        <p v-if="availableLayers.length === 0">
          No layer is reporting services yet. Once data flows through OAP, the relevant
          overview (Services / Mesh / …) will appear here automatically.
        </p>
        <p v-else>
          The deployment is reporting on
          {{ availableLayers.length }} layer{{ availableLayers.length === 1 ? '' : 's' }},
          but no overview is set to <code>visibility: public</code>. Operations-only
          overviews are reachable from the Admin section in the sidebar.
        </p>
        <RouterLink class="sw-btn is-primary" to="/admin/overview-templates">
          Open Overview templates
        </RouterLink>
      </div>
    </div>
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
.empty-card code {
  font-family: var(--sw-mono); font-size: 11px;
  padding: 0 4px; border-radius: 3px;
  background: var(--sw-bg-2); color: var(--sw-fg-1);
}
.empty-card .sw-btn { display: inline-flex; text-decoration: none; }
</style>
