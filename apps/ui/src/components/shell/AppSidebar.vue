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
import { ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import Icon, { type IconName } from '@/components/icons/Icon.vue';
import logoSw from '@/assets/icons/logo-sw.svg?raw';
import { useAuthStore } from '@/stores/auth';
import { useLayers } from '@/composables/useLayers';
import { useLandingOrder } from '@/composables/useLandingOrder';

const auth = useAuthStore();
const router = useRouter();
async function signOut(): Promise<void> {
  await auth.logout();
  await router.push({ name: 'login' });
}

const { availableLayers, oapReachable, oapError, hasTopology } = useLayers();
// Sidebar shares the landing's priority order so the two views stay in sync.
const orderedLayers = useLandingOrder(availableLayers);

/* A layer counts as "single-feature" when its caps + slots only support
 * the basic services view + maybe a dashboards tab — no traces, logs,
 * topology, profiling, events, instances, or endpoints. For these,
 * expanding the row would reveal at most one or two sibling links, so
 * we skip the expander and make the row a direct link to the services
 * page (which IS the dashboard for virtual / cache / database / MQ
 * scopes). */
type SidebarLayer = (typeof orderedLayers.value)[number];
function isSingleFeatureLayer(L: SidebarLayer): boolean {
  if (L.slots.instances || L.slots.endpoints) return false;
  if (hasTopology(L)) return false;
  const c = L.caps;
  if (c.traces || c.logs || c.profiling || c.events) return false;
  if (c.endpointDependency || c.serviceMap || c.instanceTopology || c.processTopology) return false;
  return true;
}

// Default-open the first available layer once data arrives; user clicks
// thereafter take over.
const expandedLayer = ref<string | null>(null);
let userTouched = false;
watch(
  orderedLayers,
  (rows) => {
    if (userTouched || expandedLayer.value) return;
    if (rows.length > 0) expandedLayer.value = rows[0].key;
  },
  { immediate: true },
);
function toggleLayer(key: string): void {
  userTouched = true;
  expandedLayer.value = expandedLayer.value === key ? null : key;
}

const route = useRoute();
function isActive(path: string): boolean {
  return route.path === path || route.path.startsWith(path + '/');
}

interface NavRow {
  icon: IconName;
  label: string;
  to: string;
  badge?: { text: string; kind?: 'ok' | 'warn' | 'err' | 'info' };
}

interface NavSection {
  kicker: string;
  links: NavRow[];
}

// One leading row before the Layers block — the cross-layer landing.
const overview: NavRow = { icon: 'dash', label: 'Overview', to: '/' };

// Vantage-style flat kickers for the Operate / Admin half of the sidebar.
// Alarms is user-facing so it sits before the Operate block (between user
// observability concerns and OAP operator concerns).
const sections: NavSection[] = [
  {
    kicker: 'Alerts',
    links: [{ icon: 'alert', label: 'Alarms', to: '/alarms', badge: { text: '7', kind: 'err' } }],
  },
  {
    kicker: 'Marketplace',
    links: [{ icon: 'metric', label: 'All dashboards', to: '/operate/marketplace' }],
  },
  {
    kicker: 'Cluster',
    links: [{ icon: 'svc', label: 'Cluster status', to: '/operate/cluster' }],
  },
  {
    kicker: 'DSL Management',
    links: [
      { icon: 'set', label: 'MAL · OTEL', to: '/operate/dsl/otel-rules' },
      { icon: 'set', label: 'MAL · Telegraf', to: '/operate/dsl/telegraf-rules' },
      { icon: 'set', label: 'LAL', to: '/operate/dsl/lal' },
      // log-mal-rules = MAL applied to LAL-derived logs; the data flow reads
      // LAL → MAL so the label says so.
      { icon: 'set', label: 'LAL → MAL', to: '/operate/dsl/log-mal-rules' },
      { icon: 'trace', label: 'OAL · read-only', to: '/operate/oal' },
    ],
  },
  {
    kicker: 'Inspect',
    links: [{ icon: 'metric', label: 'Inspect', to: '/operate/inspect' }],
  },
  {
    kicker: 'Live debugger',
    links: [
      { icon: 'flame', label: 'Live debugger', to: '/operate/live-debug' },
      { icon: 'event', label: 'Capture history', to: '/operate/live-debug/history' },
    ],
  },
  {
    kicker: 'Dump',
    links: [{ icon: 'download', label: 'Dump & restore', to: '/operate/dump' }],
  },
  {
    kicker: 'Admin',
    links: [
      { icon: 'set', label: 'Overview setup', to: '/setup' },
      { icon: 'metric', label: 'Layer dashboards', to: '/admin/layer-dashboards' },
      { icon: 'user', label: 'Users', to: '/admin/users' },
      { icon: 'set', label: 'Roles', to: '/admin/roles' },
    ],
  },
];
</script>

<template>
  <aside class="sw-side">
    <RouterLink to="/" class="sw-brand" aria-label="SkyWalking Horizon">
      <span class="brand-logo" v-html="logoSw" />
      <small>Horizon</small>
    </RouterLink>

    <nav class="sw-nav">
      <RouterLink
        :to="overview.to"
        class="sw-nav-item lead"
        :class="{ 'is-active': route.path === overview.to }"
      >
        <Icon :name="overview.icon" /><span>{{ overview.label }}</span>
      </RouterLink>

      <div class="sw-nav-section sw-row" style="justify-content: space-between">
        <span>Layers</span>
        <span style="color: var(--sw-fg-3); font-weight: 400">
          {{ availableLayers.length }} with services
        </span>
      </div>
      <div v-if="!oapReachable && oapError" class="oap-banner" :title="oapError">
        OAP unreachable
      </div>
      <div v-else-if="availableLayers.length === 0" class="empty-layers">
        no service reporting yet —
        <RouterLink to="/" style="color: var(--sw-accent-2); text-decoration: none">
          set up a layer
        </RouterLink>
      </div>
      <template v-for="L in orderedLayers" :key="L.key">
        <!-- Single-feature layer (virtual_database, virtual_cache, etc.):
             render as a direct link to the layer's Service page — no
             expander, no children. -->
        <RouterLink
          v-if="isSingleFeatureLayer(L)"
          :to="`/layer/${L.key}/service`"
          class="layer-row direct"
          :class="{ 'is-active': isActive(`/layer/${L.key}`) }"
        >
          <span class="layer-dot" :style="{ background: L.color }" />
          <span class="layer-name">{{ L.name }}</span>
          <span class="layer-count" :title="`${L.serviceCount} service${L.serviceCount === 1 ? '' : 's'} reporting`">
            {{ L.serviceCount }}
          </span>
        </RouterLink>

        <!-- Multi-feature layer: expander row + children. -->
        <div
          v-else
          class="layer-row"
          :class="{ 'is-active': expandedLayer === L.key }"
          @click="toggleLayer(L.key)"
        >
          <span class="layer-dot" :style="{ background: L.color }" />
          <span class="layer-name" :style="{ fontWeight: expandedLayer === L.key ? 600 : 500 }">
            {{ L.name }}
          </span>
          <span class="layer-count" :title="`${L.serviceCount} service${L.serviceCount === 1 ? '' : 's'} reporting`">
            {{ L.serviceCount }}
          </span>
          <span class="caret" :class="{ open: expandedLayer === L.key }">
            <Icon name="caret" :size="10" />
          </span>
        </div>
        <div v-if="!isSingleFeatureLayer(L) && expandedLayer === L.key" class="layer-children">
          <!-- Service = the layer's primary landing page (widget grid).
               This single entry replaces the old separate Services list
               + Dashboards entries — they were the same page in concept. -->
          <RouterLink
            v-if="L.slots.services || L.caps.dashboards"
            :to="`/layer/${L.key}/service`"
            class="sw-nav-item"
            :class="{ 'is-active': isActive(`/layer/${L.key}/service`) || route.path === `/layer/${L.key}` }"
          >
            <Icon name="svc" /><span>Service</span>
            <span class="sw-badge" style="margin-left: auto">{{ L.serviceCount }}</span>
          </RouterLink>
          <RouterLink
            v-if="L.slots.instances"
            :to="`/layer/${L.key}/instances`"
            class="sw-nav-item"
            :class="{ 'is-active': isActive(`/layer/${L.key}/instances`) }"
          >
            <Icon name="prof" /><span>{{ L.slots.instances }}</span>
          </RouterLink>
          <RouterLink
            v-if="L.slots.endpoints"
            :to="`/layer/${L.key}/endpoints`"
            class="sw-nav-item"
            :class="{ 'is-active': isActive(`/layer/${L.key}/endpoints`) }"
          >
            <Icon name="ep" /><span>{{ L.slots.endpoints }}</span>
          </RouterLink>

          <RouterLink
            v-if="hasTopology(L)"
            :to="`/layer/${L.key}/topology`"
            class="sw-nav-item"
            :class="{ 'is-active': isActive(`/layer/${L.key}/topology`) }"
          >
            <Icon name="topo" /><span>Topology</span>
          </RouterLink>
          <RouterLink
            v-if="L.caps.endpointDependency"
            :to="`/layer/${L.key}/dependency`"
            class="sw-nav-item"
            :class="{ 'is-active': isActive(`/layer/${L.key}/dependency`) }"
          >
            <Icon name="ep" /><span>{{ L.slots.endpointDependency ?? `${L.slots.endpoints ?? 'Endpoint'} dependency` }}</span>
          </RouterLink>
          <RouterLink
            v-if="L.caps.traces"
            :to="`/layer/${L.key}/traces`"
            class="sw-nav-item"
            :class="{ 'is-active': isActive(`/layer/${L.key}/traces`) }"
          >
            <Icon name="trace" /><span>Traces</span>
          </RouterLink>
          <RouterLink
            v-if="L.caps.logs"
            :to="`/layer/${L.key}/logs`"
            class="sw-nav-item"
            :class="{ 'is-active': isActive(`/layer/${L.key}/logs`) }"
          >
            <Icon name="log" /><span>Logs</span>
          </RouterLink>
          <RouterLink
            v-if="L.caps.profiling"
            :to="`/layer/${L.key}/profiling`"
            class="sw-nav-item"
            :class="{ 'is-active': isActive(`/layer/${L.key}/profiling`) }"
          >
            <Icon name="flame" /><span>Profiling</span>
          </RouterLink>
        </div>
      </template>

      <template v-for="sec in sections" :key="sec.kicker">
        <div class="sw-nav-section">{{ sec.kicker }}</div>
        <RouterLink
          v-for="row in sec.links"
          :key="row.to"
          :to="row.to"
          class="sw-nav-item"
          :class="{ 'is-active': isActive(row.to) }"
        >
          <Icon :name="row.icon" /><span>{{ row.label }}</span>
          <span v-if="row.badge" class="sw-badge" :class="row.badge.kind" style="margin-left: auto">
            {{ row.badge.text }}
          </span>
        </RouterLink>
      </template>
    </nav>

    <div class="sw-side-foot">
      <div class="sw-avatar">
        {{ auth.user?.username ? auth.user.username.slice(0, 2).toUpperCase() : '?' }}
      </div>
      <div style="line-height: 1.2; flex: 1; min-width: 0; overflow: hidden">
        <div
          style="
            color: var(--sw-fg-0);
            font-weight: 600;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          "
        >
          {{ auth.user?.username ?? 'guest' }}
        </div>
        <div>{{ auth.user?.roles?.join(' · ') ?? 'not signed in' }}</div>
      </div>
      <button v-if="auth.isAuthenticated" class="sw-btn is-icon" title="Sign out" @click="signOut">
        <Icon name="share" :size="12" />
      </button>
    </div>
  </aside>
</template>

<style scoped>
.sw-brand,
.sw-brand:hover {
  text-decoration: none;
  color: inherit;
}
.brand-logo {
  display: inline-flex;
  align-items: center;
  color: var(--sw-fg-0);
}
.brand-logo :deep(svg) {
  height: 16px;
  width: auto;
  display: block;
}
.sw-brand small {
  font-weight: 500;
  color: var(--sw-fg-2);
  margin-left: 2px;
  letter-spacing: 0.02em;
}
.layer-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 10px;
  border-radius: 6px;
  color: var(--sw-fg-1);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  position: relative;
}
.layer-row:hover {
  background: var(--sw-bg-2);
  color: var(--sw-fg-0);
}
.layer-row.is-active {
  background: var(--sw-bg-3);
  color: var(--sw-fg-0);
  box-shadow: inset 2px 0 0 var(--sw-accent);
}
.layer-row .layer-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.layer-row .layer-count {
  font-family: var(--sw-mono);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: var(--sw-fg-1);
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  padding: 1px 6px;
  min-width: 24px;
  text-align: center;
}
.layer-row.is-active .layer-count {
  color: var(--sw-accent-2);
  background: var(--sw-accent-soft);
  border-color: var(--sw-accent-line);
}
.layer-row.direct {
  text-decoration: none;
}
.empty-layers {
  margin: 4px 10px 8px;
  padding: 6px 8px;
  font-size: 10.5px;
  color: var(--sw-fg-3);
  font-style: italic;
}
.layer-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 7px;
}
.caret {
  color: var(--sw-fg-3);
  margin-left: 4px;
  transition: transform 0.15s;
  display: inline-flex;
  width: 10px;
  transform: rotate(-90deg);
}
.caret.open {
  transform: rotate(0);
}
.layer-children {
  padding-left: 12px;
  margin-left: 18px;
  margin-bottom: 4px;
  border-left: 1px dashed var(--sw-line-2);
}
.layer-children .sw-nav-item {
  text-decoration: none;
}
.sw-nav-item {
  text-decoration: none;
}
.sw-nav-item.lead {
  margin-top: 4px;
}
.sw-nav-item.is-inactive .layer-dot {
  opacity: 0.4;
}
.sw-nav-item.is-inactive > span:nth-child(2) {
  color: var(--sw-fg-3);
}
.oap-banner {
  margin: 4px 10px 8px;
  padding: 6px 8px;
  font-size: 10.5px;
  color: #f87171;
  background: var(--sw-err-soft);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 4px;
  letter-spacing: 0.02em;
}
</style>
