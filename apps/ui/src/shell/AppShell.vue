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
import { computed, onMounted, ref } from 'vue';
import { RouterView } from 'vue-router';
import { useI18n } from 'vue-i18n';
import AppSidebar from './AppSidebar.vue';
import AppTopbar from './AppTopbar.vue';
import DebugEventPanel from './DebugEventPanel.vue';
import GlobalConnectivityBanner from './GlobalConnectivityBanner.vue';
import ColdStageTrapBanner from './ColdStageTrapBanner.vue';
import PreviewModeBanner from './PreviewModeBanner.vue';
import TracePopout from '@/layer/traces/TracePopout.vue';
import EventsPopout from '@/features/events/EventsPopout.vue';
import ZipkinTracePopout from '@/layer/traces/ZipkinTracePopout.vue';
import TemplateConflictPrompt from './TemplateConflictPrompt.vue';
import { ensureConfigBundle, useConfigBundle } from '@/controls/configBundle';
import { useClickTracking } from '@/controls/useClickTracking';
import { useLayers } from '@/shell/useLayers';
import { useDebugPanel } from '@/controls/debugPanel';
import { useSidebar } from '@/controls/sidebar';
import { useThemeStore } from '@/state/theme';
import { useTimeDefaultsStore } from '@/state/timeDefaults';
import { useTimeRangeStore } from '@/controls/timeRange';
import { watch } from 'vue';

// Both stores expose 3-tier resolution (user pref in localStorage → OAP
// → bundled); at construction they reflect user pref + bundled fallback,
// and loadOrgDefault (onMounted) fills the OAP tier once auth is through.
const themeStore = useThemeStore();
const timeDefaultsStore = useTimeDefaultsStore();
const timeRangeStore = useTimeRangeStore();

// The time-range store is constructed with a static `'1h'` default; this
// watch promotes the resolved time-default over it ONCE — subsequent
// operator picks on the time picker stay sticky.
let timeDefaultsApplied = false;
watch(
  () => timeDefaultsStore.defaultWindowMinutes,
  (m) => {
    if (timeDefaultsApplied) return;
    timeRangeStore.selectByMinutes(m);
    timeDefaultsApplied = true;
  },
  { immediate: true },
);

// All layer dashboard configs + overview list arrive in one round-trip
// and land in localStorage, so subsequent navigations read configs
// synchronously — no per-page spinner for static template content.
onMounted(() => {
  void ensureConfigBundle();
  void themeStore.loadOrgDefault();
  void timeDefaultsStore.loadOrgDefault();
});

const { t } = useI18n({ useScope: 'global' });

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

const { enabled: debugPanelEnabled } = useDebugPanel();
// Drives the `.sw` grid column width — see `.sw.side-collapsed` below.
const { collapsed: sidebarCollapsed, width: sidebarWidth, setWidth: setSidebarWidth, resetWidth: resetSidebarWidth } = useSidebar();

// Drag-to-resize the expanded sidebar: a thin grab strip on the
// sidebar/main boundary drives `--sw-side-w` (persisted in useSidebar).
// Listeners live on `window` so the drag survives the cursor leaving the
// 6px strip; no-op while collapsed.
const resizingSidebar = ref(false);
function startSidebarResize(e: PointerEvent): void {
  if (sidebarCollapsed.value) return;
  e.preventDefault();
  resizingSidebar.value = true;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  const onMove = (ev: PointerEvent): void => setSidebarWidth(ev.clientX);
  const onUp = (): void => {
    resizingSidebar.value = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}
</script>

<template>
  <div class="sw" :class="{ 'side-collapsed': sidebarCollapsed, resizing: resizingSidebar }" :style="{ '--sw-side-w': sidebarWidth + 'px' }">
    <AppSidebar />
    <AppTopbar />
    <div
      v-if="!sidebarCollapsed"
      class="sw-resize"
      title="Drag to resize · double-click to reset"
      @pointerdown="startSidebarResize"
      @dblclick="resetSidebarWidth"
    />
    <main class="sw-main" :class="{ 'has-debug-panel': debugPanelEnabled }">
      <!-- Sticky strip under the topbar; only renders when the graphql
           (`:12800`) poll reports unreachable. Admin-port (`:17128`)
           failures render per-page via AdminFeatureWarning, not here. -->
      <GlobalConnectivityBanner />
      <!-- Renders only on BanyanDB when the Cold pill is ON AND the picked
           range overlaps hot+warm, where cold returns empty — explains why
           widgets went blank and offers a one-click "turn Cold off". -->
      <ColdStageTrapBanner />
      <PreviewModeBanner />
      <div v-if="!initReady" class="sw-init">
        <div class="sw-card sw-init-card">
          <h2>{{ t('Initializing…') }}</h2>
          <p>{{ t('Loading layer registry and dashboard templates. Watch the topbar event line for progress.') }}</p>
        </div>
      </div>
      <RouterView v-else />
    </main>
    <!-- Global trace-id popout: any page can call useTracePopout().openTrace(id)
         and this modal renders the waterfall + span detail. -->
    <TracePopout />
    <!-- Shares `?traceId=`; native vs Zipkin self-select by ID shape
         (see isZipkinTraceId). -->
    <ZipkinTracePopout />
    <!-- Per-service events popout: a layer's service banner calls
         useEventsPopout().open(layer, service) to peek that service's
         instance events without leaving the page. -->
    <EventsPopout />
    <TemplateConflictPrompt />
    <!-- Always mounted (even when hidden) so the Admin "Debug events"
         toggle responds without a re-mount race. -->
    <DebugEventPanel />
  </div>
</template>

<style scoped>
/* Reserve room for the collapsed DebugEventPanel (26px); the expanded
 * popover stays a transient overlay, so we don't reserve its full 260px. */
.sw-main.has-debug-panel { padding-bottom: 26px; }

/* Collapse the grid's side column to a thin rail; the sidebar's own
 * scoped styles hide nav/labels at this width (see `.sw-side.collapsed`). */
.sw.side-collapsed { grid-template-columns: 48px 1fr; }
.sw { transition: grid-template-columns 160ms ease; }
/* During a drag the column must follow the cursor 1:1, not lag the ease. */
.sw.resizing { transition: none; }

.sw-resize {
  position: absolute;
  top: 0;
  bottom: 0;
  left: calc(var(--sw-side-w, 220px) - 3px);
  width: 6px;
  z-index: 50;
  cursor: col-resize;
}
.sw-resize:hover,
.sw-resize:active {
  background: var(--sw-accent-line);
}

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
