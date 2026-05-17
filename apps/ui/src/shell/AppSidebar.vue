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
import { computed, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import Icon, { type IconName } from '@/components/icons/Icon.vue';
import logoSw from '@/assets/icons/logo-sw.svg?raw';
import { useAuthStore } from '@/state/auth';
import { useLayers } from '@/shell/useLayers';
import { useLandingOrder } from '@/shell/useLandingOrder';
import { useOverviewDashboards } from '@/render/overview/useOverviewDashboards';

const auth = useAuthStore();
const router = useRouter();
async function signOut(): Promise<void> {
  await auth.logout();
  await router.push({ name: 'login' });
}

const { availableLayers, oapReachable, oapError } = useLayers();
const orderedLayers = useLandingOrder(availableLayers);
const { publicOverviews } = useOverviewDashboards();

import { sectionIcon, layerIcon as layerIconByKey } from './icons';
function layerIcon(L: SidebarLayer): IconName {
  return layerIconByKey(L.key);
}

type SidebarLayer = (typeof orderedLayers.value)[number];

/**
 * Per-layer navigation descriptor. Built ONCE per layer set (rebuilt
 * only when `orderedLayers` changes) and cached in `layerNavByKey`.
 * Lets the template render each tab via a single `v-for` instead of
 * the dozen inline `v-if cap` blocks that fired on every route change
 * and made the sidebar feel sluggish on OAPs with many layers.
 *
 * `isSingle` — the layer collapses to a direct link (no accordion).
 * `primaryTo` — `/layer/<key>/<firstLayerTab>` (used by the row click).
 * `tabs` — child rows; empty when `isSingle`.
 */
interface LayerTab {
  key: string;
  icon: IconName;
  label: string;
  to: string;
  /** Optional badge — currently only Service shows the service count. */
  badge?: number;
}
interface LayerNav {
  isSingle: boolean;
  primaryTo: string;
  tabs: LayerTab[];
}

function buildLayerNav(L: SidebarLayer): LayerNav {
  const c = L.caps;
  const slots = L.slots;
  const hasInstances = c.instances ?? Boolean(slots.instances);
  const hasEndpoints = c.endpoints ?? Boolean(slots.endpoints);
  const hasTopo = Boolean(c.serviceMap || c.instanceTopology || c.processTopology);
  const hasAny =
    hasInstances ||
    hasEndpoints ||
    hasTopo ||
    Boolean(
      c.traces ||
        c.logs ||
        c.traceProfiling ||
        c.ebpfProfiling ||
        c.asyncProfiling ||
        c.networkProfiling ||
        c.pprofProfiling ||
        c.events ||
        c.endpointDependency,
    );
  const firstTab = (() => {
    if (c.dashboards) return 'service';
    if (hasInstances) return 'instance';
    if (hasEndpoints) return 'endpoint';
    if (hasTopo) return 'topology';
    if (c.endpointDependency) return 'dependency';
    if (c.traces) return 'trace';
    if (c.logs) return 'logs';
    if (c.traceProfiling) return 'trace-profiling';
    if (c.ebpfProfiling) return 'ebpf-profiling';
    if (c.networkProfiling) return 'network-profiling';
    if (c.asyncProfiling) return 'async-profiling';
    if (c.pprofProfiling) return 'pprof';
    return 'service';
  })();
  const primaryTo = `/layer/${L.key}/${firstTab}`;
  const isSingle = !hasAny;
  const tabs: LayerTab[] = [];
  const push = (t: LayerTab) => tabs.push(t);
  if (c.dashboards) push({ key: 'service', icon: 'svc', label: 'Service', to: `/layer/${L.key}/service`, badge: L.serviceCount });
  if (hasInstances) push({ key: 'instance', icon: 'prof', label: slots.instances ?? 'Instance', to: `/layer/${L.key}/instance` });
  if (hasEndpoints) push({ key: 'endpoint', icon: 'ep', label: slots.endpoints ?? 'Endpoint', to: `/layer/${L.key}/endpoint` });
  if (hasTopo) push({ key: 'topology', icon: 'topo', label: 'Topology', to: `/layer/${L.key}/topology` });
  if (c.endpointDependency) {
    const label = slots.endpointDependency ?? `${slots.endpoints ?? 'Endpoint'} dependency`;
    push({ key: 'dependency', icon: 'ep', label, to: `/layer/${L.key}/dependency` });
  }
  if (c.traces) push({ key: 'trace', icon: 'trace', label: 'Traces', to: `/layer/${L.key}/trace` });
  if (c.logs) push({ key: 'logs', icon: 'log', label: 'Logs', to: `/layer/${L.key}/logs` });
  if (c.traceProfiling) push({ key: 'trace-profiling', icon: 'flame', label: 'Trace Profiling', to: `/layer/${L.key}/trace-profiling` });
  if (c.ebpfProfiling) push({ key: 'ebpf-profiling', icon: 'flame', label: 'eBPF Profiling', to: `/layer/${L.key}/ebpf-profiling` });
  if (c.networkProfiling) push({ key: 'network-profiling', icon: 'prof', label: 'Network Profiling', to: `/layer/${L.key}/network-profiling` });
  if (c.pprofProfiling) push({ key: 'pprof', icon: 'prof', label: 'pprof (Go)', to: `/layer/${L.key}/pprof` });
  if (c.asyncProfiling) push({ key: 'async-profiling', icon: 'flame', label: 'Async Profiling', to: `/layer/${L.key}/async-profiling` });
  return { isSingle, primaryTo, tabs };
}

const layerNavByKey = computed<Map<string, LayerNav>>(() => {
  const m = new Map<string, LayerNav>();
  for (const L of orderedLayers.value) m.set(L.key, buildLayerNav(L));
  return m;
});
function navFor(L: SidebarLayer): LayerNav {
  return layerNavByKey.value.get(L.key) ?? buildLayerNav(L);
}

const expandedLayer = ref<string | null>(null);
function toggleLayer(key: string): void {
  const wasExpanded = expandedLayer.value === key;
  expandedLayer.value = wasExpanded ? null : key;
  if (!wasExpanded) {
    const nav = layerNavByKey.value.get(key);
    if (!nav) return;
    if (route.path === nav.primaryTo) return;
    if (route.path.startsWith(`/layer/${key}/`)) return;
    void router.push(nav.primaryTo);
  }
}

/**
 * Group-header click — cascade two levels: expand the first layer in
 * the group AND navigate to its first tab. Mirrors the behaviour
 * described as "for group menu, only the first sub menu select
 * (nested twice), then fire the real menu selection". Without this
 * the section labels were inert and the operator had to drill in via
 * two clicks (layer → tab) instead of one (group).
 */
function pickGroupFirst(layers: SidebarLayer[]): void {
  const first = layers[0];
  if (!first) return;
  const nav = layerNavByKey.value.get(first.key);
  if (!nav) return;
  expandedLayer.value = first.key;
  if (route.path === nav.primaryTo) return;
  void router.push(nav.primaryTo);
}

interface LayerGroup { kind: 'group'; label: string; layers: SidebarLayer[] }
interface LayerSingle { kind: 'single'; layer: SidebarLayer }
type SidebarEntry = LayerGroup | LayerSingle;
/** Group layers by their template's `group` field, preserving the
 *  first-seen position so the section lands where the first member
 *  appears in source order. Ungrouped layers fall through as singles. */
function bucket(rows: SidebarLayer[]): SidebarEntry[] {
  const out: SidebarEntry[] = [];
  const groupBuckets = new Map<string, SidebarLayer[]>();
  for (const L of rows) {
    if (L.group) {
      if (!groupBuckets.has(L.group)) {
        groupBuckets.set(L.group, []);
        out.push({ kind: 'group', label: L.group, layers: groupBuckets.get(L.group)! });
      }
      groupBuckets.get(L.group)!.push(L);
    } else {
      out.push({ kind: 'single', layer: L });
    }
  }
  return out;
}
const publicLayers = computed(() =>
  orderedLayers.value.filter((L) => L.visibility !== 'operate'),
);
const operateLayers = computed(() =>
  orderedLayers.value.filter((L) => L.visibility === 'operate'),
);
const sidebarEntries = computed<SidebarEntry[]>(() => bucket(publicLayers.value));

const route = useRoute();
function isActive(path: string): boolean {
  return route.path === path || route.path.startsWith(path + '/');
}
/** Use this — not {@link isActive} — for sibling routes where one is
 *  a prefix of another (e.g. `/operate/live-debug` vs
 *  `/operate/live-debug/history`); prefix-match would light both up. */
function isActiveExact(path: string): boolean {
  return route.path === path;
}

watch(
  [() => route.path, orderedLayers],
  ([path, rows]) => {
    const m = path.match(/^\/layer\/([^/]+)/);
    if (m) {
      const key = m[1];
      const L = rows.find((l) => l.key === key);
      if (L) expandedLayer.value = key;
      return;
    }
    if (!expandedLayer.value && rows.length > 0) {
      expandedLayer.value = rows[0].key;
    }
  },
  { immediate: true },
);

interface NavRow {
  icon: IconName;
  label: string;
  to: string;
  badge?: { text: string; kind?: 'ok' | 'warn' | 'err' | 'info' };
  /** Custom active-match; defaults to exact `path === to`. */
  activeWhen?: (path: string) => boolean;
  /** Present ⇒ row renders as an L1 expandable with these as L2. */
  children?: NavRow[];
}

interface NavSection {
  kicker: string;
  links: NavRow[];
}

const sections: NavSection[] = [
  {
    kicker: 'Operate',
    links: [
      { icon: 'svc', label: 'Cluster status', to: '/operate/cluster' },
      {
        icon: 'flame',
        label: 'Live debugger',
        to: '/operate/live-debug',
        // Match the tab variants only; the history sibling at
        // /operate/live-debug/history must NOT highlight this row.
        activeWhen: (p) => p === '/operate/live-debug' || /^\/operate\/live-debug\/(mal|lal|oal)(\/|$)/.test(p),
      },
      { icon: 'event', label: 'Capture history', to: '/operate/live-debug/history' },
      { icon: 'metric', label: 'Metrics Inspect', to: '/operate/inspect' },
      {
        icon: 'set',
        label: 'DSL Management',
        // No standalone landing — `to` jumps to the first rule page so
        // the L1 itself is clickable; activeWhen covers all DSL routes.
        to: '/operate/dsl/otel-rules',
        activeWhen: (p) => p === '/operate/oal' || /^\/operate\/dsl(\/|$)/.test(p),
        children: [
          { icon: 'set', label: 'MAL · OTEL', to: '/operate/dsl/otel-rules' },
          { icon: 'set', label: 'MAL · Telegraf', to: '/operate/dsl/telegraf-rules' },
          { icon: 'set', label: 'LAL', to: '/operate/dsl/lal' },
          { icon: 'set', label: 'LAL → MAL', to: '/operate/dsl/log-mal-rules' },
          { icon: 'trace', label: 'OAL · read-only', to: '/operate/oal' },
          { icon: 'download', label: 'Dump & restore', to: '/operate/dsl/dump' },
        ],
      },
    ],
  },
  {
    kicker: 'Dashboard setup',
    links: [
      { icon: 'set', label: 'Overview dashboards', to: '/setup' },
      { icon: 'metric', label: 'Layer dashboards', to: '/admin/layer-dashboards' },
      { icon: 'alert', label: 'Alert page', to: '/admin/alert-page-setup' },
    ],
  },
  {
    kicker: 'Admin',
    links: [
      { icon: 'user', label: 'Users', to: '/admin/users' },
      { icon: 'set', label: 'Roles', to: '/admin/roles' },
    ],
  },
];

const openNavL1 = ref<Set<string>>(new Set());
function isNavL1Open(to: string): boolean { return openNavL1.value.has(to); }
function toggleNavL1(row: NavRow): void {
  if (!row.children) return;
  const next = new Set(openNavL1.value);
  if (next.has(row.to)) next.delete(row.to);
  else next.add(row.to);
  openNavL1.value = next;
}

watch(
  () => route.path,
  (path) => {
    for (const sec of sections) {
      for (const row of sec.links) {
        if (!row.children) continue;
        const childActive = row.children.some((c) =>
          c.activeWhen ? c.activeWhen(path) : path === c.to,
        );
        const parentActive = row.activeWhen ? row.activeWhen(path) : path === row.to;
        if ((childActive || parentActive) && !openNavL1.value.has(row.to)) {
          openNavL1.value = new Set([...openNavL1.value, row.to]);
        }
      }
    }
  },
  { immediate: true },
);
</script>

<template>
  <aside class="sw-side">
    <RouterLink to="/" class="sw-brand" aria-label="SkyWalking Horizon">
      <span class="brand-logo" v-html="logoSw" />
      <small>Horizon</small>
    </RouterLink>

    <nav class="sw-nav">
      <div class="sw-nav-section sw-nav-section--icon">
        <Icon :name="sectionIcon('Overviews')" />
        <span>Overviews</span>
      </div>
      <RouterLink
        v-for="ov in publicOverviews"
        :key="`pub:${ov.id}`"
        :to="`/overview/${ov.id}`"
        class="sw-nav-item"
        :class="{ 'is-active': isActive(`/overview/${ov.id}`) }"
      >
        <Icon :name="(ov.icon as IconName) || 'dash'" /><span>{{ ov.title }}</span>
      </RouterLink>
      <RouterLink
        to="/alarms"
        class="sw-nav-item"
        :class="{ 'is-active': isActive('/alarms') }"
      >
        <Icon name="alert" /><span>Alarms</span>
        <span class="sw-badge err" style="margin-left: auto">7</span>
      </RouterLink>

      <div class="sw-nav-section sw-nav-section--icon" style="justify-content: space-between">
        <Icon :name="sectionIcon('Layers')" />
        <span style="flex: 1">Layers</span>
        <span class="sw-nav-section-count">{{ publicLayers.length }} with services</span>
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
      <template v-for="(E, ei) in sidebarEntries" :key="E.kind === 'group' ? `g:${E.label}` : `s:${E.layer.key}:${ei}`">
        <template v-if="E.kind === 'group'">
          <div
            class="sw-nav-section sw-nav-section--icon sw-nav-section--clickable"
            @click="pickGroupFirst(E.layers)"
          >
            <Icon :name="sectionIcon(E.label)" />
            <span class="layer-group-name">{{ E.label }}</span>
          </div>
          <template v-for="L in E.layers" :key="`${E.label}::${L.key}`">
            <RouterLink
              v-if="navFor(L).isSingle"
              :to="navFor(L).primaryTo"
              class="layer-row direct in-group"
              :class="{ 'is-active': isActive(`/layer/${L.key}`) }"
            >
              <Icon :name="layerIcon(L)" />
              <span class="layer-name">{{ L.name }}</span>
            </RouterLink>
            <div
              v-else
              class="layer-row in-group"
              :class="{
                'is-expanded': expandedLayer === L.key,
                'is-active': isActiveExact(`/layer/${L.key}`),
              }"
              @click="toggleLayer(L.key)"
            >
              <Icon :name="layerIcon(L)" />
              <span class="layer-name">{{ L.name }}</span>
              <span class="caret" :class="{ open: expandedLayer === L.key }">
                <Icon name="caret" :size="10" />
              </span>
            </div>
            <div
              v-if="!navFor(L).isSingle && expandedLayer === L.key"
              class="layer-children in-group"
            >
              <RouterLink
                v-for="tab in navFor(L).tabs"
                :key="tab.key"
                :to="tab.to"
                class="sw-nav-item"
                :class="{ 'is-active': isActive(tab.to) }"
              >
                <Icon :name="tab.icon" /><span>{{ tab.label }}</span>
                <span v-if="tab.badge != null" class="sw-badge" style="margin-left: auto">{{ tab.badge }}</span>
              </RouterLink>
            </div>
          </template>
        </template>

        <!-- Ungrouped single-feature layer: direct link. -->
        <RouterLink
          v-else-if="navFor(E.layer).isSingle"
          :to="navFor(E.layer).primaryTo"
          class="layer-row direct"
          :class="{ 'is-active': isActive(`/layer/${E.layer.key}`) }"
        >
          <Icon :name="layerIcon(E.layer)" />
          <span class="layer-name">{{ E.layer.name }}</span>
        </RouterLink>

        <div
          v-else
          class="layer-row expandable"
          :class="{
            'is-expanded': expandedLayer === E.layer.key,
            'is-active': isActiveExact(`/layer/${E.layer.key}`),
          }"
          @click="toggleLayer(E.layer.key)"
        >
          <Icon :name="layerIcon(E.layer)" />
          <span class="layer-name">{{ E.layer.name }}</span>
          <span class="caret" :class="{ open: expandedLayer === E.layer.key }">
            <Icon name="caret" :size="10" />
          </span>
        </div>
        <div
          v-if="E.kind === 'single' && !navFor(E.layer).isSingle && expandedLayer === E.layer.key"
          class="layer-children"
        >
          <RouterLink
            v-for="tab in navFor(E.layer).tabs"
            :key="tab.key"
            :to="tab.to"
            class="sw-nav-item"
            :class="{ 'is-active': isActive(tab.to) }"
          >
            <Icon :name="tab.icon" /><span>{{ tab.label }}</span>
            <span v-if="tab.badge != null" class="sw-badge" style="margin-left: auto">{{ tab.badge }}</span>
          </RouterLink>
        </div>
      </template>

      <template v-if="operateLayers.length > 0">
        <div
          class="sw-nav-section sw-nav-section--icon sw-nav-section--clickable"
          @click="pickGroupFirst(operateLayers)"
        >
          <Icon :name="sectionIcon('Platform monitoring')" />
          <span>Platform monitoring</span>
        </div>
        <template v-for="L in operateLayers" :key="`op:${L.key}`">
          <RouterLink
            v-if="navFor(L).isSingle"
            :to="navFor(L).primaryTo"
            class="layer-row direct"
            :class="{ 'is-active': isActive(`/layer/${L.key}`) }"
          >
            <Icon :name="layerIcon(L)" />
            <span class="layer-name">{{ L.name }}</span>
            <span class="sw-badge" style="margin-left: auto">{{ L.serviceCount }}</span>
          </RouterLink>
          <div
            v-else
            class="layer-row expandable"
            :class="{
              'is-expanded': expandedLayer === L.key,
              'is-active': isActiveExact(`/layer/${L.key}`),
            }"
            @click="toggleLayer(L.key)"
          >
            <Icon :name="layerIcon(L)" />
            <span class="layer-name">{{ L.name }}</span>
            <span class="caret" :class="{ open: expandedLayer === L.key }">
              <Icon name="caret" :size="10" />
            </span>
          </div>
          <div
            v-if="!navFor(L).isSingle && expandedLayer === L.key"
            class="layer-children"
          >
            <RouterLink
              v-for="tab in navFor(L).tabs"
              :key="tab.key"
              :to="tab.to"
              class="sw-nav-item"
              :class="{ 'is-active': isActive(tab.to) }"
            >
              <Icon :name="tab.icon" /><span>{{ tab.label }}</span>
              <span v-if="tab.badge != null" class="sw-badge" style="margin-left: auto">{{ tab.badge }}</span>
            </RouterLink>
          </div>
        </template>
      </template>

      <template v-for="entry in sections" :key="`m:${entry.kicker}`">
        <div class="sw-nav-section sw-nav-section--icon">
          <Icon :name="sectionIcon(entry.kicker)" />
          <span>{{ entry.kicker }}</span>
        </div>
        <template v-for="row in entry.links" :key="row.to">
          <RouterLink
            v-if="!row.children"
            :to="row.to"
            class="sw-nav-item"
            :class="{ 'is-active': row.activeWhen ? row.activeWhen(route.path) : isActiveExact(row.to) }"
          >
            <Icon :name="row.icon" /><span>{{ row.label }}</span>
            <span v-if="row.badge" class="sw-badge" :class="row.badge.kind" style="margin-left: auto">
              {{ row.badge.text }}
            </span>
          </RouterLink>
          <template v-else>
            <div
              class="layer-row expandable"
              :class="{
                'is-expanded': isNavL1Open(row.to),
                'is-active': row.activeWhen ? row.activeWhen(route.path) : isActiveExact(row.to),
              }"
              @click="toggleNavL1(row)"
            >
              <Icon :name="row.icon" />
              <span class="layer-name">{{ row.label }}</span>
              <span class="caret" :class="{ open: isNavL1Open(row.to) }">
                <Icon name="caret" :size="10" />
              </span>
            </div>
            <div v-if="isNavL1Open(row.to)" class="layer-children">
              <RouterLink
                v-for="c in row.children"
                :key="c.to"
                :to="c.to"
                class="sw-nav-item"
                :class="{ 'is-active': c.activeWhen ? c.activeWhen(route.path) : isActiveExact(c.to) }"
              >
                <Icon :name="c.icon" /><span>{{ c.label }}</span>
                <span v-if="c.badge" class="sw-badge" :class="c.badge.kind" style="margin-left: auto">
                  {{ c.badge.text }}
                </span>
              </RouterLink>
            </div>
          </template>
        </template>
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
/* L1 row — unified menu spec: 28px tall, 16px icon, 12/600 fg-1.
 * Active = accent inset + 10% accent fill; expanded-only = white-fade. */
