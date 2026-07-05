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
<!--
  Smartscape focus + context + suggestions overlay.

  The overlay re-draws the focused hex at the SAME screen position +
  same scale as the topology hex underneath (the live topology zoom
  transform is mirrored onto the overlay's content group), then fans
  hierarchy peers vertically around that origin:

    - upper-level peers (request-near, higher OAP `level`) sit ABOVE
    - lower-level peers (infra-near) sit BELOW
    - same-level peers spread horizontally in the same lane

  Sort matches booster-ui's `computeHierarchyLevels()` (level DESC).
  Service names use `resolveServiceIdentity` against each peer's own
  layer naming rule, so the base / cluster / legacy-group display
  matches what the topology renders for the same service.

  The basic topology stays visible under a dim layer for spatial
  context; the global auto-refresh ticker is paused while the overlay
  is open so nothing shifts under the focus (see hierarchyStore).
-->
<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import type {
  HierarchyPeer,
  LayerLevel,
  ServiceNamingRule,
} from '@skywalking-horizon-ui/api-client';
import { firstLayerTab, useLayers } from '@/shell/useLayers';
import { pushEvent } from '@/controls/eventLog';
import { resolveServiceIdentity, type ServiceIdentity } from '@/utils/serviceName';
import { useServiceHierarchy } from './useServiceHierarchy';
import { useHierarchyOverlayStore } from './hierarchyStore';

const props = defineProps<{
  /** Topology viewBox dimensions — shared so the overlay's SVG
   *  anchors on the same screen rectangle as the topology underneath. */
  viewBoxW: number;
  viewBoxH: number;
  /** Resolver: `nodePos` lookup for the focused id. Returns null
   *  while a layer/service swap is mid-flight after a peer click. */
  resolveNodePos: (id: string) => { cx: number; cy: number } | null;
  /** Whether the host layer's template surfaces the legacy
   *  `<group>::` prefix as a chip — mirrored on the overlay so its
   *  service-name affordances match the topology's. */
  showLegacyGroup?: boolean;
  /** STANDALONE mode: render the Smartscape fan on its own (the AI chat's
   *  hierarchy block) with NO topology underneath — no dim, no d3-zoom mirror,
   *  no store. The focus comes from `focus` and the fan is centred + auto-fit
   *  into the SVG's own viewBox. Everything store/topology-specific below is
   *  guarded on this, so the interactive topology overlay is unchanged. */
  standalone?: boolean;
  focus?: { serviceId: string; layer: string; serviceName: string };
}>();

const store = useHierarchyOverlayStore();
const { layers: allLayers, findLayer } = useLayers();

// Focus + open state come from props in standalone mode, else the shared store.
const fLayer = computed<string | null>(() => (props.standalone ? props.focus?.layer : store.focusLayer) ?? null);
const fServiceId = computed<string | null>(() => (props.standalone ? props.focus?.serviceId : store.focusServiceId) ?? null);
const fServiceName = computed<string | null>(
  () => (props.standalone ? props.focus?.serviceName : store.focusServiceName) ?? null,
);
const isOpen = computed<boolean>(() => (props.standalone ? true : store.isOpen));

const layerKey = computed(() => (fLayer.value ?? '').toLowerCase());
const focusServiceId = computed(() => fServiceId.value);
const { data, isLoading } = useServiceHierarchy(layerKey, focusServiceId);

/** Look up a layer's color from the menu registry; fall back to the
 *  accent for layers we don't have an entry for (e.g. SO11Y_OAP). */
function colorForLayer(layer: string): string {
  const def = allLayers.value.find((L) => L.key.toUpperCase() === layer.toUpperCase());
  return def?.color ?? 'var(--sw-accent)';
}

function labelForLayer(layer: string): string {
  const def = allLayers.value.find((L) => L.key.toUpperCase() === layer.toUpperCase());
  return def?.name ?? layer;
}

/** Per-layer naming rule — the same `LayerDef.naming` the topology
 *  feeds into `resolveServiceIdentity` for that layer's nodes. Lets
 *  the overlay render `mesh-svr::reviews.default` as `reviews` with
 *  `default` cluster chip + `mesh-svr` legacy-group chip, exactly the
 *  way the layer's own service-map renders it. */
function namingForLayer(layer: string): ServiceNamingRule | null {
  const def = allLayers.value.find((L) => L.key.toUpperCase() === layer.toUpperCase());
  return def?.naming ?? null;
}

function identityFor(name: string, layer: string): ServiceIdentity {
  return resolveServiceIdentity(name, namingForLayer(layer));
}

/** Focus position in topology viewBox coords — same value the
 *  topology's `nodePos` exposes, BEFORE the zoom transform. We apply
 *  the zoom to the overlay's content group below, so the focus hex
 *  visually overlaps the underlying hex pixel-for-pixel. */
const focusPos = computed(() => {
  // Standalone: the fan is centred on the origin and the whole thing is fit into
  // the SVG viewBox below — there is no topology node to anchor to.
  if (props.standalone) return { cx: 0, cy: 0 };
  const id = focusServiceId.value;
  return id ? props.resolveNodePos(id) : null;
});

/** Mirror the topology's live d3 zoom transform onto the overlay so
 *  focus + peers track pan/zoom of the underlying topology. Identity when
 *  standalone (the viewBox does the scaling). */
const zoomTransform = computed(() => {
  if (props.standalone) return 'translate(0, 0) scale(1)';
  const z = store.zoom;
  return `translate(${z.x}, ${z.y}) scale(${z.k})`;
});

/** Vertical lane spacing in TOPOLOGY pixel units — the topology zoom
 *  transform scales this in screen space, so the lane spacing
 *  visually tracks the topology's own node spacing regardless of
 *  zoom. */
const LANE_DY = 150;
/** Horizontal spacing inside a single same-level lane. */
const PEER_DX = 110;

interface RenderedPeer {
  key: string;
  peer: HierarchyPeer;
  layer: string;
  color: string;
  x: number;
  y: number;
  identity: ServiceIdentity;
}

/** Booster-ui's hierarchy renderer assigns Y by **sort-index in a
 *  level-DESC sorted list**, not by raw OAP level. We mirror that:
 *  every layer (peers + focus's home) is sorted level DESC (tie-
 *  break alphabetical), and each layer gets a lane Y = its sort
 *  index minus the focus's sort index, times LANE_DY. So the top of
 *  the stack always shows the highest-level layer first, with GENERAL
 *  ahead of MESH at the same level because of the alphabetical
 *  tiebreaker. */
const sortedLayers = computed<string[]>(() => {
  const d = data.value;
  const fl = fLayer.value;
  if (!d || !fl) return [];
  const levelOf = new Map<string, number>(d.levels.map((L: LayerLevel) => [L.layer, L.level]));
  const all = new Set<string>([fl]);
  for (const g of d.peers) {
    if (g.services.some((s) => s.role !== 'self') || g.layer === fl) {
      all.add(g.layer);
    }
  }
  return Array.from(all).sort((a, b) => {
    const la = levelOf.get(a);
    const lb = levelOf.get(b);
    if (la !== undefined && lb !== undefined && la !== lb) return lb - la; // DESC
    if (la !== undefined && lb === undefined) return -1;
    if (lb !== undefined && la === undefined) return 1;
    return a.localeCompare(b);
  });
});

const focusLayerIdx = computed<number>(() =>
  sortedLayers.value.indexOf(fLayer.value ?? ''),
);

const renderedPeers = computed<RenderedPeer[]>(() => {
  const fp = focusPos.value;
  const d = data.value;
  if (!fp || !d) return [];
  const order = sortedLayers.value;
  const fIdx = focusLayerIdx.value;
  if (fIdx < 0) return [];

  const out: RenderedPeer[] = [];
  for (let idx = 0; idx < order.length; idx++) {
    if (idx === fIdx) continue;            // focus layer renders the focus hex
    const layer = order[idx];
    const group = d.peers.find((g) => g.layer === layer);
    if (!group) continue;
    const peers = group.services.filter((s) => s.role !== 'self');
    if (peers.length === 0) continue;
    // Sort-index based lane: above focus when peer sort-index < focus
    // (higher OAP level, request-near), below when peer sort-index >
    // focus (lower OAP level, infra-near).
    const laneDy = (idx - fIdx) * LANE_DY;
    const color = colorForLayer(layer);
    peers.forEach((peer, i) => {
      const offset = (i - (peers.length - 1) / 2) * PEER_DX;
      out.push({
        key: `${layer}::${peer.id}`,
        peer,
        layer,
        color,
        x: fp.cx + offset,
        y: fp.cy + laneDy,
        identity: identityFor(peer.name, layer),
      });
    });
  }
  return out;
});

/** Lane labels — one per distinct peer layer at the lane's Y, so the
 *  operator can read which layer each peer cluster belongs to without
 *  hovering. Drawn inside the zoomed content so they track pan/zoom
 *  with the peers. */
interface LaneLabel {
  layer: string;
  name: string;
  color: string;
  x: number;
  y: number;
}
const laneLabels = computed<LaneLabel[]>(() => {
  const fp = focusPos.value;
  if (!fp) return [];
  // One label per distinct peer layer at the lane's Y. Peer hexes in
  // the lane carry the count visually; no need for a "· N" badge.
  const seen = new Map<string, LaneLabel>();
  for (const p of renderedPeers.value) {
    if (seen.has(p.layer)) continue;
    seen.set(p.layer, {
      layer: p.layer,
      name: labelForLayer(p.layer),
      color: p.color,
      // Label sits to the left of the focus column at a comfortable
      // gap; same Y as the peers in that lane.
      x: fp.cx - 220,
      y: p.y,
    });
  }
  return Array.from(seen.values());
});

/** Focus identity — same resolver the topology uses, so the
 *  `<group>::` / cluster chips on the focus card match what the right
 *  detail panel of the topology displays for this service. */
const focusIdentity = computed<ServiceIdentity | null>(() => {
  const fl = fLayer.value;
  const fn = fServiceName.value;
  if (!fl || !fn) return null;
  return identityFor(fn, fl);
});

/** Bounding box for the standalone fan → the SVG viewBox, so the whole
 *  Smartscape scales to fit the chat block regardless of how many lanes/peers
 *  it has (focus is centred on the origin; peers + lane labels fan around it). */
const standaloneViewBox = computed<string>(() => {
  const xs: number[] = [0];
  const ys: number[] = [0];
  for (const p of renderedPeers.value) {
    xs.push(p.x);
    ys.push(p.y);
  }
  for (const l of laneLabels.value) {
    xs.push(l.x);
    ys.push(l.y);
  }
  const minX = Math.min(...xs) - 150; // room for the lane-label chip on the left
  const maxX = Math.max(...xs) + 140; // room for the name / action chip on the right
  const minY = Math.min(...ys) - 80;
  const maxY = Math.max(...ys) + 90; // name sits below the hex
  return `${minX} ${minY} ${maxX - minX} ${maxY - minY}`;
});

/** Six-vertex flat-top hex outline — matches LayerServiceMapView's
 *  `hexPoints` exactly so the silhouette reads identically through
 *  the overlay and the topology underneath. */
function hexPoints(r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = ((i * 60) - 90) * Math.PI / 180;
    pts.push(`${(Math.cos(a) * r).toFixed(2)},${(Math.sin(a) * r).toFixed(2)}`);
  }
  return pts.join(' ');
}

