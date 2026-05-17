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
import { computed, onMounted } from 'vue';
import { RouterView } from 'vue-router';
import AppSidebar from './AppSidebar.vue';
import AppTopbar from './AppTopbar.vue';
import DebugEventPanel from './DebugEventPanel.vue';
import GlobalConnectivityBanner from './GlobalConnectivityBanner.vue';
import TracePopout from '@/layer/traces/TracePopout.vue';
import ZipkinTracePopout from '@/layer/traces/ZipkinTracePopout.vue';
import { ensureConfigBundle, useConfigBundle } from '@/controls/configBundle';
import { useClickTracking } from '@/controls/useClickTracking';
import { useLayers } from '@/shell/useLayers';
import { useDebugPanel } from '@/controls/debugPanel';

// Kick the config preload once the shell mounts (i.e. after the auth
// guard has let the user through). All layer dashboard configs +
// overview list arrive in one round-trip and land in localStorage so
// subsequent navigations read configs synchronously — no per-page
// spinner for what's effectively static template content.
onMounted(() => {
  void ensureConfigBundle();
});

// Global delegated click tracker — emits `click` events into the
// EventTicker so the timeline shows what the operator pressed before
// each framework load. See `controls/useClickTracking.ts` for the
// suppression rules (the ticker itself, form inputs, decorative bits).
useClickTracking();

// Init gate. The main zone (RouterView) waits until BOTH the layer
// registry and the dashboard-config bundle have settled, so on a
// login → deep-URL redirect the user sees a single shell-level
// "initializing…" placeholder instead of every page rendering
// against empty layer state and flashing its own "not found"
// fallback. We treat an OAP-unreachable settle as "ready" too — the
// app proceeds in degraded mode and GlobalConnectivityBanner takes
// over the messaging. The sidebar + topbar stay mounted throughout
// so the EventTicker can stream init progress.
const { layers, isLoading: layersLoading, isError: layersError } = useLayers();
const { loaded: bundleLoaded } = useConfigBundle();
const menuSettled = computed<boolean>(
  () => !layersLoading.value && (layers.value.length > 0 || layersError.value),
);
const initReady = computed<boolean>(
  () => menuSettled.value && bundleLoaded.value,
);

// Reserve bottom padding on the main pane equal to the panel's
// collapsed height when the debug panel is enabled, so the panel
// doesn't overlay page content. The expanded popover is still a
// transient overlay (operator dismisses it explicitly) — reserving
// 260px permanently would waste real estate.
const { enabled: debugPanelEnabled } = useDebugPanel();
</script>

<template>
  <div class="sw">
    <AppSidebar />
    <AppTopbar />
    <main class="sw-main" :class="{ 'has-debug-panel': debugPanelEnabled }">
      <!-- Sticky strip under the topbar; only renders when the graphql
           (`:12800`) poll reports unreachable. Admin-port (`:17128`)
           failures render per-page via AdminFeatureWarning, not here. -->
      <GlobalConnectivityBanner />
      <!-- Shell-level init placeholder. Visible until the layer
           registry + config bundle have both loaded. Per-page code
           runs against fully-populated state from the first paint. -->
      <div v-if="!initReady" class="sw-init">
        <div class="sw-card sw-init-card">
          <h2>Initializing…</h2>
          <p>Loading layer registry and dashboard templates. Watch the topbar event line for progress.</p>
        </div>
      </div>
      <RouterView v-else />
    </main>
    <!-- Global trace-id popout: any page can call useTracePopout().openTrace(id)
         and this modal renders the waterfall + span detail. -->
    <TracePopout />
    <!-- Zipkin trace popout — separate URL key (`?openZipkinTraceId=`)
         so the native + Zipkin popouts can be open in parallel without
         collision (e.g. an operator drilling into a Zipkin trace from
         a Logs row → trace link on a mesh layer). -->
    <ZipkinTracePopout />
    <!-- Bottom-fixed framework-event panel. Self-hides when the Admin →
         "Debug events" toggle is off (default off in production, on
         when hostname looks local). Always mounted so the toggle
         responds without a re-mount race. -->
    <DebugEventPanel />
  </div>
</template>

<style scoped>
/* Reserve room for the collapsed DebugEventPanel (26px) when it's
 * enabled so the panel doesn't overlay page content. Expanded
 * popover stays a transient overlay — operators close it
 * explicitly, reserving its full 260px permanently would waste
 * vertical real estate. */
.sw-main.has-debug-panel { padding-bottom: 26px; }

.sw-init {
  padding: 48px 20px;
  display: flex;
  justify-content: center;
}
.sw-init-card {
  max-width: 480px;
  padding: 24px 28px;
  text-align: center;
}
.sw-init-card h2 {
  margin: 0 0 6px;
  font-size: 15px;
  color: var(--sw-fg-0);
}
.sw-init-card p {
  margin: 0;
  font-size: 12px;
  color: var(--sw-fg-2);
  line-height: 1.5;
}
</style>