.layer-row {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 1px 8px;
  padding: 6px 10px;
  border-radius: 6px;
  color: var(--sw-fg-1);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
  position: relative;
}
.layer-row :deep(svg) {
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
  color: var(--sw-fg-2);
  opacity: 1;
}
.layer-row .caret :deep(svg) {
  width: 10px;
  height: 10px;
  flex: 0 0 10px;
  color: var(--sw-fg-3);
}
.layer-row:hover {
  background: rgba(255, 255, 255, 0.04);
  color: var(--sw-fg-0);
}
.layer-row.is-expanded {
  background: rgba(255, 255, 255, 0.025);
  color: var(--sw-fg-0);
}
.layer-row.is-active {
  background: var(--sw-accent-soft);
  color: var(--sw-fg-0);
  box-shadow: inset 2px 0 0 var(--sw-accent);
}
.layer-row.is-active :deep(svg):not(.caret svg) {
  color: var(--sw-accent);
}
.layer-row .layer-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.layer-row.direct {
  text-decoration: none;
}
.layer-row.expandable {
  cursor: pointer;
  user-select: none;
}
.empty-layers {
  margin: 4px 10px 8px;
  padding: 6px 8px;
  font-size: 10.5px;
  color: var(--sw-fg-3);
  font-style: italic;
}
/* Base glyph points down; -90° collapses to right-arrow. */
.caret {
  margin-left: 4px;
  transition: transform 0.15s;
  display: inline-flex;
  width: 10px;
  transform: rotate(-90deg);
}
.caret.open {
  transform: rotate(0);
}
/* L2 — children of an expanded layer. Vertical rail at left:22 with
 * a per-row horizontal tick; the last child masks the rail's tail
 * with --sw-bg-1 so it reads as a half-line. */
