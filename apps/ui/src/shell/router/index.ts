/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '@/state/auth';
import { pushEvent } from '@/controls/eventLog';
import { setPreviewMode, usePreviewMode, getPreviewSource } from '@/controls/previewMode';

const placeholder = () => import('@/shell/PlaceholderView.vue');

// Layer sub-routes nest under a single LayerShell route so every tab
// shares the header KPI strip + cap-driven tab navigation. The shell
// reads `:layerKey` from the URL and pulls layer config / live data.
// Sub-route components fill the tab body via a nested router-view; the
// canonical landing is `/service`.
function layerRoute(): RouteRecordRaw {
  return {
    path: 'layer/:layerKey',
    component: () => import('@/layer/LayerShell.vue'),
    children: [
      { path: '', redirect: (to) => ({ path: `/layer/${to.params.layerKey}/service` }) },
      // Same view component, scope inferred from the URL — widget set
      // differs per scope via the JSON template's `dashboards.<scope>` array.
      { path: 'service', component: () => import('@/render/layer-dashboard/LayerDashboardsView.vue') },
      { path: 'instance', component: () => import('@/render/layer-dashboard/LayerDashboardsView.vue') },
      { path: 'endpoint', component: () => import('@/render/layer-dashboard/LayerDashboardsView.vue') },
      {
        path: 'topology',
        component: () => import('@/layer/service-map/LayerTopologyTab.vue'),
        // The page owns its own in-box service-focus selector, so
        // `ownsServiceSelector` keeps the LayerShell header picker hidden
        // for this route — no route-string sniffing in the shell.
        meta: { ownsServiceSelector: true },
      },
      { path: 'dependency', component: () => import('@/layer/endpoint-dependency/LayerEndpointDependencyView.vue') },
      // Service-scoped, so it deliberately does NOT set
      // `ownsServiceSelector`: the shell's Service header picker stays
      // visible and the view reads `useSelectedService`.
      { path: 'deployment', component: () => import('@/layer/service-map/LayerDeploymentView.vue') },
      // `LayerTracesEntry` is a runtime dispatcher: it inspects the
      // layer template's `traces.source` and renders either the native
      // trace view or the Zipkin one. Both views read the shell-level
      // service selection via `useSelectedService`, so `ownsServiceSelector`
      // stays OFF and the LayerShell Switch picker stays visible.
      { path: 'trace', component: () => import('@/layer/traces/LayerTracesEntry.vue') },
      // Second trace tab — only surfaced when the layer's `traces.source`
      // is `both`. Native + Zipkin spans differ in format and query
      // conditions, so they get separate tabs rather than an in-tab toggle.
      // The entry component renders the Zipkin view for this path regardless.
      { path: 'zipkin-trace', component: () => import('@/layer/traces/LayerTracesEntry.vue') },
      { path: 'logs', component: () => import('@/layer/logs/LayerLogsView.vue') },
      // BROWSER-layer JS error logs + source-map de-obfuscation (#6784).
      { path: 'browser-errors', component: () => import('@/layer/browser-errors/LayerBrowserErrorsView.vue') },
      // On-demand pod logs (live tail). Instance-pinned; only K8s-
      // deployed layers (caps.podLogs) surface the tab in the sidebar.
      { path: 'pod-logs', component: () => import('@/layer/pod-logs/LayerPodLogsView.vue') },
      { path: 'trace-profiling', component: () => import('@/layer/profiling/LayerTraceProfilingView.vue') },
      { path: 'ebpf-profiling', component: () => import('@/layer/profiling/LayerEBPFProfilingView.vue') },
      { path: 'async-profiling', component: () => import('@/layer/profiling/LayerAsyncProfilingView.vue') },
      { path: 'network-profiling', component: () => import('@/layer/profiling/LayerNetworkProfilingView.vue') },
      { path: 'pprof', component: () => import('@/layer/profiling/LayerPprofProfilingView.vue') },
      // Old single-profiling URL → redirect to the trace-profiling page
      // for back-compat with bookmarks taken before the split.
      {
        path: 'profiling',
        redirect: (to) => ({ path: `/layer/${to.params.layerKey}/trace-profiling`, query: to.query }),
      },
      // Legacy routes redirect to /service.
      {
        path: 'services',
        redirect: (to) => ({ path: `/layer/${to.params.layerKey}/service`, query: to.query }),
      },
      {
        // Service id is no longer URL-pinned (picked on landing), so the
        // legacy /services/<id> form forwards to the bare service tab.
        path: 'services/:serviceId',
        redirect: (to) => ({ path: `/layer/${to.params.layerKey}/service` }),
      },
      {
        path: 'dashboards',
        redirect: (to) => ({ path: `/layer/${to.params.layerKey}/service`, query: to.query }),
      },
      {
        path: 'instances',
        redirect: (to) => ({ path: `/layer/${to.params.layerKey}/instance`, query: to.query }),
      },
      {
        path: 'endpoints',
        redirect: (to) => ({ path: `/layer/${to.params.layerKey}/endpoint`, query: to.query }),
      },
      {
        path: 'traces',
        redirect: (to) => ({ path: `/layer/${to.params.layerKey}/trace`, query: to.query }),
      },
    ],
  };
}