function onDimClick(): void {
  store.close();
}

/** Currently armed peer — first click on a peer hex selects it (shows
 *  an "Open in <layer>" action chip next to the hex); the second
 *  click on that chip is what actually opens the new tab. Prevents
 *  accidental navigation when the operator is just scanning peers. */
const armedPeerKey = ref<string | null>(null);

// Disarm whenever the overlay closes or focus changes, so a stale
// arming from a previous focus doesn't carry into a new exploration.
watch(
  [() => store.isOpen, () => store.focusServiceId],
  () => {
    armedPeerKey.value = null;
  },
);

/** True when the peer's layer has an active template the UI can route
 *  to. OAP can report cross-layer relations into layers the operator
 *  hasn't configured a Horizon template for (e.g. an obscure
 *  observability layer); we surface the peer hex but disable the
 *  action chip so a misleading "page not found" never happens. */
function hasTemplate(layer: string): boolean {
  const def = findLayer(layer.toLowerCase());
  return Boolean(def && def.active);
}

/** First click: arm the peer (show the side action chip). Second
 *  click on the same hex toggles it off. Clicking a different peer
 *  re-arms onto that one. Disabled peers (no layer template) skip
 *  arming and surface a notice instead — there's no useful chip to
 *  show. */
function onPeerClick(peerKey: string, layer: string): void {
  if (!hasTemplate(layer)) {
    pushEvent(
      'hierarchy',
      'err',
      `No layer template configured for ${labelForLayer(layer)} (${layer}). The peer service exists on OAP but Horizon has no menu / page set up for this layer.`,
    );
    return;
  }
  armedPeerKey.value = armedPeerKey.value === peerKey ? null : peerKey;
}