.layer-children {
  position: relative;
  padding: 2px 0 4px;
  margin-bottom: 4px;
}
.layer-children::before {
  content: '';
  position: absolute;
  left: 22px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--sw-line-2);
}
.layer-children .sw-nav-item {
  position: relative;
  margin: 1px 8px 1px 28px;
  padding: 5px 9px;
  border-radius: 5px;
  font-size: 11.5px;
  font-weight: 500;
  text-decoration: none;
  gap: 8px;
  color: var(--sw-fg-1);
}
.layer-children .sw-nav-item::before {
  content: '';
  position: absolute;
  left: -6px;
  top: 50%;
  width: 8px;
  height: 1px;
  background: var(--sw-line-2);
}
.layer-children .sw-nav-item:last-child::after {
  content: '';
  position: absolute;
  left: -7px;
  top: calc(50% + 1px);
  bottom: -4px;
  width: 2px;
  background: var(--sw-bg-1);
}
.layer-children .sw-nav-item :deep(svg) {
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
  color: var(--sw-fg-2);
  opacity: 1;
}
.layer-children .sw-nav-item:hover {
  background: rgba(255, 255, 255, 0.04);
  color: var(--sw-fg-0);
}
.layer-children .sw-nav-item.is-active {
  background: rgba(249, 115, 22, 0.12);
  color: var(--sw-fg-0);
  font-weight: 600;
  box-shadow: inset 2px 0 0 var(--sw-accent);
}
.layer-children .sw-nav-item.is-active :deep(svg) {
  color: var(--sw-accent);
}
/* L0 — every section header lives at the same rhythm regardless of
 * whether it's the top-of-sidebar Overviews/Layers/Manage kicker or
 * an in-Layers sub-group bucket (Istio / Kubernetes / …). All wear
 * the spec voice (10/700/0.1em uppercase fg-3, 14px top padding) and
 * carry an icon on the left so the icon column stays aligned with
 * the L1 rows below — the eye doesn't have to jump positions when
 * scanning. No caret, no click — L0s are presentational. */