const shellRoutes: RouteRecordRaw[] = [
  { path: '', name: 'overview', component: () => import('@/render/overview/OverviewLanding.vue') },
  {
    path: 'overview/:id',
    name: 'overview-dashboard',
    component: () => import('@/render/overview/OverviewDashboardView.vue'),
  },
  /* Empty-landing surface. The root `/` cascade always picks a real
   * destination, so this is the only path that renders the
   * "nothing-here-yet" card — useful for reviewing the empty state and
   * as the visible fallback for a viewer in a deployment with no
   * configured dashboards. Same component as `/`, distinguished by
   * route name. */
  { path: 'landing-empty', name: 'landing-empty', component: () => import('@/render/overview/OverviewLanding.vue') },
  /* Legacy `/setup` route — the read-only "Overview dashboards"
   * browser was replaced by `/admin/overview-templates` which both
   * lists AND edits. Redirect rather than 404 so old bookmarks /
   * stale links land somewhere useful. */
  { path: 'setup', redirect: '/admin/overview-templates' },
  layerRoute(),
  // Alarms — independent page (not a layer template / overview).
  // OAP `getAlarm` proxy + background-traffic timeline + per-layer
  // grouping. Read-only; OAP auto-recovers, no acknowledge / silence.
  { path: 'alarms', name: 'alarms', component: () => import('@/features/alarms/AlarmsView.vue') },
  // 3D Infra Map lives as a TOP-LEVEL standalone route OUTSIDE
  // AppShell (see the createRouter call below). The shellRoutes entry
  // here is kept only so reverse-route lookups by name (`infra-3d-map`)
  // continue to resolve, redirecting to the standalone path.
  { path: '3d/map', redirect: '/3d/map' },
  {
    path: 'operate/cluster',
    component: () => import('@/features/operate/cluster/ClusterStatusView.vue'),
    meta: { verb: 'cluster:read' },
  },
  // Alerting rules — read-only catalog backed by admin /status/alarm/*.
  // Gated on admin-server reachability at the page-body level.
  {
    path: 'operate/alerting-rules',
    name: 'alerting-rules',
    component: () => import('@/features/operate/alerting-rules/AlertingRulesView.vue'),
    meta: { verb: 'alarm-rule:read' },
  },
  // Static sub-routes are declared first so they aren't shadowed by
  // the catalog alternation regex (which would otherwise grab `edit`
  // / `dump`). Each gated on `receiver-runtime-rule` at the page-body
  // level via AdminFeatureWarning.
  {
    path: 'operate/dsl/edit',
    name: 'edit',
    component: () => import('@/features/operate/dsl/DslEditorView.vue'),
    meta: { verb: 'rule:read' },
  },
  {
    path: 'operate/dsl/dump',
    name: 'dump',
    component: () => import('@/features/operate/dsl/DslDumpView.vue'),
    meta: { verb: 'rule:read' },
  },
  {
    path: 'operate/dsl/:catalog(otel-rules|telegraf-rules|lal|log-mal-rules)',
    name: 'catalog',
    component: () => import('@/features/operate/dsl/DslCatalogView.vue'),
    props: true,
    meta: { verb: 'rule:read' },
  },
  {
    path: 'operate/oal',
    name: 'oal-catalog',
    component: () => import('@/features/operate/dsl/OalCatalogView.vue'),
    meta: { verb: 'rule:read' },
  },
  // Inspect — gated on the `inspect` module (and `receiver-runtime-rule`
  // for rule attribution; degrades cleanly to "unknown" attribution
  // when admin-server is missing).
  {
    path: 'operate/inspect',
    name: 'inspect',
    component: () => import('@/features/operate/inspect/InspectView.vue'),
    meta: { verb: 'inspect:read' },
  },
  // Trace inspect / Log inspect — cross-layer trace/log query power-tools.
  // Layer-less: the entity is picked or typed (name + real flag) or
  // omitted; dispatched by source via /api/explore/query. They use the
  // standard query-protocol (always on), so — unlike Metrics inspect —
  // they are NOT gated on the OAP inspect module.
  {
    path: 'operate/trace-inspect',
    name: 'trace-inspect',
    component: () => import('@/features/operate/explore/ExploreView.vue'),
    meta: { verb: 'inspect:read' },
  },
  {
    path: 'operate/log-inspect',
    name: 'log-inspect',
    component: () => import('@/features/operate/explore/ExploreLogView.vue'),
    meta: { verb: 'inspect:read' },
  },
  // Data retention (TTL) — query-port read of getRecordsTTL/getMetricsTTL.
  {
    path: 'operate/ttl',
    name: 'ttl',
    component: () => import('@/features/operate/ttl/TtlView.vue'),
    meta: { verb: 'ttl:read' },
  },
  // OAP runtime config — admin-port /debugging/config/dump, read-only.
  {
    path: 'operate/config',
    name: 'oap-config',
    component: () => import('@/features/operate/config/ConfigView.vue'),
    meta: { verb: 'config:read' },
  },
  // Live debugger — gated on `dsl-debugging`. History is local-only
  // (browser localStorage) so it stays useful even when admin is down.
  // Declared before the catch-all tab route so it doesn't shadow.
  {
    path: 'operate/live-debug/history',
    name: 'debug-history',
    component: () => import('@/features/operate/live-debug/DebugHistoryView.vue'),
    meta: { verb: 'live-debug:read' },
  },
  {
    path: 'operate/live-debug/:tab(mal|lal|oal)?',
    name: 'live-debugger',
    component: () => import('@/features/operate/live-debug/LiveDebuggerView.vue'),
    meta: { verb: 'live-debug:read' },
  },
  {
    path: 'admin/layer-dashboards',
    component: () => import('@/features/admin/layer-templates/LayerDashboardsAdmin.vue'),
    meta: { verb: 'dashboard:read' },
  },
  // Alert page setup — sits under Dashboard setup in the sidebar but
  // routes off the admin tree since it's an operator-only config view.
  {
    path: 'admin/alert-page-setup',
    name: 'alert-page-setup',
    component: () => import('@/features/admin/alert-page/AlertPageSetupView.vue'),
    meta: { verb: 'alarm-setup:read' },
  },
  // Global defaults — theme + time-defaults combined. Two OAP singletons
  // edited in one place because they share the "set once and leave" cadence.
  {
    path: 'admin/global-defaults',
    name: 'global-defaults',
    component: () => import('@/features/admin/global-defaults/GlobalDefaultsAdmin.vue'),
    meta: { verb: 'setup:read' },
  },
  {
    path: 'admin/3d-map',
    name: 'admin-3d-map',
    component: () => import('@/features/admin/infra-3d/Infra3dAdminView.vue'),
    // The config is a template kind published via the generic template-sync
    // API (overview:write) — gate the editor on the same verb so page
    // visibility matches what the push actually requires.
    meta: { verb: 'overview:write' },
  },
  {
    path: 'admin/overview-templates',
    name: 'overview-templates',
    component: () => import('@/features/admin/overview-templates/OverviewTemplatesAdmin.vue'),
    meta: { verb: 'overview:write' },
  },
  {
    path: 'admin/translations',
    name: 'translations',
    component: () => import('@/features/admin/translations/TranslationsView.vue'),
    meta: { verb: 'overview:write' },
  },
  {
    path: 'admin/users',
    name: 'admin-users',
    component: () => import('@/features/admin/users/UsersAdminView.vue'),
    meta: { verb: 'user:read' },
  },
  {
    path: 'admin/auth-status',
    name: 'admin-auth-status',
    component: () => import('@/features/admin/auth-status/AuthStatusView.vue'),
    meta: { verb: 'auth:read' },
  },
  {
    path: 'admin/roles',
    name: 'admin-roles',
    component: () => import('@/features/admin/roles/RolesView.vue'),
    meta: { verb: 'role:read' },
  },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/features/auth/LoginView.vue'),
      meta: { public: true },
    },
    // 3D Infra Map — standalone fullscreen route OUTSIDE the AppShell.
    // No sidebar, no topbar, no time-range ticker, no global refresh —
    // the 3D scene owns the viewport. Operators land directly on the
    // map; the SkyWalking logo at the bottom-left is the only chrome.
    // Still requires authentication (handled by the global beforeEach
    // guard below), so `meta.public` stays false.
    {
      path: '/3d/map',
      name: 'infra-3d-map',
      component: () => import('@/features/infra-3d/Infra3DView.vue'),
    },
    // AI Assistant — the roomy full-page mode of the chat. A standalone fullscreen
    // route OUTSIDE the AppShell (max canvas for wide charts, tab-grouped figures and
    // pinned sub-pages) sharing the same conversation + localStorage history as the
    // docked drawer. Requires auth via the global guard; the `ai:read` verb lands with
    // the BFF (M2), so no `meta.verb` yet.
    {
      path: '/ai',
      name: 'ai',
      component: () => import('@/ai/AiFullPageView.vue'),
    },
    {
      path: '/',
      component: () => import('@/shell/AppShell.vue'),
      children: shellRoutes,
    },
    {
      path: '/:catchAll(.*)*',
      component: placeholder,
      props: { title: 'Not found', phase: 'never', note: 'No route matches.' },
    },
  ],
});

