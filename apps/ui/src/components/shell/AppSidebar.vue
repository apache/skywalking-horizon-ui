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
import { useAuthStore } from '@/stores/auth';
import { useLayers, firstLayerTab } from '@/composables/useLayers';
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
  if (c.traces || c.logs || c.traceProfiling || c.ebpfProfiling || c.asyncProfiling || c.events) return false;
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

// Bucket the ordered layer list by the template's `group` field so the
// sidebar renders a single section per group (Istio / Kubernetes / AWS
// / …) instead of dumping every layer flat. Ungrouped layers (general,
// browser) are surfaced first at the top. Group sections are
// independently collapsible — clicking one toggles its open state.
interface LayerGroup { kind: 'group'; label: string; layers: SidebarLayer[] }
interface LayerSingle { kind: 'single'; layer: SidebarLayer }
type SidebarEntry = LayerGroup | LayerSingle;
const sidebarEntries = computed<SidebarEntry[]>(() => {
  const out: SidebarEntry[] = [];
  const groupBuckets = new Map<string, SidebarLayer[]>();
  // Preserve the source order — first time we see a group, that's
  // where its section lands in the sidebar.
  for (const L of orderedLayers.value) {
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
});
const openGroups = ref<Set<string>>(new Set());
function isGroupOpen(label: string): boolean { return openGroups.value.has(label); }
// Plain toggle — click open if closed, click close if open. Opening
// also navigates to the first layer's Service page so the operator
// lands on actionable content; closing is purely a section collapse
// (no nav, so they don't get yanked away from their current page).
function toggleGroup(label: string, layers: SidebarLayer[]): void {
  const wasOpen = openGroups.value.has(label);
  const next = new Set(openGroups.value);
  if (wasOpen) next.delete(label);
  else next.add(label);
  openGroups.value = next;
  if (!wasOpen && layers[0]) {
    void router.push(`/layer/${layers[0].key}/${firstLayerTab(layers[0])}`);
  }
}

const route = useRoute();
function isActive(path: string): boolean {
  return route.path === path || route.path.startsWith(path + '/');
}

// Auto-open the group that contains the active layer so reload-on-URL
// doesn't hide the user's current location behind a collapsed section.
watch(
  () => route.path,
  () => {
    const m = route.path.match(/^\/layer\/([^/]+)/);
    if (!m) return;
    const key = m[1];
    const L = orderedLayers.value.find((l) => l.key === key);
    if (L?.group && !openGroups.value.has(L.group)) {
      openGroups.value = new Set([...openGroups.value, L.group]);
    }
  },
  { immediate: true },
);

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
      <template v-for="(E, ei) in sidebarEntries" :key="E.kind === 'group' ? `g:${E.label}` : `s:${E.layer.key}:${ei}`">
        <!-- Grouped layers: collapsible section header + nested layer
             rows. Group is identified by the layer template's `group`
             field; expanding shows the same row UI as ungrouped layers. -->
        <template v-if="E.kind === 'group'">
          <div
            class="layer-group"
            :class="{ 'is-open': isGroupOpen(E.label) }"
            @click="toggleGroup(E.label, E.layers)"
          >
            <span class="layer-group-name">{{ E.label }}</span>
            <span class="caret" :class="{ open: isGroupOpen(E.label) }">
              <Icon name="caret" :size="10" />
            </span>
          </div>
          <template v-if="isGroupOpen(E.label)">
            <template v-for="L in E.layers" :key="`${E.label}::${L.key}`">
              <!-- Same per-layer markup as the ungrouped path. -->
              <RouterLink
                v-if="isSingleFeatureLayer(L)"
                :to="`/layer/${L.key}/${firstLayerTab(L)}`"
                class="layer-row direct in-group"
                :class="{ 'is-active': isActive(`/layer/${L.key}`) }"
              >
                <span class="layer-dot" :style="{ background: L.color }" />
                <span class="layer-name">{{ L.name }}</span>
              </RouterLink>
              <div
                v-else
                class="layer-row in-group"
                :class="{ 'is-active': expandedLayer === L.key }"
                @click="toggleLayer(L.key)"
              >
                <span class="layer-dot" :style="{ background: L.color }" />
                <span class="layer-name" :style="{ fontWeight: expandedLayer === L.key ? 600 : 500 }">
                  {{ L.name }}
                </span>
                <span class="caret" :class="{ open: expandedLayer === L.key }">
                  <Icon name="caret" :size="10" />
                </span>
              </div>
              <!-- Children of a multi-feature grouped layer slot in below
                   the row, indented one level deeper than ungrouped layers'
                   children so the visual hierarchy stays legible. -->
              <div
                v-if="!isSingleFeatureLayer(L) && expandedLayer === L.key"
                class="layer-children in-group"
              >
                <RouterLink
                  v-if="L.caps.dashboards"
                  :to="`/layer/${L.key}/${firstLayerTab(L)}`"
                  class="sw-nav-item"
                  :class="{ 'is-active': isActive(`/layer/${L.key}/${firstLayerTab(L)}`) || route.path === `/layer/${L.key}` }"
                >
                  <Icon name="svc" /><span>Service</span>
                  <span class="sw-badge" style="margin-left: auto">{{ L.serviceCount }}</span>
                </RouterLink>
                <RouterLink
                  v-if="L.slots.instances"
                  :to="`/layer/${L.key}/instance`"
                  class="sw-nav-item"
                  :class="{ 'is-active': isActive(`/layer/${L.key}/instance`) }"
                >
                  <Icon name="prof" /><span>{{ L.slots.instances }}</span>
                </RouterLink>
                <RouterLink
                  v-if="L.slots.endpoints"
                  :to="`/layer/${L.key}/endpoint`"
                  class="sw-nav-item"
                  :class="{ 'is-active': isActive(`/layer/${L.key}/endpoint`) }"
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
                  <Icon name="ep" /><span>{{ L.slots.endpointDependency || 'Dependency' }}</span>
                </RouterLink>
                <RouterLink
                  v-if="L.caps.traces"
                  :to="`/layer/${L.key}/trace`"
                  class="sw-nav-item"
                  :class="{ 'is-active': isActive(`/layer/${L.key}/trace`) }"
                >
                  <Icon name="trace" /><span>Trace</span>
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
                  v-if="L.caps.traceProfiling"
                  :to="`/layer/${L.key}/trace-profiling`"
                  class="sw-nav-item"
                  :class="{ 'is-active': isActive(`/layer/${L.key}/trace-profiling`) }"
                >
                  <Icon name="prof" /><span>Trace Profiling</span>
                </RouterLink>
                <RouterLink
                  v-if="L.caps.ebpfProfiling"
                  :to="`/layer/${L.key}/ebpf-profiling`"
                  class="sw-nav-item"
                  :class="{ 'is-active': isActive(`/layer/${L.key}/ebpf-profiling`) }"
                >
                  <Icon name="prof" /><span>eBPF Profiling</span>
                </RouterLink>
                <RouterLink
                  v-if="L.caps.asyncProfiling"
                  :to="`/layer/${L.key}/async-profiling`"
                  class="sw-nav-item"
                  :class="{ 'is-active': isActive(`/layer/${L.key}/async-profiling`) }"
                >
                  <Icon name="prof" /><span>Async Profiling</span>
                </RouterLink>
              </div>
            </template>
          </template>
        </template>

        <!-- Ungrouped single-feature layer: direct link. -->
        <RouterLink
          v-else-if="isSingleFeatureLayer(E.layer)"
          :to="`/layer/${E.layer.key}/${firstLayerTab(E.layer)}`"
          class="layer-row direct"
          :class="{ 'is-active': isActive(`/layer/${E.layer.key}`) }"
        >
          <span class="layer-dot" :style="{ background: E.layer.color }" />
          <span class="layer-name">{{ E.layer.name }}</span>
        </RouterLink>

        <!-- Ungrouped multi-feature layer: rendered as its own implicit
             section header so the visual hierarchy stays consistent
             with grouped sections. The "row" sits at the same level as
             group headers (ISTIO / DATABASES / …); the tabs slot in
             beneath it as the section's children. -->
        <div
          v-else
          class="layer-group standalone"
          :class="{ 'is-open': expandedLayer === E.layer.key }"
          @click="toggleLayer(E.layer.key)"
        >
          <span class="layer-dot" :style="{ background: E.layer.color }" />
          <span class="layer-group-name">{{ E.layer.name }}</span>
          <span class="caret" :class="{ open: expandedLayer === E.layer.key }">
            <Icon name="caret" :size="10" />
          </span>
        </div>
        <!-- Children for the ungrouped multi-feature path. The grouped
             path renders its own children block above, indented one
             level deeper. -->
        <div
          v-if="E.kind === 'single' && !isSingleFeatureLayer(E.layer) && expandedLayer === E.layer.key"
          class="layer-children"
        >
          <RouterLink
            v-if="E.layer.caps.dashboards"
            :to="`/layer/${E.layer.key}/${firstLayerTab(E.layer)}`"
            class="sw-nav-item"
            :class="{ 'is-active': isActive(`/layer/${E.layer.key}/${firstLayerTab(E.layer)}`) || route.path === `/layer/${E.layer.key}` }"
          >
            <Icon name="svc" /><span>Service</span>
            <span class="sw-badge" style="margin-left: auto">{{ E.layer.serviceCount }}</span>
          </RouterLink>
          <RouterLink
            v-if="E.layer.slots.instances"
            :to="`/layer/${E.layer.key}/instance`"
            class="sw-nav-item"
            :class="{ 'is-active': isActive(`/layer/${E.layer.key}/instance`) }"
          >
            <Icon name="prof" /><span>{{ E.layer.slots.instances }}</span>
          </RouterLink>
          <RouterLink
            v-if="E.layer.slots.endpoints"
            :to="`/layer/${E.layer.key}/endpoint`"
            class="sw-nav-item"
            :class="{ 'is-active': isActive(`/layer/${E.layer.key}/endpoint`) }"
          >
            <Icon name="ep" /><span>{{ E.layer.slots.endpoints }}</span>
          </RouterLink>
          <RouterLink
            v-if="hasTopology(E.layer)"
            :to="`/layer/${E.layer.key}/topology`"
            class="sw-nav-item"
            :class="{ 'is-active': isActive(`/layer/${E.layer.key}/topology`) }"
          >
            <Icon name="topo" /><span>Topology</span>
          </RouterLink>
          <RouterLink
            v-if="E.layer.caps.endpointDependency"
            :to="`/layer/${E.layer.key}/dependency`"
            class="sw-nav-item"
            :class="{ 'is-active': isActive(`/layer/${E.layer.key}/dependency`) }"
          >
            <Icon name="ep" /><span>{{ E.layer.slots.endpointDependency ?? `${E.layer.slots.endpoints ?? 'Endpoint'} dependency` }}</span>
          </RouterLink>
          <RouterLink
            v-if="E.layer.caps.traces"
            :to="`/layer/${E.layer.key}/trace`"
            class="sw-nav-item"
            :class="{ 'is-active': isActive(`/layer/${E.layer.key}/trace`) }"
          >
            <Icon name="trace" /><span>Traces</span>
          </RouterLink>
          <RouterLink
            v-if="E.layer.caps.logs"
            :to="`/layer/${E.layer.key}/logs`"
            class="sw-nav-item"
            :class="{ 'is-active': isActive(`/layer/${E.layer.key}/logs`) }"
          >
            <Icon name="log" /><span>Logs</span>
          </RouterLink>
          <RouterLink
            v-if="E.layer.caps.traceProfiling"
            :to="`/layer/${E.layer.key}/trace-profiling`"
            class="sw-nav-item"
            :class="{ 'is-active': isActive(`/layer/${E.layer.key}/trace-profiling`) }"
          >
            <Icon name="flame" /><span>Trace Profiling</span>
          </RouterLink>
          <RouterLink
            v-if="E.layer.caps.ebpfProfiling"
            :to="`/layer/${E.layer.key}/ebpf-profiling`"
            class="sw-nav-item"
            :class="{ 'is-active': isActive(`/layer/${E.layer.key}/ebpf-profiling`) }"
          >
            <Icon name="flame" /><span>eBPF Profiling</span>
          </RouterLink>
          <RouterLink
            v-if="E.layer.caps.asyncProfiling"
            :to="`/layer/${E.layer.key}/async-profiling`"
            class="sw-nav-item"
            :class="{ 'is-active': isActive(`/layer/${E.layer.key}/async-profiling`) }"
          >
            <Icon name="flame" /><span>Async Profiling</span>
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
/* Sidebar group header (e.g. "Istio", "Databases", "AWS"). Collapsible
   section that buckets layer rows sharing the template's `group` field.
   Visually quieter than a layer row — the layer rows beneath it stay
   the primary affordance. */
.layer-group {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px 5px;
  margin-top: 8px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  /* The section header IS the navigational anchor — operators rely on
   * it to find the right layer family — so it needs to be legible at
   * a glance. We previously dimmed it to `--sw-fg-3` which made the
   * grouped sections (ISTIO / DATABASES / …) read like throwaway
   * dividers; now it stays in `--sw-fg-2` baseline and brightens to
   * `--sw-fg-0` on hover/open with a 2-px accent rule on the left so
   * the section boundary is unambiguous. */
  color: var(--sw-fg-2);
  cursor: pointer;
  user-select: none;
  border-left: 2px solid transparent;
  border-radius: 0 4px 4px 0;
}
.layer-group:hover { color: var(--sw-fg-0); border-left-color: var(--sw-line-2); }
.layer-group.is-open {
  color: var(--sw-fg-0);
  border-left-color: var(--sw-accent);
}
.layer-group-name { flex: 1; min-width: 0; }
/* Standalone variant — ungrouped multi-feature layers (General /
   Browser today) render as their own implicit section header so they
   read as siblings of ISTIO / DATABASES / etc. The colored layer dot
   sits before the name; styling stays in the group-header voice. */
.layer-group.standalone {
  padding: 7px 12px 5px;
}
.layer-group.standalone .layer-dot {
  /* Slightly bigger so the dot reads at the section-header type size. */
  width: 8px;
  height: 8px;
  flex: 0 0 8px;
}
/* Layer rows nested inside a group section get a left indent + dashed
   guide rule so the visual hierarchy reads at a glance. */
.layer-row.in-group {
  margin-left: 10px;
  padding-left: 10px;
  border-left: 1px dashed var(--sw-line-2);
}
.layer-children.in-group {
  margin-left: 28px;
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
