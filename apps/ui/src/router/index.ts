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

// Layer sub-routes are open-ended — any `:layerKey` is accepted. The real
// per-layer view (Phase 2.6+) will read live cap data via useLayers() and
// render a 'doesn't expose' note when the cap is off. The placeholder here
// only needs the raw key + the feature label.
function layerSubRoutes(): RouteRecordRaw[] {
  const sub: RouteRecordRaw[] = [];
  sub.push({
    path: 'layer/:layerKey',
    component: placeholder,
    props: (r) => ({
      title: `${humanKey(String(r.params.layerKey))} · Overview`,
      phase: 'Phase 2',
      note: 'Per-layer landing: KPIs, throughput, service constellation, services table.',
    }),
  });

  const features: { path: string; label: string; phase: string }[] = [
    { path: 'services', label: 'Services', phase: 'Phase 2 / 3' },
    { path: 'instances', label: 'Instances', phase: 'Phase 2 / 3' },
    { path: 'endpoints', label: 'Endpoints', phase: 'Phase 2 / 3' },
    { path: 'topology', label: 'Topology', phase: 'Phase 4' },
    { path: 'dependency', label: 'API dependency', phase: 'Phase 4' },
    { path: 'dashboards', label: 'Dashboards', phase: 'Phase 3' },
    { path: 'traces', label: 'Traces', phase: 'Phase 5' },
    { path: 'logs', label: 'Logs', phase: 'Phase 5' },
    { path: 'profiling', label: 'Profiling', phase: 'Phase 8' },
    { path: 'events', label: 'Events', phase: 'Phase 5' },
  ];
  for (const f of features) {
    sub.push({
      path: `layer/:layerKey/${f.path}`,
      component: placeholder,
      props: (r) => ({
        title: `${humanKey(String(r.params.layerKey))} · ${f.label}`,
        phase: f.phase,
      }),
    });
  }
  return sub;
}

const shellRoutes: RouteRecordRaw[] = [
  { path: '', name: 'overview', component: () => import('@/views/overview/OverviewView.vue') },
  { path: 'setup', name: 'setup', component: () => import('@/views/setup/SetupView.vue') },
  ...layerSubRoutes(),
  // Alerts (user-facing — alarms are observability data, not operator-only)
  { path: 'alarms', component: placeholder, props: { title: 'Alarms', phase: 'Phase 5', note: 'Read-only; recovery is backend-auto. Live debug card via admin REST.' } },
  // Marketplace — all dashboards / templates across layers
  { path: 'operate/marketplace', component: placeholder, props: { title: 'Marketplace', phase: 'Phase 2', note: 'All dashboard templates browse + clone + customize.' } },
  // Cluster
  { path: 'operate/cluster', component: placeholder, props: { title: 'Cluster status', phase: 'Phase 6 / 7', note: 'Module activity matrix · storage health · receiver activity · effective config tree · TTL grid.' } },
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
