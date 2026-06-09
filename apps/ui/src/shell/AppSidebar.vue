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
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import Icon, { type IconName } from '@/components/icons/Icon.vue';

const { t } = useI18n({ useScope: 'global' });
// Full "SkyWalking" wordmark + moon. The shipped file is white-fill
// (designed for dark backgrounds). For light-appearance themes we
// derive a blue (`#1368B3` — the official SkyWalking brand blue)
// variant by replacing the fill color in the raw SVG string. Keeps
// the SAME wordmark shape; just recolors. Avoids shipping a separate
// blue asset that could drift from the white one.
import logoSw from '@/assets/icons/logo-sw.svg?raw';
import { useThemeStore, AVAILABLE_THEMES } from '@/state/theme';

const logoSwBlue = logoSw.replace(/fill="#fff"/g, 'fill="#1368B3"');
import { useAuthStore } from '@/state/auth';
import { useLayers, firstLayerTab } from '@/shell/useLayers';
import { useLandingOrder } from '@/shell/useLandingOrder';
import { useOverviewDashboards } from '@/render/overview/useOverviewDashboards';
import { useDebugPanel } from '@/controls/debugPanel';
import { useSidebar } from '@/controls/sidebar';
import { useAlarmCount } from '@/shell/useAlarmCount';
import { useConfigBundle } from '@/controls/configBundle';

const { enabled: debugPanelEnabled, toggle: toggleDebugPanel } = useDebugPanel();
// Fold the whole menu to a thin rail; the shell grid follows suit.
const { collapsed: sidebarCollapsed, toggle: toggleSidebar } = useSidebar();
/* Shares the same composable as the topbar badge — one query feeds
 * both, so the two surfaces never disagree and the cache is warm
 * regardless of which renders first. */
const alarmCount = useAlarmCount();

const auth = useAuthStore();
const { bundle } = useConfigBundle();
const router = useRouter();
const themeStore = useThemeStore();
const isLightAppearance = computed<boolean>(
  () => AVAILABLE_THEMES.find((t) => t.id === themeStore.active)?.appearance === 'light',
);
async function signOut(): Promise<void> {
  await auth.logout();
  await router.push({ name: 'login' });
}

const { availableLayers, oapReachable, oapError, hasTopology } = useLayers();
const orderedLayers = useLandingOrder(availableLayers);
const { publicOverviews } = useOverviewDashboards();

import { sectionIcon, layerIcon as layerIconByKey } from './icons';
function layerIcon(L: SidebarLayer): IconName {
  return layerIconByKey(L.key);
}

type SidebarLayer = (typeof orderedLayers.value)[number];
function hasInstances(L: SidebarLayer): boolean {
  return L.caps.instances ?? Boolean(L.slots.instances);
}
function hasEndpoints(L: SidebarLayer): boolean {
  return L.caps.endpoints ?? Boolean(L.slots.endpoints);
}
/** A layer whose only worthwhile screen is the services list — no
 *  tabs to expand into. Rendered as a direct link, not an accordion. */
function isSingleFeatureLayer(L: SidebarLayer): boolean {
  if (hasInstances(L) || hasEndpoints(L)) return false;
  if (hasTopology(L)) return false;
  const c = L.caps;
  if (c.traces || c.logs || c.traceProfiling || c.ebpfProfiling || c.asyncProfiling || c.events) return false;
  if (c.endpointDependency || c.serviceMap || c.instanceTopology || c.processTopology) return false;
  return true;
}