.sw-nav-section,
.sw-nav-section--icon {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--sw-fg-3);
}
.sw-nav-section--icon {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 14px 4px;
}
.sw-nav-section--icon :deep(svg) {
  /* Slightly larger than the 10px text so the glyph reads as a label
   * mark, not a punctuation dot. Inherits text colour (fg-3) so it
   * stays in the L0 voice. */
  width: 12px;
  height: 12px;
  flex: 0 0 12px;
  color: var(--sw-fg-3);
  opacity: 1;
}
/* Clickable section header — cascades through the first child layer
 * to its first tab. Hover lifts the text so the affordance reads. */
.sw-nav-section--clickable {
  cursor: pointer;
  user-select: none;
}
.sw-nav-section--clickable:hover,
.sw-nav-section--clickable:hover :deep(svg) {
  color: var(--sw-fg-1);
}
.layer-group-name { flex: 1; min-width: 0; }
/* Grouped and ungrouped layer rows sit at the same indent — the group
 * header already delineates the section, so no extra tree-style nest. */
.layer-row.in-group { }
.layer-children.in-group { }
.sw-nav-item {
  text-decoration: none;
}
.sw-nav-section-count {
  color: var(--sw-fg-3);
  font-weight: 500;
  font-size: 10.5px;
  text-transform: none;
  letter-spacing: 0;
}
.sw-nav-item.is-inactive > span {
  color: var(--sw-fg-3);
}
/* L1 overrides for `.sw-nav-item` at the top level of the sidebar.
 * Direct-child selector keeps it scoped so the global tokens-default
 * `.sw-nav-item.is-active` (bg-3) still applies on other surfaces. */
.sw-nav > .sw-nav-item {
  margin: 1px 8px;
  font-weight: 600;
}
.sw-nav > .sw-nav-item :deep(svg) {
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
  color: var(--sw-fg-2);
  opacity: 1;
}
.sw-nav > .sw-nav-item:hover {
  background: rgba(255, 255, 255, 0.04);
}
.sw-nav > .sw-nav-item.is-active {
  background: var(--sw-accent-soft);
  color: var(--sw-fg-0);
  box-shadow: inset 2px 0 0 var(--sw-accent);
}
.sw-nav > .sw-nav-item.is-active :deep(svg) {
  color: var(--sw-accent);
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
