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
import { computed } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import Icon, { type IconName } from '@/components/icons/Icon.vue';

const { t } = useI18n({ useScope: 'global' });
// The shipped SVG is white-fill (for dark backgrounds). Light-appearance
// themes derive a brand-blue (`#1368B3`) variant by recoloring the raw
// SVG string, so the two never drift from a separate asset.
import logoSw from '@/assets/icons/logo-sw.svg?raw';
import { useThemeStore, AVAILABLE_THEMES } from '@/state/theme';

const logoSwBlue = logoSw.replace(/fill="#fff"/g, 'fill="#1368B3"');
import { useAuthStore } from '@/state/auth';
import { useLayers, isSingleFeatureLayer } from '@/shell/useLayers';
import { useLandingOrder } from '@/shell/useLandingOrder';
import { useOverviewDashboards } from '@/render/overview/useOverviewDashboards';
import { useDebugPanel } from '@/controls/debugPanel';
import { useSidebar } from '@/controls/sidebar';
import { useAlarmCount } from '@/shell/useAlarmCount';
import { useConfigBundle } from '@/controls/configBundle';

const { enabled: debugPanelEnabled, toggle: toggleDebugPanel } = useDebugPanel();
const { collapsed: sidebarCollapsed, toggle: toggleSidebar } = useSidebar();
// Shares the same composable as the topbar badge — one query feeds both,
// so the two surfaces never disagree regardless of which renders first.
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

const { availableLayers, oapReachable, oapError } = useLayers();
const orderedLayers = useLandingOrder(availableLayers);
const { publicOverviews } = useOverviewDashboards();

import { sectionIcon } from './icons';
import SidebarLayerRow from './SidebarLayerRow.vue';
import SidebarLayerChildren from './SidebarLayerChildren.vue';
import { useSidebarActive } from './useSidebarActive';
import { useSidebarMenu } from './useSidebarMenu';

type SidebarLayer = (typeof orderedLayers.value)[number];

const { route, isActive, isActiveExact, expandedLayer, toggleLayer, navRef } =
  useSidebarActive(orderedLayers);

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

const { platformSection, menuSections, isNavL1Open, toggleNavL1 } = useSidebarMenu();

// True when this layer's template has local edits not yet published to OAP
// (diverged) — drives the yellow warning on its grouped sidebar row.
function isLayerDiverged(key: string): boolean {
  const badges = bundle.value?.syncStatus?.badges ?? [];
  return badges.some(
    (b) => b.kind === 'layer' && b.status === 'diverged' && b.key.toUpperCase() === key.toUpperCase(),
  );
}
</script>

<template>
  <aside class="sw-side" :class="{ collapsed: sidebarCollapsed }">
    <!-- When folded, the wordmark moves to the topbar (see AppTopbar) and
         the rail keeps just the expand chevron in the 44px header row. -->
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
            <SidebarLayerRow
              :layer="L"
              variant="grouped"
              :expanded="expandedLayer === L.key"
              :diverged="isLayerDiverged(L.key)"
              @toggle="toggleLayer"
            />
            <SidebarLayerChildren
              v-if="!isSingleFeatureLayer(L) && expandedLayer === L.key"
              :layer="L"
              in-group
            />
          </template>
        </template>

        <!-- Ungrouped single-feature layer OR expandable accordion head. -->
        <SidebarLayerRow
          v-else
          :layer="E.layer"
          variant="ungrouped"
          :expanded="expandedLayer === E.layer.key"
          @toggle="toggleLayer"
        />
        <SidebarLayerChildren
          v-if="E.kind === 'single' && !isSingleFeatureLayer(E.layer) && expandedLayer === E.layer.key"
          :layer="E.layer"
        />
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
            <SidebarLayerRow
              :layer="L"
              variant="operate"
              :expanded="expandedLayer === L.key"
              @toggle="toggleLayer"
            />
            <SidebarLayerChildren
              v-if="!isSingleFeatureLayer(L) && expandedLayer === L.key"
              :layer="L"
            />
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
        <!-- Controls the bottom-fixed DebugEventPanel. Default state is
             hostname-driven (on for localhost, off elsewhere). A plain
             button, not a link, so clicks toggle rather than navigate. -->
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
/* L0 — section headers (top-of-sidebar kickers AND in-Layers sub-group
 * buckets) share one rhythm and carry a left icon so the icon column
 * stays aligned with the L1 rows below. Presentational: no caret, no click. */
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