let bootstrapped = false;
router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!bootstrapped) {
    await auth.bootstrap();
    bootstrapped = true;
  }
  const isPublic = to.meta.public === true;
  if (!isPublic && !auth.isAuthenticated) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  if (to.name === 'login' && auth.isAuthenticated) {
    return { path: '/' };
  }
  // Verb gate: a route may declare `meta.verb`; an authenticated user
  // without it is bounced home. Defense-in-depth on top of the sidebar
  // hiding the link and the BFF enforcing the same verb per data route —
  // it stops a viewer reaching a maintainer page by URL or the topbar
  // OAP chip (where the page's data comes from shared `auth` endpoints
  // the BFF can't gate per-page).
  const requiredVerb = to.meta.verb as string | undefined;
  if (requiredVerb && auth.isAuthenticated && !auth.hasVerb(requiredVerb)) {
    return { path: '/' };
  }
});

// Every successful navigation posts a single "Navigated to X" line so
// the EventTicker shows when each page started loading. The event
// buffer is intentionally NOT cleared on navigation — operators want
// to see the cross-page history (last 200 events) so they can trace
// "I clicked here, then services loaded, then I clicked there".
// Preview mode (`?mode=preview&source=…`) is sticky within layer/overview
// pages: the sidebar tab links don't carry query params, so without this
// the overlay would drop the moment you navigate via the menu. We keep the
// flag on and re-apply the query to the URL so it both propagates AND stays
// visible. Leaving the layer/overview area turns preview off.
const previewMode = usePreviewMode();
const PREVIEWABLE = /^\/(layer|overview)\//;
router.afterEach((to, from) => {
  if (to.query.mode === 'preview') {
    setPreviewMode(true, typeof to.query.source === 'string' ? to.query.source : undefined);
  } else if (previewMode.value && PREVIEWABLE.test(to.path)) {
    // Menu navigation dropped the params — re-add them (no history entry).
    const src = getPreviewSource();
    void router.replace({
      path: to.path,
      query: { ...to.query, mode: 'preview', ...(src ? { source: src } : {}) },
    });
    return;
  } else {
    setPreviewMode(false);
  }
  if (to.path === from.path) return;
  pushEvent('route', 'info', `Navigated to ${to.path}`);
});

export default router;
