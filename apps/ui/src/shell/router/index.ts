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

const placeholder = () => import('@/shell/PlaceholderView.vue');

function humanKey(k: string): string {
  return k.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Layer sub-routes nest under a single LayerShell route so every tab
// shares the header KPI strip + cap-driven tab navigation. The shell
// reads `:layerKey` from the URL and pulls layer config / live data.
// Sub-route components fill the tab body via a nested router-view.
function layerRoute(): RouteRecordRaw {
  // Per-layer sub-routes that still render generic placeholders until
  // their phases land. The canonical landing is `/service` — that's
  // the widget-grid view operators see when they click a layer.
  // Tabs that still don't have a per-scope dashboard set. Topology +
  // dependency + logs need their own page treatments (Phase 4 / 5);
  // their JSON template `components.*` flag still gates the sidebar
  // entry, this just keeps the URL routing legible.
  const placeholderTabs: { path: string; label: string; phase: string }[] = [];
  return {
    path: 'layer/:layerKey',
    component: () => import('@/layer/LayerShell.vue'),
    children: [
      // Bare /layer/:layerKey lands on the Service view — the per-layer
      // widget grid driven by the dashboard config.
      { path: '', redirect: (to) => ({ path: `/layer/${to.params.layerKey}/service` }) },
      // Per-scope dashboards. Same view component, scope inferred from
      // the URL — widget set differs per scope via the JSON template's
      // `dashboards.<scope>` array.
      { path: 'service', component: () => import('@/render/layer-dashboard/LayerDashboardsView.vue') },
      { path: 'instance', component: () => import('@/render/layer-dashboard/LayerDashboardsView.vue') },
      { path: 'endpoint', component: () => import('@/render/layer-dashboard/LayerDashboardsView.vue') },
      {
        path: 'topology',
        component: () => import('@/layer/service-map/LayerServiceMapView.vue'),
        // The topology page ships its own in-box service-focus selector
        // (the map is layer-wide by default). Declaring it here keeps
        // the LayerShell's header picker hidden for this route — no
        // route-string sniffing in the shell.
        meta: { ownsServiceSelector: true },
      },
      { path: 'dependency', component: () => import('@/layer/endpoint-dependency/LayerEndpointDependencyView.vue') },
      // `LayerTracesEntry` is a runtime dispatcher: it inspects the
      // layer template's `traces.source` and renders either the native
      // trace view or the Zipkin one. Mesh / k8s layers land on Zipkin.
      // `ownsServiceSelector` hides the shell's SkyWalking service
      // picker — the trace tabs (both native + Zipkin) carry their
      // own service input, and Zipkin's service universe is decoupled
      // from SkyWalking's anyway (different name index, no `normal`
      // flag, queried via `/api/v2/services`).
      { path: 'trace', component: () => import('@/layer/traces/LayerTracesEntry.vue'), meta: { ownsServiceSelector: true } },
      { path: 'logs', component: () => import('@/layer/logs/LayerLogsView.vue') },
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
        path: 'services/:serviceId',
        redirect: (to) => ({
          path: `/layer/${to.params.layerKey}/service`,
          query: { service: String(to.params.serviceId) },
        }),
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
      ...placeholderTabs.map<RouteRecordRaw>((f) => ({
        path: f.path,
        component: () => import('@/layer/LayerTabPlaceholder.vue'),
        props: (r) => ({
          title: `${humanKey(String(r.params.layerKey))} · ${f.label}`,
          phase: f.phase,
        }),
      })),
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
  // Cluster
  { path: 'operate/cluster', component: () => import('@/features/operate/cluster/ClusterStatusView.vue') },
  // Alerting rules — read-only catalog backed by admin /status/alarm/*.
  // Gated on admin-server reachability at the page-body level.
  {
    path: 'operate/alerting-rules',
    name: 'alerting-rules',
    component: () => import('@/features/operate/alerting-rules/AlertingRulesView.vue'),
  },
  // ── DSL Management ─────────────────────────────────────────────────
  // Static sub-routes are declared first so they aren't shadowed by
  // the catalog alternation regex (which would otherwise grab `edit`
  // / `dump`). Each gated on `receiver-runtime-rule` at the page-body
  // level via AdminFeatureWarning.
  {
    path: 'operate/dsl/edit',
    name: 'edit',
    component: () => import('@/features/operate/dsl/DslEditorView.vue'),
  },
  {
    path: 'operate/dsl/dump',
    name: 'dump',
    component: () => import('@/features/operate/dsl/DslDumpView.vue'),
  },
  {
    path: 'operate/dsl/:catalog(otel-rules|telegraf-rules|lal|log-mal-rules)',
    name: 'catalog',
    component: () => import('@/features/operate/dsl/DslCatalogView.vue'),
    props: true,
  },
  {
    path: 'operate/oal',
    name: 'oal-catalog',
    component: () => import('@/features/operate/dsl/OalCatalogView.vue'),
  },
  // Inspect — gated on the `inspect` module (and `receiver-runtime-rule`
  // for rule attribution; degrades cleanly to "unknown" attribution
  // when admin-server is missing).
  {
    path: 'operate/inspect',
    name: 'inspect',
    component: () => import('@/features/operate/inspect/InspectView.vue'),
  },
  // Live debugger — gated on `dsl-debugging`. History is local-only
  // (browser localStorage) so it stays useful even when admin is down.
  // Declared before the catch-all tab route so it doesn't shadow.
  {
    path: 'operate/live-debug/history',
    name: 'debug-history',
    component: () => import('@/features/operate/live-debug/DebugHistoryView.vue'),
  },
  {
    path: 'operate/live-debug/:tab(mal|lal|oal)?',
    name: 'live-debugger',
    component: () => import('@/features/operate/live-debug/LiveDebuggerView.vue'),
  },
  // Admin
  {
    path: 'admin/layer-dashboards',
    component: () => import('@/features/admin/layer-templates/LayerDashboardsAdmin.vue'),
  },
  // Alert page setup — sits under Dashboard setup in the sidebar but
  // routes off the admin tree since it's an operator-only config view.
  {
    path: 'admin/alert-page-setup',
    name: 'alert-page-setup',
    component: () => import('@/features/admin/alert-page/AlertPageSetupView.vue'),
  },
  {
    path: 'admin/overview-templates',
    name: 'overview-templates',
    component: () => import('@/features/admin/overview-templates/OverviewTemplatesAdmin.vue'),
  },
  {
    path: 'admin/users',
    name: 'admin-users',
    component: () => import('@/features/admin/users/UsersAdminView.vue'),
  },
  {
    path: 'admin/auth-status',
    name: 'admin-auth-status',
    component: () => import('@/features/admin/auth-status/AuthStatusView.vue'),
  },
  {
    path: 'admin/roles',
    name: 'admin-roles',
    component: () => import('@/features/admin/roles/RolesView.vue'),
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
});

// Every successful navigation posts a single "Navigated to X" line so
// the EventTicker shows when each page started loading. The event
// buffer is intentionally NOT cleared on navigation — operators want
// to see the cross-page history (last 200 events) so they can trace
// "I clicked here, then services loaded, then I clicked there".
router.afterEach((to, from) => {
  if (to.path === from.path) return;
  pushEvent('route', 'info', `Navigated to ${to.path}`);
});

export default router;
