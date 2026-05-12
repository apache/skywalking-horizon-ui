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
import { useAuthStore } from '@/stores/auth';

const placeholder = () => import('@/views/PlaceholderView.vue');

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
  const placeholderTabs: { path: string; label: string; phase: string }[] = [
    { path: 'topology', label: 'Topology', phase: 'Phase 4' },
    { path: 'dependency', label: 'API dependency', phase: 'Phase 4' },
    { path: 'logs', label: 'Logs', phase: 'Phase 5' },
  ];
  return {
    path: 'layer/:layerKey',
    component: () => import('@/views/layer/LayerShell.vue'),
    children: [
      // Bare /layer/:layerKey lands on the Service view — the per-layer
      // widget grid driven by the dashboard config.
      { path: '', redirect: (to) => ({ path: `/layer/${to.params.layerKey}/service` }) },
      // Per-scope dashboards. Same view component, scope inferred from
      // the URL — widget set differs per scope via the JSON template's
      // `dashboards.<scope>` array.
      { path: 'service', component: () => import('@/views/layer/LayerDashboardsView.vue') },
      { path: 'instance', component: () => import('@/views/layer/LayerDashboardsView.vue') },
      { path: 'endpoint', component: () => import('@/views/layer/LayerDashboardsView.vue') },
      { path: 'trace', component: () => import('@/views/layer/LayerDashboardsView.vue') },
      { path: 'profiling', component: () => import('@/views/layer/LayerDashboardsView.vue') },
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
        component: () => import('@/views/layer/LayerTabPlaceholder.vue'),
        props: (r) => ({
          title: `${humanKey(String(r.params.layerKey))} · ${f.label}`,
          phase: f.phase,
        }),
      })),
    ],
  };
}

const shellRoutes: RouteRecordRaw[] = [
  { path: '', name: 'overview', component: () => import('@/views/overview/OverviewView.vue') },
  { path: 'setup', name: 'setup', component: () => import('@/views/setup/SetupView.vue') },
  layerRoute(),
  // Alerts (user-facing — alarms are observability data, not operator-only)
  { path: 'alarms', component: placeholder, props: { title: 'Alarms', phase: 'Phase 5', note: 'Read-only; recovery is backend-auto. Live debug card via admin REST.' } },
  // Marketplace — all dashboards / templates across layers
  { path: 'operate/marketplace', component: placeholder, props: { title: 'Marketplace', phase: 'Phase 2', note: 'All dashboard templates browse + clone + customize.' } },
  // Cluster
  { path: 'operate/cluster', component: () => import('@/views/operate/ClusterStatusView.vue') },
  // DSL Management
  { path: 'operate/dsl/:catalog(otel-rules|telegraf-rules|lal|log-mal-rules)', component: placeholder, props: (r) => ({ title: `DSL · ${r.params.catalog}`, phase: 'Phase 6', note: 'Rule catalog grid + filter + new-rule form. Click a rule to open the editor.' }) },
  { path: 'operate/dsl/:catalog(otel-rules|telegraf-rules|lal|log-mal-rules)/:name', component: placeholder, props: (r) => ({ title: `Edit · ${r.params.name}`, phase: 'Phase 6', note: 'Monaco YAML + diff vs server + diff vs bundled + destructive-confirm.' }) },
  { path: 'operate/oal', component: placeholder, props: { title: 'OAL · read-only', phase: 'Phase 6', note: 'Line-numbered OAL files with jump-to-debugger on each rule.' } },
  // Inspect
  { path: 'operate/inspect', component: placeholder, props: { title: 'Inspect', phase: 'Phase 6', note: 'OAP metric catalog browse + MQE ad-hoc charts with rule attribution.' } },
  // Live debugger
  { path: 'operate/live-debug/:tab(mal|lal|oal)?', component: placeholder, props: (r) => ({ title: `Live debugger · ${r.params.tab ?? 'mal'}`, phase: 'Phase 6' }) },
  { path: 'operate/live-debug/history', component: placeholder, props: { title: 'Capture history', phase: 'Phase 6', note: 'Local-only history of finished capture sessions.' } },
  // Dump
  { path: 'operate/dump', component: placeholder, props: { title: 'Dump & restore', phase: 'Phase 6', note: 'Stream OAP runtime-rule dump as tar.gz. Restore is deferred (no OAP endpoint yet).' } },
  // Admin
  {
    path: 'admin/layer-dashboards',
    component: () => import('@/views/admin/LayerDashboardsAdmin.vue'),
  },
  { path: 'admin/users', component: placeholder, props: { title: 'Users', phase: 'Phase 7' } },
  { path: 'admin/roles', component: placeholder, props: { title: 'Roles & permissions', phase: 'Phase 7' } },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/auth/LoginView.vue'),
      meta: { public: true },
    },
    {
      path: '/',
      component: () => import('@/components/shell/AppShell.vue'),
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

export default router;