const expandedLayer = ref<string | null>(null);
function toggleLayer(key: string): void {
  const wasExpanded = expandedLayer.value === key;
  expandedLayer.value = wasExpanded ? null : key;
  if (!wasExpanded) {
    const L = orderedLayers.value.find((l) => l.key === key);
    if (!L) return;
    const target = `/layer/${L.key}/${firstLayerTab(L)}`;
    if (route.path === target) return;
    if (route.path.startsWith(`/layer/${L.key}/`)) return;
    void router.push(target);
  }
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
// Public layers mirror the Overview/landing order (landing.priority) so
// the two surfaces stay in lockstep.
const publicLayers = computed(() =>
  orderedLayers.value.filter((L) => L.visibility !== 'operate'),
);
// Operate (Platform monitoring) layers follow the sidebar/menu placement
// — the BFF catalog order — NOT landing.priority. Landing priority is an
// Overview-page concept the operator can edit; it must not reorder the
// operate sidebar. `availableLayers` preserves the menu order as returned.
const operateLayers = computed(() =>
  availableLayers.value.filter((L) => L.visibility === 'operate'),
);
const sidebarEntries = computed<SidebarEntry[]>(() => bucket(publicLayers.value));

const route = useRoute();
// Case-insensitive: layer keys are UPPER_SNAKE in the menu/links but a
// URL may arrive lowercased (overview KPI tiles link lowercased, hand-typed
// URLs, etc.). Without normalising, the active row wouldn't get the accent
// colour and the auto-scroll couldn't find it.
const routePathLc = computed(() => route.path.toLowerCase());
function isActive(path: string): boolean {
  const p = path.toLowerCase();
  return routePathLc.value === p || routePathLc.value.startsWith(p + '/');
}
/** Use this — not {@link isActive} — for sibling routes where one is
 *  a prefix of another (e.g. `/operate/live-debug` vs
 *  `/operate/live-debug/history`); prefix-match would light both up. */
function isActiveExact(path: string): boolean {
  return routePathLc.value === path.toLowerCase();
}

// Only the layer the route currently points at is auto-expanded. We do
// NOT pre-expand the first layer (General) on a non-layer landing —
// expanding a section is an explicit user action (a click), and a
// default-open accordion misleads operators into thinking that layer is
// "selected" when they've navigated nowhere.
const navRef = ref<HTMLElement | null>(null);
/** Bring the route's active nav row into view (it may sit below the fold
 *  on a long sidebar). Waits a tick so the route-driven expand has
 *  rendered the L2 children that contain the active row. */
async function scrollActiveIntoView(): Promise<void> {
  await nextTick();
  // Both the layer row and its active child carry `.is-active`; scroll to
  // the LAST (deepest) one — the active tab — so it lands in view.
  // Exclude `.sw-nav-toggle` (the bottom "Debug events" button is
  // `.is-active` whenever the panel is on — default on localhost — and
  // being last in the DOM it would otherwise scroll the sidebar to the
  // very end on every navigation regardless of the clicked item).
  const actives = navRef.value?.querySelectorAll('.is-active:not(.sw-nav-toggle)');
  actives?.[actives.length - 1]?.scrollIntoView({ block: 'nearest' });
}

// Expand the layer the route points at AND scroll its active item into
// view — on entering a layer page (deep-link, reload, or in-app nav),
// not just the first paint. URL keys are lowercase; layer keys are
// UPPER_SNAKE — match case-insensitively.
watch(
  [() => route.path, orderedLayers],
  ([path, rows]) => {
    const m = path.match(/^\/layer\/([^/]+)/);
    if (m) {
      const L = rows.find((l) => l.key.toUpperCase() === m[1]!.toUpperCase());
      if (L) expandedLayer.value = L.key;
    }
    void scrollActiveIntoView();
  },
  { immediate: true },
);
onMounted(scrollActiveIntoView);

interface NavRow {
  icon: IconName;
  label: string;
  to: string;
  badge?: { text: string; kind?: 'ok' | 'warn' | 'err' | 'info' };
  /** Custom active-match; defaults to exact `path === to`. */
  activeWhen?: (path: string) => boolean;
  /** Present ⇒ row renders as an L1 expandable with these as L2. */
  children?: NavRow[];
  /** Optional verb gate — row is removed from the DOM when the user
   *  lacks it. UI-only filter; the BFF enforces the same verbs server-
   *  side, so hiding is a UX nicety, not security. */
  verb?: string;
}

interface NavSection {
  kicker: string;
  /** Stable identifier independent of locale — used by render-side
   *  filters that pick a specific section (e.g. the platform-monitoring
   *  block which is hoisted to the top of the operate area). Defaults
   *  to `'default'` for sections that don't need to be singled out. */
  kind?: 'platform' | 'operate' | 'setup' | 'admin' | 'default';
  links: NavRow[];
}

// Each static menu carries the read verb its page's primary data route
// requires (see apps/bff/src/rbac/route-policy.ts). The sidebar removes
// rows the user can't read; the BFF enforces the same verbs server-side.
//
// `sections` is a `computed`, not a module-level constant, so `t(...)`
// resolves against the CURRENT locale — otherwise label / kicker text
// would freeze at first render and a locale switch would only update
// strings used directly in the template, not these object-embedded ones.
const sections = computed<NavSection[]>(() => [
  // OAP self-observability diagnostics (the backend itself, not the
  // observed services). Rendered above the per-layer self-observability
  // dashboards. All three are read-only and gated on maintainer-tier verbs.
  {
    kind: 'platform',
    kicker: t('Platform monitoring'),
    links: [
      { icon: 'svc', label: t('Cluster status'), to: '/operate/cluster', verb: 'cluster:read' },
      { icon: 'clock', label: t('Data retention'), to: '/operate/ttl', verb: 'ttl:read' },
      { icon: 'db', label: t('OAP configuration'), to: '/operate/config', verb: 'config:read' },
    ],
  },
  {
    kind: 'operate',
    kicker: t('Operate'),
    links: [
      { icon: 'alert', label: t('Alerting rules'), to: '/operate/alerting-rules', verb: 'alarm-rule:read' },
      {
        icon: 'set',
        label: t('DSL management'),
        // No standalone landing — `to` jumps to the first rule page so
        // the L1 itself is clickable; activeWhen covers all DSL routes.
        to: '/operate/dsl/otel-rules',
        verb: 'rule:read',
        activeWhen: (p) => p === '/operate/oal' || /^\/operate\/dsl(\/|$)/.test(p),
        children: [
          { icon: 'set', label: 'MAL · OTEL', to: '/operate/dsl/otel-rules', verb: 'rule:read' },
          { icon: 'set', label: 'MAL · Telegraf', to: '/operate/dsl/telegraf-rules', verb: 'rule:read' },
          { icon: 'set', label: 'LAL', to: '/operate/dsl/lal', verb: 'rule:read' },
          { icon: 'set', label: 'LAL → MAL', to: '/operate/dsl/log-mal-rules', verb: 'rule:read' },
          { icon: 'trace', label: t('OAL · read-only'), to: '/operate/oal', verb: 'rule:read' },
          { icon: 'download', label: t('Dump & restore'), to: '/operate/dsl/dump', verb: 'rule:read' },
        ],
      },
      {
        icon: 'flame',
        label: t('Live debugger'),
        to: '/operate/live-debug',
        verb: 'live-debug:read',
        // Match the tab variants only; the history sibling at
        // /operate/live-debug/history must NOT highlight this row.
        activeWhen: (p) => p === '/operate/live-debug' || /^\/operate\/live-debug\/(mal|lal|oal)(\/|$)/.test(p),
      },
      { icon: 'event', label: t('Capture history'), to: '/operate/live-debug/history', verb: 'live-debug:read' },
      { icon: 'metric', label: t('Metrics inspect'), to: '/operate/inspect', verb: 'inspect:read' },
    ],
  },
  {
    kind: 'setup',
    kicker: t('Dashboard setup'),
    links: [
      { icon: 'set', label: t('Overview templates'), to: '/admin/overview-templates', verb: 'overview:write' },
      { icon: 'metric', label: t('Layer dashboards'), to: '/admin/layer-dashboards', verb: 'dashboard:read' },
      { icon: 'web', label: t('Translations'), to: '/admin/translations', verb: 'overview:write' },
      { icon: 'alert', label: t('Alert page'), to: '/admin/alert-page-setup', verb: 'alarm-setup:read' },
      { icon: 'set', label: t('3D Infra Map'), to: '/admin/3d-map', verb: 'overview:write' },
      { icon: 'set', label: t('Global defaults'), to: '/admin/global-defaults', verb: 'setup:read' },
    ],
  },
  {
    kind: 'admin',
    kicker: t('Admin'),
    links: [
      { icon: 'user', label: t('Users'), to: '/admin/users', verb: 'user:read' },
      { icon: 'set', label: t('Auth status'), to: '/admin/auth-status', verb: 'auth:read' },
      { icon: 'set', label: t('Roles & permissions'), to: '/admin/roles', verb: 'role:read' },
    ],
  },
]);

/**
 * Verb-filtered view of `sections`: rows with a `verb` the current user
 * lacks are removed; rows without a `verb` always show; sections that
 * end up empty are dropped so we don't render orphan headers.
 *
 * Hiding is a UX nicety — the BFF enforces the same verbs server-side,
 * so this is "don't show controls that won't work," not security.
 */
// Count of templates edited locally but not yet pushed to OAP
// (diverged = bundled differs from the stored remote). Drives the
// yellow "unsynced changes" warning on the template-admin menu rows.
function divergedCount(kind: 'layer' | 'overview'): number {
  const badges = bundle.value?.syncStatus?.badges ?? [];
  return badges.filter((b) => b.kind === kind && b.status === 'diverged').length;
}
/** True when this layer's template has local edits not yet published to
 *  OAP (diverged) — drives the yellow warning on its sidebar row. */
function isLayerDiverged(key: string): boolean {
  const badges = bundle.value?.syncStatus?.badges ?? [];
  return badges.some(
    (b) => b.kind === 'layer' && b.status === 'diverged' && b.key.toUpperCase() === key.toUpperCase(),
  );
}

/** Per-route warn badge for the template-admin rows. */
function syncBadgeFor(to: string): NavRow['badge'] | undefined {
  const kind = to === '/admin/layer-dashboards' ? 'layer' : to === '/admin/overview-templates' ? 'overview' : null;
  if (!kind) return undefined;
  const n = divergedCount(kind);
  return n > 0 ? { text: String(n), kind: 'warn' } : undefined;
}

const visibleSections = computed<NavSection[]>(() => {
  const out: NavSection[] = [];
  for (const sec of sections.value) {
    const links = sec.links
      .filter((r) => !r.verb || auth.hasVerb(r.verb))
      .map((r) => {
        const badge = syncBadgeFor(r.to);
        return badge ? { ...r, badge } : r;
      });
    if (links.length === 0) continue;
    out.push({ kind: sec.kind, kicker: sec.kicker, links });
  }
  return out;
});

// Platform monitoring (OAP self-observability) renders at the top of the
// operate area — above the per-layer self-observability dashboards — so
// it's pulled out of the generic section loop below. Identified by the
// locale-independent `kind` tag so the filter survives a language switch.
const platformSection = computed<NavSection | undefined>(() =>
  visibleSections.value.find((s) => s.kind === 'platform'),
);
const menuSections = computed<NavSection[]>(() =>
  visibleSections.value.filter((s) => s.kind !== 'platform'),
);

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
    for (const sec of sections.value) {
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
  <aside class="sw-side" :class="{ collapsed: sidebarCollapsed }">
    <!-- Expanded: original wordmark header (unchanged) + collapse toggle.
         Folded: the wordmark moves to the topbar (see AppTopbar); the rail
         keeps just the expand chevron in the same 44px header row. -->
    <div v-if="!sidebarCollapsed" class="sw-brand-row">
      <RouterLink to="/" class="sw-brand" aria-label="SkyWalking Horizon">
        <span class="brand-logo" v-html="isLightAppearance ? logoSwBlue : logoSw" />
        <small>Horizon</small>
      </RouterLink>
      <button
        type="button"
        class="side-toggle"
        :title="t('Collapse menu')"
        :aria-label="t('Collapse menu')"
        @click="toggleSidebar"
      >
        <Icon name="caret" :size="12" />
      </button>
    </div>
    <button
      v-else
      type="button"
      class="side-expand"
      :title="t('Show menu')"
      :aria-label="t('Show menu')"
      @click="toggleSidebar"
    >
      <Icon name="caret" :size="12" />
    </button>

    <nav v-show="!sidebarCollapsed" ref="navRef" class="sw-nav">
      <!-- Overviews are gated by `overview:read`. -->
      <template v-if="auth.hasVerb('overview:read')">
        <div class="sw-nav-section sw-nav-section--icon">
          <Icon :name="sectionIcon('Overviews')" />
          <span>{{ t('Overviews') }}</span>
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
      </template>
      <RouterLink
        v-if="auth.hasVerb('alarms:read')"
        to="/alarms"
        class="sw-nav-item"
        :class="{ 'is-active': isActive('/alarms') }"
      >
        <Icon name="alert" /><span>{{ t('Alarms') }}</span>
        <span
          v-if="alarmCount.activeIncidents.value > 0"
          class="sw-badge err"
          style="margin-left: auto"
        >{{ alarmCount.displayCount.value }}</span>
      </RouterLink>

      <div class="sw-nav-section sw-nav-section--icon" style="justify-content: space-between">
        <Icon :name="sectionIcon('Layers')" />
        <span style="flex: 1">{{ t('Layers') }}</span>
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
          <div class="sw-nav-section sw-nav-section--icon">
            <Icon :name="sectionIcon(E.label)" />
            <span class="layer-group-name">{{ E.label }}</span>
          </div>
          <template v-for="L in E.layers" :key="`${E.label}::${L.key}`">
              <RouterLink
                v-if="isSingleFeatureLayer(L)"
                :to="`/layer/${L.key}/${firstLayerTab(L)}`"
                class="layer-row direct in-group"
                :class="{ 'is-active': isActive(`/layer/${L.key}`) }"
              >
                <Icon :name="layerIcon(L)" />
                <span class="layer-name">{{ L.name }}</span>
                <span
                  v-if="isLayerDiverged(L.key)"
                  class="layer-warn"
                  :title="t('Local changes not published to OAP')"
                ><Icon name="alert" :size="11" /></span>
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
                <span
                  v-if="isLayerDiverged(L.key)"
                  class="layer-warn"
                  :title="t('Local changes not published to OAP')"
                ><Icon name="alert" :size="11" /></span>
                <span class="caret" :class="{ open: expandedLayer === L.key }">
                  <Icon name="caret" :size="10" />
                </span>
              </div>
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
                  v-if="hasInstances(L)"
                  :to="`/layer/${L.key}/instance`"
                  class="sw-nav-item"
                  :class="{ 'is-active': isActive(`/layer/${L.key}/instance`) }"
                >
                  <Icon name="prof" /><span>{{ L.slots.instances ?? 'Instance' }}</span>
                </RouterLink>
                <RouterLink
                  v-if="hasEndpoints(L)"
                  :to="`/layer/${L.key}/endpoint`"
                  class="sw-nav-item"
                  :class="{ 'is-active': isActive(`/layer/${L.key}/endpoint`) }"
                >
                  <Icon name="ep" /><span>{{ L.slots.endpoints ?? 'Endpoint' }}</span>
                </RouterLink>
                <RouterLink
                  v-if="hasTopology(L)"
                  :to="`/layer/${L.key}/topology`"
                  class="sw-nav-item"
                  :class="{ 'is-active': isActive(`/layer/${L.key}/topology`) }"
                >
                  <Icon name="topo" /><span>{{ L.slots.topology ?? 'Topology' }}</span>
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
                  v-if="L.caps.traces && L.traces?.source === 'both'"
                  :to="`/layer/${L.key}/zipkin-trace`"
                  class="sw-nav-item"
                  :class="{ 'is-active': isActive(`/layer/${L.key}/zipkin-trace`) }"
                >
                  <Icon name="trace" /><span>OTel &amp; Zipkin Trace</span>
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
                  v-if="L.caps.podLogs"
                  :to="`/layer/${L.key}/pod-logs`"
                  class="sw-nav-item"
                  :class="{ 'is-active': isActive(`/layer/${L.key}/pod-logs`) }"
                >
                  <Icon name="log" /><span>Pod Logs</span>
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
                <RouterLink
                  v-if="L.caps.networkProfiling"
                  :to="`/layer/${L.key}/network-profiling`"
                  class="sw-nav-item"
                  :class="{ 'is-active': isActive(`/layer/${L.key}/network-profiling`) }"
                >
                  <Icon name="prof" /><span>Network Profiling</span>
                </RouterLink>
                <RouterLink
                  v-if="L.caps.pprofProfiling"
                  :to="`/layer/${L.key}/pprof`"
                  class="sw-nav-item"
                  :class="{ 'is-active': isActive(`/layer/${L.key}/pprof`) }"
                >
                  <Icon name="prof" /><span>pprof (Go)</span>
                </RouterLink>
              </div>
            </template>
        </template>

        <!-- Ungrouped single-feature layer: direct link. -->
        <RouterLink
          v-else-if="isSingleFeatureLayer(E.layer)"
          :to="`/layer/${E.layer.key}/${firstLayerTab(E.layer)}`"
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
            v-if="hasInstances(E.layer)"
            :to="`/layer/${E.layer.key}/instance`"
            class="sw-nav-item"
            :class="{ 'is-active': isActive(`/layer/${E.layer.key}/instance`) }"
          >
            <Icon name="prof" /><span>{{ E.layer.slots.instances ?? 'Instance' }}</span>
          </RouterLink>
          <RouterLink
            v-if="hasEndpoints(E.layer)"
            :to="`/layer/${E.layer.key}/endpoint`"
            class="sw-nav-item"
            :class="{ 'is-active': isActive(`/layer/${E.layer.key}/endpoint`) }"
          >
            <Icon name="ep" /><span>{{ E.layer.slots.endpoints ?? 'Endpoint' }}</span>
          </RouterLink>
          <RouterLink
            v-if="hasTopology(E.layer)"
            :to="`/layer/${E.layer.key}/topology`"
            class="sw-nav-item"
            :class="{ 'is-active': isActive(`/layer/${E.layer.key}/topology`) }"
          >
            <Icon name="topo" /><span>{{ E.layer.slots.topology ?? 'Topology' }}</span>
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
            v-if="E.layer.caps.traces && E.layer.traces?.source === 'both'"
            :to="`/layer/${E.layer.key}/zipkin-trace`"
            class="sw-nav-item"
            :class="{ 'is-active': isActive(`/layer/${E.layer.key}/zipkin-trace`) }"
          >
            <Icon name="trace" /><span>OTel &amp; Zipkin Traces</span>
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
            v-if="E.layer.caps.podLogs"
            :to="`/layer/${E.layer.key}/pod-logs`"
            class="sw-nav-item"
            :class="{ 'is-active': isActive(`/layer/${E.layer.key}/pod-logs`) }"
          >
            <Icon name="log" /><span>Pod Logs</span>
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
            v-if="E.layer.caps.networkProfiling"
            :to="`/layer/${E.layer.key}/network-profiling`"
            class="sw-nav-item"
            :class="{ 'is-active': isActive(`/layer/${E.layer.key}/network-profiling`) }"
          >
            <Icon name="prof" /><span>Network Profiling</span>
          </RouterLink>
          <RouterLink
            v-if="E.layer.caps.pprofProfiling"
            :to="`/layer/${E.layer.key}/pprof`"
            class="sw-nav-item"
            :class="{ 'is-active': isActive(`/layer/${E.layer.key}/pprof`) }"
          >
            <Icon name="prof" /><span>pprof (Go)</span>
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

      <!-- Platform monitoring — OAP self-observability under one header:
           backend diagnostics (cluster status, data retention, runtime
           config) on top, then the per-layer so11y_* agent dashboards.
           Maintainer tier: diagnostics rows are verb-gated individually;
           the layer dashboards gate on `cluster:read` (granted to
           maintainer / operator / admin, not viewer). -->
      <template v-if="platformSection || (operateLayers.length > 0 && auth.hasVerb('cluster:read'))">
        <div class="sw-nav-section sw-nav-section--icon">
          <Icon :name="sectionIcon('Platform monitoring')" />
          <span>{{ t('Platform monitoring') }}</span>
        </div>
        <template v-if="platformSection">
          <RouterLink
            v-for="row in platformSection.links"
            :key="row.to"
            :to="row.to"
            class="sw-nav-item"
            :class="{ 'is-active': row.activeWhen ? row.activeWhen(route.path) : isActiveExact(row.to) }"
          >
            <Icon :name="row.icon" /><span>{{ row.label }}</span>
          </RouterLink>
        </template>
        <template v-if="operateLayers.length > 0 && auth.hasVerb('cluster:read')">
        <template v-for="L in operateLayers" :key="`op:${L.key}`">
          <RouterLink
            v-if="isSingleFeatureLayer(L)"
            :to="`/layer/${L.key}/${firstLayerTab(L)}`"
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
            v-if="!isSingleFeatureLayer(L) && expandedLayer === L.key"
            class="layer-children"
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
              v-if="hasInstances(L)"
              :to="`/layer/${L.key}/instance`"
              class="sw-nav-item"
              :class="{ 'is-active': isActive(`/layer/${L.key}/instance`) }"
            >
              <Icon name="prof" /><span>{{ L.slots.instances ?? 'Instance' }}</span>
            </RouterLink>
            <RouterLink
              v-if="hasEndpoints(L)"
              :to="`/layer/${L.key}/endpoint`"
              class="sw-nav-item"
              :class="{ 'is-active': isActive(`/layer/${L.key}/endpoint`) }"
            >
              <Icon name="ep" /><span>{{ L.slots.endpoints ?? 'Endpoint' }}</span>
            </RouterLink>
          </div>
        </template>
        </template>
      </template>

      <template v-for="entry in menuSections" :key="`m:${entry.kicker}`">
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
        <!-- Toggle row appended to the bottom of the Admin section —
             controls the bottom-fixed DebugEventPanel. Default state
             is hostname-driven (on for localhost, off elsewhere) and
             sticks via localStorage. Rendered as a plain button so
             clicks fire the store toggle rather than navigating. -->
        <button
          v-if="entry.kicker === 'Admin'"
          type="button"
          class="sw-nav-item sw-nav-toggle"
          :class="{ 'is-active': debugPanelEnabled }"
          @click="toggleDebugPanel"
        >
          <Icon name="event" />
          <span>{{ t('Debug events') }}</span>
          <span class="sw-badge" :class="debugPanelEnabled ? 'ok' : ''" style="margin-left: auto">
            {{ debugPanelEnabled ? 'on' : 'off' }}
          </span>
        </button>
      </template>
    </nav>

    <div v-show="!sidebarCollapsed" class="sw-side-foot">
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
      <button v-if="auth.isAuthenticated" class="sw-btn is-icon" :title="t('Sign out')" @click="signOut">
        <Icon name="share" :size="12" />
      </button>
    </div>
  </aside>
</template>

<style scoped>
/* Brand + collapse toggle share the 44px top row (aligns with the
 * topbar). Shown only while expanded; when folded the row is replaced by
 * the expand chevron and the wordmark moves to the topbar. */
.sw-brand-row {
  display: flex;
  align-items: center;
  height: 44px;
  border-bottom: 1px solid var(--sw-line);
}
.sw-brand,
.sw-brand:hover {
  text-decoration: none;
  color: inherit;
  /* Border + height now live on .sw-brand-row; override the global
   * .sw-brand so we don't double the border or the height. */
  flex: 1;
  min-width: 0;
  height: auto;
  border-bottom: none;
  overflow: hidden;
}
.side-toggle {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  margin: 0 9px;
  display: inline-grid;
  place-items: center;
  background: transparent;
  border: none;
  border-radius: 5px;
  color: var(--sw-fg-3);
  cursor: pointer;
}
.side-toggle:hover { background: var(--sw-bg-2); color: var(--sw-fg-1); }
/* caret base glyph points down — rotate to a left chevron (collapse). */
.side-toggle :deep(svg) { transition: transform 0.15s; transform: rotate(90deg); }
/* Folded rail: the expand chevron occupies the 44px header row (aligns
 * with the topbar, where the wordmark now lives). */
.side-expand {
  width: 100%;
  height: 44px;
  display: grid;
  place-items: center;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--sw-line);
  color: var(--sw-fg-3);
  cursor: pointer;
}
.side-expand:hover { background: var(--sw-bg-2); color: var(--sw-fg-1); }
.side-expand :deep(svg) { transform: rotate(-90deg); }
.brand-logo {
  display: inline-flex;
  align-items: center;
  color: var(--sw-fg-0);
}
/* Logo SVG variant is chosen in <script setup> via v-html, not via
 * CSS scoping. See `isLightAppearance` above. */
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
.layer-warn {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  margin: 0 2px 0 4px;
}
.layer-row .layer-warn :deep(svg) {
  width: 12px;
  height: 12px;
  flex: 0 0 12px;
  color: #facc15;
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
/* Toggle row at the bottom of the Admin section — a <button> styled
 * to blend with the surrounding .sw-nav-item links. Cursor is
 * `pointer` (vs default `default` on RouterLinks) to flag the
 * affordance, and `.is-active` reuses the same accent stripe so
 * "on" reads consistently with selected nav items. */
.sw-nav-toggle {
  width: 100%;
  min-width: 0;
  background: transparent;
  border: none;
  font: inherit;
  text-align: left;
  cursor: pointer;
  /* Defensive: keep the label + badge inside the sidebar even if
   * future copy grows. Combined with `.sw-nav` overflow-x: hidden,
   * the row clips cleanly instead of forcing a horizontal scroll. */
  overflow: hidden;
}
.sw-nav-toggle > span:not(.sw-badge) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sw-nav-toggle .sw-badge.ok {
  color: var(--sw-ok);
  background: rgba(34, 197, 94, 0.12);
}
</style>