/** Confirm the open — fired by the side action chip click. Opens the
 *  destination layer's first menu tab (per `firstLayerTab`) in a NEW
 *  BROWSER TAB with the peer service pre-selected via `?service=<id>`.
 *  The destination view itself owns the cascade-strict auto-pick of
 *  the first instance / endpoint (see `LayerDashboardsView.vue`), so
 *  no extra URL flag is required — landing → serviceName → list →
 *  pick happens naturally there. */
function confirmOpen(p: HierarchyPeer, layer: string): void {
  const def = findLayer(layer.toLowerCase());
  if (!def || !def.active) return;
  const tab = firstLayerTab(def);
  const url = `/layer/${def.key.toLowerCase()}/${tab}?service=${encodeURIComponent(p.id)}`;
  // `noopener` so the new tab can't reach back into window.opener.
  window.open(url, '_blank', 'noopener');
  armedPeerKey.value = null;
}

/** Human label for the action chip — e.g. "Open in MESH_DP". The
 *  destination tab is implied (first menu of the layer). */
function openLabelFor(layer: string): string {
  const def = findLayer(layer.toLowerCase());
  if (!def) return `Open in ${layer}`;
  return `Open in ${def.name}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

// ESC closes the overlay — the dim click is the primary affordance,
// but operators reach for ESC reflexively on modal-style overlays.
function onKeydown(ev: KeyboardEvent): void {
  if (props.standalone) return; // no modal to close in the inline chat block
  if (ev.key === 'Escape' && store.isOpen) {
    store.close();
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div v-if="isOpen" class="sm-hierarchy-overlay" :class="{ 'is-standalone': standalone }">
    <!-- Dim background — click-to-close. The topology stays visible
         underneath so the operator keeps spatial context. Standalone
         (inline chat) has nothing underneath, so no dim / no close. -->
    <div v-if="!standalone" class="sm-hierarchy-dim" @click="onDimClick" />

    <!-- Overlay mode: NO viewBox — the topology SVG has none either, so the
         focus hex overlaps the underlying topology hex pixel-for-pixel and d3
         does the zoom. Standalone mode: a viewBox bounding the fan, so the
         whole Smartscape scales to fit the inline block. -->
    <svg
      class="sm-hierarchy-svg"
      width="100%"
      height="100%"
      :viewBox="standalone ? standaloneViewBox : undefined"
    >
      <!-- Zoom-mirrored content: focus + peers + labels all sit
           inside this transform so they visually overlap the
           topology hex pixel-for-pixel at every zoom level. -->
      <g :transform="zoomTransform">
        <!-- Spotlight halo around the focus so the eye anchors there
             even with peers fanned in both directions. -->
        <circle
          v-if="focusPos"
          :cx="focusPos.cx"
          :cy="focusPos.cy"
          r="220"
          fill="url(#sm-h-spot)"
        />

        <!-- Connectors: dashed accent lines from focus → each peer,
             coloured by peer layer so a quick glance separates lanes
             without reading the labels. -->
        <g v-if="focusPos">
          <line
            v-for="p in renderedPeers"
            :key="`l-${p.key}`"
            :x1="focusPos.cx"
            :y1="focusPos.cy"
            :x2="p.x"
            :y2="p.y"
            :stroke="p.color"
            stroke-opacity="0.7"
            stroke-width="1.8"
            stroke-dasharray="5 6"
          />
        </g>

        <!-- Lane labels: one chip per peer layer, anchored to the
             left of the focus column at the lane's Y. Just the layer
             dot + name — the peer hexes themselves carry the count
             visually, so a "· N" badge would be redundant. -->
        <g v-for="L in laneLabels" :key="`ll-${L.layer}`" :transform="`translate(${L.x}, ${L.y})`">
          <rect
            x="0"
            y="-16"
            :width="labelForLayer(L.layer).length * 9 + 36"
            height="32"
            rx="6"
            :fill="L.color"
            fill-opacity="0.12"
            :stroke="L.color"
            stroke-opacity="0.6"
            stroke-width="1.2"
          />
          <circle cx="14" cy="0" r="4" :fill="L.color" />
          <text
            x="26"
            y="5"
            :fill="L.color"
            font-size="13"
            font-family="var(--sw-mono)"
            font-weight="700"
          >
            {{ L.name }}
          </text>
        </g>

        <!-- Focus hex — re-drawn at the underlying topology position.
             Matches the topology's selected-hex silhouette so the
             overlay reads as "the same hex you clicked, just lit up." -->
        <g
          v-if="focusPos"
          :transform="`translate(${focusPos.cx}, ${focusPos.cy})`"
        >
          <polygon
            :points="hexPoints(56)"
            fill="var(--sw-accent)"
            opacity="0.18"
          />
          <polygon
            :points="hexPoints(50)"
            fill="none"
            stroke="var(--sw-accent)"
            stroke-width="1.4"
            stroke-dasharray="3 4"
            opacity="0.85"
          />
          <polygon
            :points="hexPoints(42)"
            fill="var(--sw-bg-1)"
            stroke="var(--sw-accent)"
            stroke-width="2.5"
            style="filter: drop-shadow(0 0 14px var(--sw-accent))"
          />
          <polygon
            :points="hexPoints(32)"
            fill="var(--sw-bg-2)"
            stroke="var(--sw-line-2)"
            stroke-width="1"
          />
          <g transform="translate(-14, -14)">
            <polygon points="14,0 28,7 14,14 0,7" fill="#94a3b8" />
            <polygon points="0,7 14,14 14,28 0,21" fill="#5b6373" />
            <polygon points="28,7 14,14 14,28 28,21" fill="#3a4456" />
          </g>
          <!-- Base name below the hex — same position and treatment
               the topology uses. `identity().display` strips the
               `<group>::` prefix and any cluster suffix, mirroring
               the topology's label rule. -->
          <text
            text-anchor="middle"
            y="58"
            fill="var(--sw-fg-0)"
            font-size="16"
            font-family="var(--sw-mono)"
            font-weight="700"
          >
            {{ truncate(focusIdentity?.display ?? fServiceName ?? '', 22) }}
          </text>
          <!-- Cluster + legacy-group chips beneath the name (only
               when the layer's naming rule surfaces them, and only
               when `showLegacyGroup` is on). Mirrors the chips the
               right detail panel of the topology shows. -->
          <g v-if="focusIdentity?.cluster" transform="translate(0, 78)">
            <rect
              :x="-(focusIdentity.cluster.length + (focusIdentity.clusterAlias?.length ?? 0) + 4) * 4"
              y="-9"
              :width="(focusIdentity.cluster.length + (focusIdentity.clusterAlias?.length ?? 0) + 4) * 8"
              height="18"
              rx="9"
              fill="var(--sw-bg-1)"
              stroke="var(--sw-accent)"
              stroke-opacity="0.7"
            />
            <text
              text-anchor="middle"
              y="4"
              fill="var(--sw-accent-2)"
              font-size="10.5"
              font-family="var(--sw-mono)"
              font-weight="700"
            >
              <tspan fill="var(--sw-fg-3)">{{ focusIdentity.clusterAlias ?? 'cluster' }}·</tspan>{{ focusIdentity.cluster }}
            </text>
          </g>
          <g v-if="showLegacyGroup && focusIdentity?.legacyGroup" :transform="`translate(0, ${focusIdentity?.cluster ? 100 : 78})`">
            <text
              text-anchor="middle"
              y="0"
              fill="var(--sw-fg-3)"
              font-size="10"
              font-family="var(--sw-mono)"
            >
              {{ focusIdentity.legacyGroup }}::
            </text>
          </g>
          <!-- FOCUS tag pill — small, off to the upper-right. -->
          <g transform="translate(48, -38)">
            <rect
              x="0"
              y="0"
              width="56"
              height="20"
              rx="4"
              fill="var(--sw-bg-1)"
              stroke="var(--sw-accent)"
            />
            <text
              x="28"
              y="14"
              text-anchor="middle"
              font-size="10.5"
              font-weight="700"
              fill="var(--sw-accent-2)"
              font-family="var(--sw-mono)"
            >
              FOCUS
            </text>
          </g>
        </g>

        <!-- Peer hexes — smaller than focus, layer-colored stroke,
             clickable. Names use the peer's OWN layer naming rule via
             `identityFor`, so e.g. a MESH peer named
             `mesh-svr::reviews.default` displays as `reviews` (with
             cluster `default` available beneath). -->
        <g
          v-for="r in renderedPeers"
          :key="`p-${r.key}`"
          :transform="`translate(${r.x}, ${r.y})`"
          class="sm-h-peer"
          :class="{
            'is-disabled': !hasTemplate(r.layer),
            'is-armed': armedPeerKey === r.key,
          }"
          @click.stop="onPeerClick(r.key, r.layer)"
        >
          <title>
            {{ hasTemplate(r.layer)
              ? `Click to select ${r.identity.display}; the action chip opens it in ${openLabelFor(r.layer).replace('Open in ', '')} (new tab)`
              : `No Horizon layer template configured for ${labelForLayer(r.layer)}` }}
          </title>
          <!-- Selection ring when armed — same vocabulary as the
               topology's selected-hex halo, scaled for the peer's
               smaller silhouette. -->
          <polygon
            v-if="armedPeerKey === r.key"
            :points="hexPoints(46)"
            :fill="r.color"
            opacity="0.14"
          />
          <polygon
            v-if="armedPeerKey === r.key"
            :points="hexPoints(40)"
            fill="none"
            :stroke="r.color"
            stroke-width="1.2"
            stroke-dasharray="3 4"
            opacity="0.85"
          />
          <polygon
            :points="hexPoints(34)"
            fill="var(--sw-bg-1)"
            :stroke="r.color"
            stroke-width="2.4"
          />
          <polygon
            :points="hexPoints(24)"
            :fill="r.color"
            fill-opacity="0.22"
          />
          <g transform="translate(-11, -11)">
            <polygon points="11,0 22,5 11,10 0,5" :fill="r.color" opacity="0.95" />
            <polygon points="0,5 11,10 11,22 0,17" :fill="r.color" opacity="0.6" />
            <polygon points="22,5 11,10 11,22 22,17" :fill="r.color" opacity="0.35" />
          </g>
          <text
            text-anchor="middle"
            y="52"
            fill="var(--sw-fg-0)"
            font-size="13"
            font-family="var(--sw-mono)"
            font-weight="600"
          >
            {{ truncate(r.identity.display, 22) }}
          </text>
          <text
            v-if="r.identity.cluster"
            text-anchor="middle"
            y="66"
            fill="var(--sw-accent-2)"
            font-size="10"
            font-family="var(--sw-mono)"
            font-weight="600"
          >
            {{ r.identity.clusterAlias ?? 'cluster' }}·{{ r.identity.cluster }}
          </text>
          <text
            v-else-if="showLegacyGroup && r.identity.legacyGroup"
            text-anchor="middle"
            y="66"
            fill="var(--sw-fg-3)"
            font-size="10"
            font-family="var(--sw-mono)"
          >
            {{ r.identity.legacyGroup }}::
          </text>
          <text
            v-if="!r.peer.normal"
            text-anchor="middle"
            :y="(r.identity.cluster || (showLegacyGroup && r.identity.legacyGroup)) ? 78 : 66"
            fill="var(--sw-fg-3)"
            font-size="9.5"
            font-family="var(--sw-mono)"
          >
            virtual
          </text>
        </g>

        <!-- Action chip for the armed peer: "Open in <Layer>" with an
             external-link glyph. Click → opens a new browser tab to
             the destination layer's first menu tab with the peer
             pre-selected. Renders LAST so it draws above adjacent
             peer hexes. -->
        <g
          v-for="r in renderedPeers"
          :key="`a-${r.key}`"
          v-show="armedPeerKey === r.key"
          :transform="`translate(${r.x + 44}, ${r.y})`"
          class="sm-h-action"
          @click.stop="confirmOpen(r.peer, r.layer)"
        >
          <title>Open {{ r.identity.display }} in {{ labelForLayer(r.layer) }} (new tab)</title>
          <rect
            x="0"
            y="-14"
            :width="openLabelFor(r.layer).length * 7.6 + 36"
            height="28"
            rx="6"
            :fill="r.color"
            fill-opacity="0.18"
            :stroke="r.color"
            stroke-width="1.6"
          />
          <text
            x="12"
            y="5"
            font-size="12"
            font-weight="700"
            :fill="r.color"
            font-family="var(--sw-mono)"
          >
            {{ openLabelFor(r.layer) }}
          </text>
          <!-- External-link glyph: square with arrow out the top-right -->
          <g
            :transform="`translate(${openLabelFor(r.layer).length * 7.6 + 18}, 0)`"
            :stroke="r.color"
            stroke-width="1.6"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M-6 -3 L-6 5 L4 5 L4 -1" />
            <path d="M0 -5 L6 -5 L6 1" />
            <path d="M6 -5 L0 1" />
          </g>
        </g>

        <!-- Empty-state guard — shouldn't fire (chip is gated on
             `relations > 0`) but covers the rare swap-race. -->
        <g
          v-if="focusPos && !isLoading && renderedPeers.length === 0 && data?.reachable"
          :transform="`translate(${focusPos.cx}, ${focusPos.cy + 130})`"
        >
          <rect x="-110" y="-14" width="220" height="28" rx="14"
                fill="var(--sw-bg-1)" stroke="var(--sw-line)" />
          <text text-anchor="middle" y="4" font-size="11.5"
                font-family="var(--sw-mono)" fill="var(--sw-fg-2)">
            No cross-layer projections
          </text>
        </g>
      </g>

      <defs>
        <radialGradient id="sm-h-spot" cx="50%" cy="50%" r="55%">
          <stop offset="0%" stop-color="rgba(15,19,26,0)" />
          <stop offset="100%" stop-color="rgba(15,19,26,0.45)" />
        </radialGradient>
      </defs>
    </svg>

    <!-- Floating close button (top-right) — dim-click and ESC both
         close too, but a visible × is the conventional discoverable
         affordance for a modal-style overlay. -->
    <button
      v-if="!standalone"
      class="sm-hierarchy-close"
      type="button"
      aria-label="Close hierarchy"
      @click="store.close()"
    >×</button>
  </div>
</template>

<style scoped>
.sm-hierarchy-overlay {
  position: absolute;
  inset: 0;
  z-index: 20;
  pointer-events: none;
}
.sm-hierarchy-dim {
  position: absolute;
  inset: 0;
  background: rgba(15, 19, 26, 0.72);
  backdrop-filter: blur(2px);
  pointer-events: auto;
  cursor: zoom-out;
}
.sm-hierarchy-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.sm-h-peer {
  cursor: pointer;
  pointer-events: auto;
  transition: opacity 0.12s ease;
}
.sm-h-peer:hover polygon[fill-opacity="0.22"] {
  fill-opacity: 0.36;
}
.sm-h-peer:hover polygon[stroke-width="2.4"] {
  filter: drop-shadow(0 0 8px currentColor);
}
/* Peer whose layer has no Horizon template configured — clicking
 * surfaces a notice in the event log instead of navigating. The
 * dimmed look is a discoverable affordance for "nothing to open
 * here". */
.sm-h-peer.is-disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.sm-h-peer.is-disabled:hover polygon[fill-opacity="0.22"] {
  fill-opacity: 0.22;
}
.sm-h-peer.is-disabled:hover polygon[stroke-width="2.4"] {
  filter: none;
}
/* Armed peer: the action chip beside it confirms navigation. The
 * peer itself reads "selected" via the dashed halo polygons added
 * in the template. */
.sm-h-peer.is-armed {
  cursor: default;
}

.sm-h-action {
  cursor: pointer;
  pointer-events: auto;
}
.sm-h-action:hover rect {
  fill-opacity: 0.32;
}
.sm-h-action rect {
  filter: drop-shadow(0 4px 14px rgba(0, 0, 0, 0.55));
}

.sm-hierarchy-close {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 1px solid var(--sw-line);
  background: rgba(15, 19, 26, 0.92);
  color: var(--sw-fg-2);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  pointer-events: auto;
  display: grid;
  place-items: center;
  backdrop-filter: blur(4px);
}
.sm-hierarchy-close:hover {
  color: var(--sw-fg-0);
  border-color: var(--sw-accent-line);
}
</style>
