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

// Eager-load the theme + time-defaults org defaults so the renderer
// has the right `<html data-theme>` and the right default window for
// the first paint. Both stores expose 3-tier resolution (user pref
// in localStorage → OAP → bundled) — at construction they already
// reflect the user pref + bundled fallback; this call fills the OAP
// tier as soon as auth is through.
const themeStore = useThemeStore();
const timeDefaultsStore = useTimeDefaultsStore();
const timeRangeStore = useTimeRangeStore();

// Apply the resolved time-defaults to the live time-range store as
// soon as it lands. The time-range store is constructed with a static
// `'1h'` default; this watch promotes the resolved value (user pref →
// OAP → bundled) over that. Subsequent operator picks on the time
// picker stay sticky — we don't override an explicit selection.
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

// Kick the config preload once the shell mounts (i.e. after the auth
// guard has let the user through). All layer dashboard configs +
// overview list arrive in one round-trip and land in localStorage so
// subsequent navigations read configs synchronously — no per-page
// spinner for what's effectively static template content.
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

// Reserve bottom padding on the main pane equal to the panel's
// collapsed height when the debug panel is enabled, so the panel
// doesn't overlay page content. The expanded popover is still a
// transient overlay (operator dismisses it explicitly) — reserving
// 260px permanently would waste real estate.
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
    <!-- Drag handle on the sidebar/main boundary; hidden when collapsed.
         Double-click resets to the default width. -->
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
      <!-- Cold-only-with-recent-range warning. Renders only on BanyanDB
           when the operator has the Cold pill ON AND the picked time
           range overlaps hot+warm (where cold returns empty). Loudly
           tells the operator why widgets went blank and offers a
           one-click "turn Cold off". -->
      <ColdStageTrapBanner />
      <!-- Notice shown only while a page is in ?mode=preview. -->
      <PreviewModeBanner />
      <!-- Shell-level init placeholder. Visible until the layer
           registry + config bundle have both loaded. Per-page code
           runs against fully-populated state from the first paint. -->
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
    <!-- Zipkin trace popout — shares `?traceId=`; native vs Zipkin
         self-select by ID shape (see isZipkinTraceId). -->
    <ZipkinTracePopout />
    <!-- Per-session prompt: when local template edits diverge from OAP,
         ask once which version to render (local preview vs remote live). -->
    <TemplateConflictPrompt />
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

/* Folded sidebar — collapse the grid's side column to a thin rail that
 * holds just the expand affordance. The sidebar's own scoped styles
 * hide the nav/labels at this width (see AppSidebar `.sw-side.collapsed`).
 * Animates in step with the sidebar's own collapse transition. */
.sw.side-collapsed { grid-template-columns: 48px 1fr; }
.sw { transition: grid-template-columns 160ms ease; }
/* During a drag the column must follow the cursor 1:1, not lag through
 * the collapse ease. */
.sw.resizing { transition: none; }

/* Drag-to-resize handle straddling the sidebar/main boundary. Tracks
 * `--sw-side-w` live as the operator drags. Full height so it's easy to
 * grab; transparent until hovered/active. While dragging the grid
 * transition is suppressed (the column should follow the cursor 1:1,
 * not lag through the 160ms ease). */
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
