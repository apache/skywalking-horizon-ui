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
  Infra3DScene — the TresJS WebGL surface for the 3D infra map.

  Three tier-planes stack vertically (apps · service mesh · infra). On
  each plane, topology-bearing layer zones (general / mesh / k8s_service
  in the demo) sit in the center; non-topology layers tile on the
  sides. Inside topology zones, nodes use a rank-based grid that mirrors
  the booster-ui service-map layout. See CLAUDE.md for the rules.

  Cross-plane hierarchy edges are deliberately NOT rendered yet — the
  data is still computed for future interactions (hover a service to
  reveal its peers across tiers), but the static view focuses on
  per-plane layer geometry and intra-zone call edges only.
-->
<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, watch } from 'vue';
import { TresCanvas } from '@tresjs/core';
import { OrbitControls, Html } from '@tresjs/cientos';
import {
  BoxGeometry,
  CatmullRomCurve3,
  Color,
  ConeGeometry,
  DoubleSide,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PerspectiveCamera,
  Quaternion,
  SphereGeometry,
  type Texture,
  TubeGeometry,
  Vector3,
} from 'three';
import {
  buildSceneGraph,
  loadDemoTopology,
  type SceneCallEdge,
  type SceneCrossLayerEdge,
  type SceneHierarchyEdge,
  type SceneServiceNode,
} from './composables/useDemoTopology';
import {
  computePlacement,
  readTintColor,
  type NodePlacement,
  type PlaneSpec,
  type PlanePlacement,
  type ZonePlacement,
  type ZoneTint,
} from './composables/useScenePlacement';
import { colorForLayer, levelForLayer } from './composables/useInfra3dConfig';
import { layerIcon as layerIconByKey } from '@/shell/icons';
import {
  disposeLayerIconTextures,
  getLayerIconTexture,
  type LayerIconName,
} from './composables/useLayerIconTexture';
import { useInfra3dAlarms } from './composables/useInfra3dAlarms';
import { useInfra3dMetrics, formatMetricValue } from './composables/useInfra3dMetrics';

interface Props {
  /** Ordered (top-down) list of planes from the admin config. Drives
   *  vertical stacking; passed as a prop so the Scene stays a pure
   *  render of whatever the parent resolved. */
  planeOrder: PlaneSpec[];
  visibleLayers: Set<string>;
  hoveredNodeId: string | null;
  selectedNodeId: string | null;
  /** External camera-focus target. Updated by the parent when the user
   *  clicks a service (re-centers on the node) or a zone label
   *  (re-centers on the zone). The scene lerps the orbit target
   *  toward this each frame for a smooth move. */
  focusTarget: { x: number; y: number; z: number } | null;
}
const props = defineProps<Props>();
const emit = defineEmits<{
  (e: 'hover', node: SceneServiceNode | null): void;
  (e: 'select', node: SceneServiceNode | null): void;
  (e: 'zones', zones: ZonePlacement[]): void;
  (e: 'planes', planes: PlanePlacement[]): void;
  (e: 'nodes-by-layer', byLayer: Record<string, SceneServiceNode[]>): void;
}>();

// ── Graph + placement ────────────────────────────────────────────────
// Build with the config-aware level resolver so each layer lands on
// its admin-configured plane. The parent guarantees the config is
// loaded before mounting this component (see Infra3DView.vue), so
// `levelForLayer` returns deterministic values here, not the synchronous
// fallback. `planeOrder` is the source of truth for vertical stacking.
const topo = loadDemoTopology();
const graph = buildSceneGraph(topo, levelForLayer);
const placement = computePlacement(graph, props.planeOrder);

/** Resolve the per-layer icon glyph. Routed through the same helper
 *  the sidebar uses (`shell/icons.layerIcon`) so the two surfaces
 *  always agree — change the mapping in one place and both update.
 *  Narrowed to the subset the texture baker knows; unknown glyphs
 *  fall back to the generic service mark. */
const KNOWN_ICONS: ReadonlySet<LayerIconName> = new Set([
  'mesh', 'cluster', 'sky', 'web', 'fn', 'db', 'cache', 'topic', 'flame', 'svc',
]);
function iconForLayer(layerKey: string): LayerIconName {
  const n = layerIconByKey(layerKey);
  return KNOWN_ICONS.has(n as LayerIconName) ? (n as LayerIconName) : 'svc';
}
/** Material for a layer's front-left stamp. The icon is BAKED into a
 *  texture (an SVG of the layer's project mark stroked in the layer
 *  colour) and pasted onto a small PlaneGeometry rotated flat to the
 *  zone surface — so it tilts and rotates with the camera like a
 *  real stamp on the colour swatch.
 *
 *  Materials are cached by `(icon-name, hex)` so two zones with the
 *  same brand mark share one GL material. */
const iconStampMaterials = new Map<string, MeshBasicMaterial>();
function iconStampMaterial(layerKey: string, tint: ZoneTint): MeshBasicMaterial {
  const hex = resolveLayerColor(layerKey, tint);
  const name = iconForLayer(layerKey);
  const key = `${name}|${hex}`;
  let m = iconStampMaterials.get(key);
  if (!m) {
    const tex: Texture = getLayerIconTexture(name, hex);
    m = new MeshBasicMaterial({
      map: tex,
      transparent: true,
      // Disable depth write so the stamp doesn't fight with the
      // colored zone plate below it for z-buffer pixels.
      depthWrite: false,
      // Slight transparency keeps the stamp from over-asserting on
      // the operator — it's a brand cue, not the main signal.
      opacity: 0.85,
    });
    iconStampMaterials.set(key, m);
  }
  return m;
}

// Past-20m alarm overlay — affected service names get the red alarm
// material in place of the layer tint. Polled at 30s on a shared
// timer (refcount inside the composable).
const { alarmedServiceNames } = useInfra3dAlarms();
// Convenience name kept short for the template's per-cube material
// expression; the actual set value reactively drives Vue re-render.
const alarmedServiceIds = alarmedServiceNames;

// Visible cubes that currently carry an active 20m alarm. The cube's
// own material stays the layer color; the beacon below picks these up
// to render a small red sphere on the top corner. We compute the
// subset once per render so the template can iterate ONLY the
// alarmed cubes (no v-if per cube).
const alarmedNodes = computed(() => visibleNodes.value.filter((n) => alarmedServiceIds.value.has(n.node.name)));

// Live traffic-MQE values produced by stage 5 of the pipeline. Each
// node optionally gets a small numeric chip below its cube; the chip
// is hidden when the value is null (no MQE configured or OAP returned
// no data) — operators read "no chip" as "no data", not "0 traffic".
const { values: metricValues, units: metricUnits } = useInfra3dMetrics();
// Nodes close enough to the camera that their cubes read as more than
// a speck — used to gate the traffic chip render. The chip is verbose
// chrome when the cube is small; we only paint it on cubes the
// operator can see clearly OR on the currently-selected cube (which
// must always show its number).
const closeNodes = ref<Set<string>>(new Set());
function chipVisible(node: SceneServiceNode): boolean {
  if (trafficText(node) === null) return false;
  if (props.selectedNodeId === node.nodeId) return true;
  return closeNodes.value.has(node.nodeId);
}

function trafficText(node: SceneServiceNode): string | null {
  const key = `${node.layerKey.toUpperCase()}::${node.name}`;
  const v = metricValues.value.get(key);
  return formatMetricValue(v);
}
function trafficUnit(node: SceneServiceNode): string {
  return metricUnits.value.get(node.layerKey.toUpperCase()) ?? '';
}

emit('zones', placement.zones);
emit('planes', placement.planes);
{
  const byLayer: Record<string, SceneServiceNode[]> = {};
  for (const L of graph.layers) {
    if (L.nodes.length > 0) byLayer[L.key] = L.nodes;
  }
  emit('nodes-by-layer', byLayer);
}

function isVisible(layerKey: string): boolean {
  return props.visibleLayers.has(layerKey);
}

const visibleZones = computed(() => placement.zones.filter((z) => isVisible(z.layerKey)));

interface VisibleNode {
  node: SceneServiceNode;
  pos: NodePlacement;
  /** Tint kept for the zone-label data-tint CSS hook; cube color
   *  resolution happens via `colorHex` (config-aware) instead. */
  tint: ZoneTint;
  /** Resolved hex color used to look up cube materials. The legacy
   *  per-tint color reader is the fallback; the admin config takes
   *  precedence when it ships a `layers[KEY].color`. */
  colorHex: string;
}
const visibleNodes = computed<VisibleNode[]>(() => {
  const zoneByLayer = new Map(placement.zones.map((z) => [z.layerKey, z]));
  const out: VisibleNode[] = [];
  for (const L of graph.layers) {
    if (!isVisible(L.key)) continue;
    const z = zoneByLayer.get(L.key);
    if (!z) continue;
    const hex = resolveLayerColor(L.key, z.tint);
    for (const n of L.nodes) {
      const pos = placement.nodes.get(n.nodeId);
      if (!pos) continue;
      out.push({ node: n, pos, tint: z.tint, colorHex: hex });
    }
  }
  return out;
});

// Intra-layer call edges — same plane, both endpoints in the same layer.
// Rendered as gray translucent tubes; the existing animated traffic
// packets travel along these.
interface VisibleCallEdge extends SceneCallEdge {
  curve: CatmullRomCurve3;
}
const visibleCallEdges = computed<VisibleCallEdge[]>(() => {
  const out: VisibleCallEdge[] = [];
  for (const L of graph.layers) {
    if (!isVisible(L.key)) continue;
    for (const e of L.callEdges) {
      const a = placement.nodes.get(e.fromNodeId);
      const b = placement.nodes.get(e.toNodeId);
      if (!a || !b) continue;
      const mid = new Vector3((a.x + b.x) / 2, a.y + 0.9, (a.z + b.z) / 2);
      const curve = new CatmullRomCurve3([
        new Vector3(a.x, a.y + 0.45, a.z),
        mid,
        new Vector3(b.x, b.y + 0.45, b.z),
      ]);
      out.push({ ...e, curve });
    }
  }
  return out;
});

/** Cross-LAYER call edges, split by selection-gate. Two visibility
 *  rules so the default view stays focused on in-level topology and
 *  vertical traffic only appears when an operator asks for it:
 *
 *   - **always-on**: source AND target sit on the SAME plane (different
 *     layers within the same level — e.g. BROWSER → GENERAL `agent::ui
 *     → agent::frontend`, or GENERAL → VIRTUAL_MQ same-tier). These
 *     are the "browser calls frontend" edges the user reads as core
 *     in-level topology.
 *   - **selection-gated**: source and target sit on DIFFERENT planes
 *     (e.g. GENERAL → K8S_SERVICE). Only rendered when one of the two
 *     endpoints is the currently-selected cube; deselect hides them
 *     again. Keeps the default view from being a vertical pasta dish
 *     in dense deployments. */
interface VisibleCrossEdge extends SceneCrossLayerEdge {
  curve: CatmullRomCurve3;
  arrowPos: Vector3;
  arrowDir: Vector3;
  /** True when the endpoints sit on the same plane (no y delta). */
  intraLevel: boolean;
}
function buildCrossEdgeCurve(a: NodePlacement, b: NodePlacement): {
  curve: CatmullRomCurve3;
  arrowPos: Vector3;
  arrowDir: Vector3;
  intraLevel: boolean;
} {
  const dy = Math.abs(b.y - a.y);
  const intraLevel = dy < 0.1;
  // Same-plane → small bump (just above the cube tops, plus a touch
  // proportional to horizontal distance so long hops curve gently);
  // cross-plane → larger arch scaling with the y gap so two opposite-
  // direction vertical tubes don't visually collide.
  const horiz = Math.hypot(b.x - a.x, b.z - a.z);
  const arch = intraLevel
    ? 0.6 + Math.min(horiz * 0.05, 0.8)
    : 1.2 + dy * 0.25;
  const archY = Math.max(a.y, b.y) + arch;
  const mid = new Vector3((a.x + b.x) / 2, archY, (a.z + b.z) / 2);
  const tip = new Vector3(b.x, b.y + 0.55, b.z);
  const curve = new CatmullRomCurve3([
    new Vector3(a.x, a.y + 0.55, a.z),
    mid,
    tip,
  ]);
  // Sample just shy of the tip so the arrow points along the actual
  // curve tangent, not the straight chord.
  const near = curve.getPoint(0.94);
  const arrowDir = new Vector3().subVectors(tip, near).normalize();
  return { curve, arrowPos: tip, arrowDir, intraLevel };
}

/** Same-plane cross-layer edges — always visible. */
const visibleCrossEdges = computed<VisibleCrossEdge[]>(() => {
  const out: VisibleCrossEdge[] = [];
  for (const e of graph.crossLayerEdges) {
    if (!isVisible(e.fromLayer) || !isVisible(e.toLayer)) continue;
    const a = placement.nodes.get(e.fromNodeId);
    const b = placement.nodes.get(e.toNodeId);
    if (!a || !b) continue;
    const built = buildCrossEdgeCurve(a, b);
    if (!built.intraLevel) continue; // cross-plane → selection-gated list
    out.push({ ...e, ...built });
  }
  return out;
});

/** Cross-plane cross-layer edges — only shown when the selected cube
 *  is one of the endpoints. "Show this cube's relatives once." */
const visibleVerticalEdges = computed<VisibleCrossEdge[]>(() => {
  const sel = props.selectedNodeId;
  if (!sel) return [];
  const out: VisibleCrossEdge[] = [];
  for (const e of graph.crossLayerEdges) {
    if (e.fromNodeId !== sel && e.toNodeId !== sel) continue;
    if (!isVisible(e.fromLayer) || !isVisible(e.toLayer)) continue;
    const a = placement.nodes.get(e.fromNodeId);
    const b = placement.nodes.get(e.toNodeId);
    if (!a || !b) continue;
    const built = buildCrossEdgeCurve(a, b);
    if (built.intraLevel) continue; // intra-level → already in the always-on list
    out.push({ ...e, ...built });
  }
  return out;
});

/** Hierarchy edges — peers of the SELECTED cube only.
 *
 *  Hierarchy relationships (`getHierarchyRelatedServices`) connect the
 *  agent / mesh / k8s_service views of the SAME logical service.
 *  Rendering every hierarchy edge unconditionally clutters the scene
 *  in dense deployments (one frontend service can hierarchy-link to
 *  4+ peers across tiers). Instead, we only draw them when the
 *  operator selects a cube — they read as "what is THIS cube's
 *  cross-layer identity?" — and hide them on deselect. */
interface VisibleHierarchyEdge extends SceneHierarchyEdge {
  curve: CatmullRomCurve3;
}
const visibleHierarchyEdges = computed<VisibleHierarchyEdge[]>(() => {
  const sel = props.selectedNodeId;
  if (!sel) return [];
  const out: VisibleHierarchyEdge[] = [];
  for (const e of graph.hierarchyEdges) {
    if (e.fromNodeId !== sel && e.toNodeId !== sel) continue;
    const a = placement.nodes.get(e.fromNodeId);
    const b = placement.nodes.get(e.toNodeId);
    if (!a || !b) continue;
    const fromNode = graph.nodesByKey.get(e.fromNodeId);
    const toNode = graph.nodesByKey.get(e.toNodeId);
    if (!fromNode || !toNode) continue;
    if (!isVisible(fromNode.layerKey) || !isVisible(toNode.layerKey)) continue;
    const dy = Math.abs(b.y - a.y);
    const archY = (a.y + b.y) / 2 + 0.8 + dy * 0.2;
    const mid = new Vector3((a.x + b.x) / 2, archY, (a.z + b.z) / 2);
    const curve = new CatmullRomCurve3([
      new Vector3(a.x, a.y + 0.55, a.z),
      mid,
      new Vector3(b.x, b.y + 0.55, b.z),
    ]);
    out.push({ ...e, curve });
  }
  return out;
});

// ── Shared geometries ─────────────────────────────────────────────────
// ONE node geometry shared by every cube — hover / select only change
// the material, never the geometry. Swapping the THREE geometry on a
// mesh under the cursor caused the raycaster's bounding box to rebuild
// mid-event, which made pointerenter / pointerleave / click fire in
// unstable orders (the operator saw "I have to click twice" and a
// flash of the hover state where the click should have selected).
const nodeGeometry = new BoxGeometry(1.3, 1.0, 1.3);
const packetGeometry = new SphereGeometry(0.18, 12, 8);

// ── Opt decorative geometry out of pointer picking ───────────────────
// TresJS dispatches pointer events via THREE.Raycaster against every
// mesh in the scene — closest hit wins, regardless of whether the
// closest mesh carries a click handler. So a 0.18-radius traffic
// packet flying in front of a cube wins the raycast and absorbs the
// click; the cube never hears about it. The fix is to overwrite the
// mesh's `raycast` method with a no-op so the raycaster skips it.
//
// We do this via a TEMPLATE-REF CALLBACK rather than a `:raycast` prop:
// TresJS treats `:raycast` as a method invocation (it calls
// `mesh.raycast(value)` instead of assigning it), which crashes inside
// `Ray.copy()` the moment the canvas tries to mount. The function-ref
// pattern just hands us the underlying THREE.Mesh — assigning its
// `raycast` property is a straight property write.
const _noopRaycast = () => {};
function disableRaycast(el: unknown): void {
  // Vue passes the THREE object directly here (for `<TresMesh>` refs).
  // Defensive against the wrapped-instance shape some adapters use.
  if (!el) return;
  const obj = (el as { isObject3D?: boolean }).isObject3D
    ? (el as { raycast: typeof _noopRaycast })
    : (el as { value?: { isObject3D?: boolean; raycast: typeof _noopRaycast } }).value?.isObject3D
      ? (el as { value: { raycast: typeof _noopRaycast } }).value
      : null;
  if (obj) obj.raycast = _noopRaycast;
}

// ── Materials ─────────────────────────────────────────────────────────
// Materials are cached by the resolved hex color, NOT by tint, so an
// admin layer-color override (`config.layers[KEY].color`) gets its own
// material — two layers with identical colors share one. The legacy
// per-tint color reader is kept as the fallback for layers the admin
// config hasn't covered.
const colorCache = new Map<string, Color>();
function colorByHex(hex: string): Color {
  let c = colorCache.get(hex);
  if (!c) {
    c = new Color(hex);
    colorCache.set(hex, c);
  }
  return c;
}
/** Resolve a cube's color: config-supplied layer color first, tint
 *  fallback second. The hex string is the cache key for the material
 *  maps below — same color, same material. */
function resolveLayerColor(layerKey: string, tintFallback: ZoneTint): string {
  const cfgHex = colorForLayer(layerKey);
  // The composable's "unknown layer" sentinel; treat as no override so
  // the tint mapping wins for layers the admin hasn't classified.
  if (cfgHex && cfgHex !== '#8a8a8a') return cfgHex;
  return readTintColor(tintFallback);
}

const planeMaterial = new MeshBasicMaterial({
  color: new Color('#151a23'),
  transparent: true,
  opacity: 0.55,
  side: DoubleSide,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: 1,
  polygonOffsetUnits: 1,
});

const zoneMaterials = new Map<string, MeshBasicMaterial>();
function zoneMaterial(hex: string): MeshBasicMaterial {
  let m = zoneMaterials.get(hex);
  if (!m) {
    m = new MeshBasicMaterial({
      color: colorByHex(hex),
      transparent: true,
      opacity: 0.22,
      side: DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    zoneMaterials.set(hex, m);
  }
  return m;
}

// Cubes were reading too saturated against the dark scene (the cache
// red especially). Pull each resolved layer color toward a calmer tone
// — drop saturation, nudge lightness up a touch — so the cubes read
// softer while keeping the hue recognizable next to the side-panel
// swatches (which stay the full tint). Cloned before mutating; the
// shared cached Color from colorByHex must not be touched.
const _hsl = { h: 0, s: 0, l: 0 };
function mutedCubeColor(hex: string): Color {
  const c = colorByHex(hex).clone();
  c.getHSL(_hsl);
  c.setHSL(_hsl.h, _hsl.s * 0.6, Math.min(1, _hsl.l * 1.06 + 0.03));
  return c;
}

const nodeMaterials = new Map<string, MeshLambertMaterial>();
function nodeMaterial(hex: string): MeshLambertMaterial {
  let m = nodeMaterials.get(hex);
  if (!m) {
    const base = mutedCubeColor(hex);
    m = new MeshLambertMaterial({ color: base, emissive: base.clone().multiplyScalar(0.3) });
    nodeMaterials.set(hex, m);
  }
  return m;
}
// Hover is a brightened version of the layer color, NOT pure white —
// pure white loses the layer association and reads as "is something
// selected here?" which the operator then clicks again, only to find
// it was just hover. We lerp only 25% toward white so the cube keeps
// its layer tint and stays clearly distinguishable from the orange
// selected state.
const hoverMaterials = new Map<string, MeshLambertMaterial>();
function hoverMaterial(hex: string): MeshLambertMaterial {
  let m = hoverMaterials.get(hex);
  if (!m) {
    const base = mutedCubeColor(hex);
    m = new MeshLambertMaterial({
      color: base.clone().lerp(new Color(0xffffff), 0.25),
      emissive: base.clone(),
      emissiveIntensity: 0.45,
    });
    hoverMaterials.set(hex, m);
  }
  return m;
}
const selectedMat = new MeshLambertMaterial({ color: 0xf97316, emissive: 0xf97316, emissiveIntensity: 0.85 });

// Alarm marker — the top ~20% of an alarmed cube is capped in red.
// The cube is 1.0 tall, so a 0.22-high flat box at its crown reads as
// "the top fifth is red". Footprint is a hair larger than the cube
// (1.32 vs 1.3) so the cap's sides clear the cube faces without
// z-fighting, and it sits just above the cube's top face. Static red,
// no pulse — the alert is a state, not an animation; the cube keeps
// its layer color below the cap.
const alarmCapGeometry = new BoxGeometry(1.32, 0.22, 1.32);
const alarmCapMat = new MeshLambertMaterial({
  color: 0xef4444,
  emissive: 0xef4444,
  emissiveIntensity: 0.5,
});

/** Intra-layer call edge — calls between two services in the same
 *  layer. The previous dark gray (#5b6373, 0.5 opacity) read as
 *  "broken / barely there" on the dark scene background. Switched to
 *  a cool light-cyan at higher opacity so the layer's internal call
 *  graph is plainly visible without competing with the cross-layer
 *  amber arrows for the operator's eye. */
const callEdgeMat = new MeshBasicMaterial({
  color: new Color('#7dd3fc'),
  transparent: true,
  opacity: 0.75,
});
const callPacketMat = new MeshBasicMaterial({ color: new Color('#e0f2fe') });

/** Cross-layer call edge — lighter orange (was the louder amber
 *  #f0a04b). Lighter shade reads as warm-coloured-but-quiet so it
 *  doesn't dominate; still distinct from the intra-layer cyan and
 *  the hierarchy gray. Arrow head shares the colour. */
const crossEdgeMat = new MeshBasicMaterial({
  color: new Color('#ffb878'),
  transparent: true,
  opacity: 0.85,
});
const crossArrowMat = new MeshLambertMaterial({
  color: 0xffb878,
  emissive: 0xffb878,
  emissiveIntensity: 0.55,
});

/** Hierarchy edge — neutral mid-gray tube, slightly thicker than the
 *  other edge classes (radius bumped in `hierarchyTubes`). Hierarchy
 *  represents identity ("these cubes are the same logical service in
 *  different layers"), not traffic, so the gray keeps it visually
 *  quiet while the extra thickness keeps it readable when the
 *  operator selects a cube. */
const hierarchyMat = new MeshBasicMaterial({
  color: new Color('#8b95a3'),
  transparent: true,
  opacity: 0.7,
});

const callTubes = computed(() =>
  visibleCallEdges.value.map((e) => ({
    edge: e,
    geometry: new TubeGeometry(e.curve, 16, 0.04, 6, false),
  })),
);

function buildCrossTubes(edges: VisibleCrossEdge[]) {
  return edges.map((e) => ({
    edge: e,
    geometry: new TubeGeometry(e.curve, 32, 0.06, 8, false),
    // Quaternion that rotates the cone's default +Y axis onto the
    // edge direction. Composed lazily during render — kept here so
    // the template stays declarative.
    arrowQuat: new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), e.arrowDir),
  }));
}
const crossTubes = computed(() => buildCrossTubes(visibleCrossEdges.value));
const verticalTubes = computed(() => buildCrossTubes(visibleVerticalEdges.value));

const hierarchyTubes = computed(() =>
  visibleHierarchyEdges.value.map((e) => ({
    edge: e,
    // Radius bumped above the intra/cross tube widths so the gray
    // hierarchy tube reads as the "identity" link even when many
    // edges share the same screen region around a selected cube.
    geometry: new TubeGeometry(e.curve, 24, 0.07, 8, false),
  })),
);

// Each tube computed mints a fresh TubeGeometry per edge on every
// recompute (a layer visibility toggle or selection change re-runs the
// `visible*Edges` deps). The old GPU buffers are otherwise abandoned —
// only the *current* batch was freed, on unmount. Free the previous
// batch when the set changes; flush:'post' so the new geometries have
// already rendered and the old meshes are detached before we dispose.
function disposeTubeBatch(batch: ReadonlyArray<{ geometry: TubeGeometry }>): void {
  for (const t of batch) t.geometry.dispose();
}
watch(callTubes, (_now, prev) => disposeTubeBatch(prev), { flush: 'post' });
watch(crossTubes, (_now, prev) => disposeTubeBatch(prev), { flush: 'post' });
watch(verticalTubes, (_now, prev) => disposeTubeBatch(prev), { flush: 'post' });
watch(hierarchyTubes, (_now, prev) => disposeTubeBatch(prev), { flush: 'post' });

const crossArrowGeometry = new ConeGeometry(0.18, 0.5, 10);

// ── Animated traffic packets — call edges only. ────────────────────────
interface Packet {
  curve: CatmullRomCurve3;
  phase: number;
  pos: Vector3;
}
const packets = shallowRef<Packet[]>([]);
function rebuildPackets(): void {
  const out: Packet[] = [];
  visibleCallEdges.value.forEach((e) => {
    for (let k = 0; k < 2; k++) out.push({ curve: e.curve, phase: k / 2, pos: new Vector3() });
  });
  packets.value = out;
}
watch(visibleCallEdges, rebuildPackets, { immediate: true });

// ── Frame loop: animate packets + lerp the orbit controls' target
// toward the caller's focus target (when the operator clicks a node
// or a zone). Also recomputes which zone labels overflow their
// projected zone footprint. Both run against the live THREE objects
// so mouse-driven changes and programmatic changes stay in sync. ──
const period = 2.6;
const canvasHostEl = ref<HTMLElement | null>(null);
const cameraRef = shallowRef<PerspectiveCamera | null>(null);
let lastLabelTick = 0;
const _v1 = new Vector3();
const _v2 = new Vector3();

/** Threshold for "the cube is large enough on screen to deserve a
 *  traffic chip". Measured as the projected width of the cube's
 *  horizontal extent (1.3 world units → screen px). Tuned to hide
 *  the chip only when the operator has zoomed out far enough that
 *  cubes themselves are barely-readable specks — under that, the
 *  chip stays so per-cube traffic is always visible at working
 *  zoom levels. The currently-selected cube ignores the threshold
 *  (forced visible) so a click-to-inspect operator always sees the
 *  number. */
const CHIP_PIXEL_MIN = 18;
/** Returns true when a higher-tier plane sits between the camera and
 *  this cube — i.e. the cube is visually behind that plane. The chip
 *  must hide in that case (the previous render let lower-plane chips
 *  bleed through upper planes — "下层的rpm好像穿透过来了"). We check
 *  each placement plane whose Y is above the cube; if the ray from
 *  camera to cube centre crosses that plane WITHIN its footprint,
 *  the plane occludes. Tiny inset to cope with floating-point edge
 *  cases at the plane border. */
function isCubeOccludedByUpperPlane(n: VisibleNode, cam: PerspectiveCamera): boolean {
  const cp = cam.position;
  const cubeY = n.pos.y + 0.55;
  for (const P of placement.planes) {
    if (P.y <= cubeY) continue;        // plane is at or below cube → can't block
    if (cp.y <= P.y) continue;         // camera is below the plane → it's not in front
    const t = (P.y - cp.y) / (cubeY - cp.y);
    if (t <= 0 || t >= 1) continue;
    const xAt = cp.x + t * (n.pos.x - cp.x);
    const zAt = cp.z + t * (n.pos.z - cp.z);
    if (Math.abs(xAt) <= P.width / 2 + 0.2 && Math.abs(zAt) <= P.depth / 2 + 0.2) {
      return true;
    }
  }
  return false;
}

function updateCloseNodes(): void {
  const cam = getCamera();
  const host = canvasHostEl.value;
  if (!cam || !host) return;
  const w = host.clientWidth;
  if (w <= 0) return;
  const next = new Set<string>();
  for (const n of visibleNodes.value) {
    if (trafficText(n.node) === null) continue;
    // Project the cube's horizontal extent (≈ 1.3 wide in world units,
    // centred at pos.y + 0.55). NDC range [-1, 1] → pixels via host
    // width × 0.5.
    _v1.set(n.pos.x - 0.65, n.pos.y + 0.55, n.pos.z).project(cam);
    _v2.set(n.pos.x + 0.65, n.pos.y + 0.55, n.pos.z).project(cam);
    const projW = Math.abs(_v2.x - _v1.x) * 0.5 * w;
    if (projW < CHIP_PIXEL_MIN) continue;
    if (isCubeOccludedByUpperPlane(n, cam)) continue;
    next.add(n.node.nodeId);
  }
  if (next.size !== closeNodes.value.size || [...next].some((k) => !closeNodes.value.has(k))) {
    closeNodes.value = next;
  }
}
/** Tracks which focus target we last latched onto. Once the orbit
 *  target is within this snap radius of the requested focus, we stop
 *  lerping — saves work and prevents jitter at the destination. */
let lastFocusKey: string | null = null;
const FOCUS_SNAP_EPS = 0.04;
function onSceneLoop(ctx: { elapsed: number; delta: number }): void {
  for (const p of packets.value) {
    const t = ((ctx.elapsed / period) + p.phase) % 1;
    p.curve.getPoint(t, p.pos);
  }
  // Focus lerp — write straight into the live OrbitControls.target so
  // the move sticks even when the operator mouses on top of it. We
  // snap when close enough so the loop doesn't keep nudging the
  // sub-pixel residual forever.
  if (props.focusTarget) {
    const c = getControls();
    if (c) {
      const ft = props.focusTarget;
      const key = `${ft.x.toFixed(3)}_${ft.y.toFixed(3)}_${ft.z.toFixed(3)}`;
      if (key !== lastFocusKey) {
        const dx = ft.x - c.target.x;
        const dy = ft.y - c.target.y;
        const dz = ft.z - c.target.z;
        if (Math.hypot(dx, dy, dz) < FOCUS_SNAP_EPS) {
          c.target.set(ft.x, ft.y, ft.z);
          c.update();
          lastFocusKey = key;
        } else {
          const k = Math.min(1, ctx.delta * 6);
          c.target.x += dx * k;
          c.target.y += dy * k;
          c.target.z += dz * k;
          c.update();
        }
      }
    }
  } else {
    lastFocusKey = null;
  }
  if (ctx.elapsed - lastLabelTick > 0.15) {
    lastLabelTick = ctx.elapsed;
    updateSelectedSide();
    updateCloseNodes();
  }
}

// ── Pointer interactions ─────────────────────────────────────────────
//
// All diagnostic logging is gated on `window.__INFRA3D_DEBUG__`.
// Toggle on in DevTools (`window.__INFRA3D_DEBUG__ = true`) when
// click / hover flow misbehaves and you need to see which path a
// pointer event walked. The click/select flow here is fragile enough
// (see CLAUDE.md "click-thief" + "listener accumulation" sections)
// that keeping the diagnostics one console-line away is worth it.
function dbg(label: string, payload?: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  if (!(window as unknown as { __INFRA3D_DEBUG__?: boolean }).__INFRA3D_DEBUG__) return;
  console.log(`[infra3d] ${label}`, payload ?? '');
}
function dbgBadge(text: string, bg: string, suffix = ''): void {
  if (typeof window === 'undefined') return;
  if (!(window as unknown as { __INFRA3D_DEBUG__?: boolean }).__INFRA3D_DEBUG__) return;
  console.log(
    `%c[infra3d] ${text}%c  ${suffix}`,
    `background:${bg};color:white;padding:2px 7px;border-radius:3px;font-weight:700`,
    'color:#a3a3a3;font-weight:400',
  );
}

function onNodePointerOver(node: SceneServiceNode): void {
  dbg('node.pointerover', { id: node.shortName });
  emit('hover', node);
}
function onNodePointerOut(node: SceneServiceNode): void {
  dbg('node.pointerout', { id: node.shortName });
  if (props.hoveredNodeId === node.nodeId) emit('hover', null);
}

/**
 * Cube selection uses `@pointerdown` only. We tried `@click` and
 * `@pointerup`-with-slop-check in earlier rounds; both proved flaky
 * with the TresJS / @pmndrs/pointer-events / OrbitControls stack on
 * this scene. The pmndrs click logic requires `pointerup` to land on
 * the SAME object whose `objectButtonPressTime` matches the pointer's
 * internal press timestamp, and small interactions between the
 * camera controls and the pointer manager produce mismatches —
 * observable as: hover works, but click does nothing.
 *
 * Pointerdown is the most reliable signal a user is selecting THIS
 * cube — it fires the instant they press the button while their
 * cursor is over the cube, before any drag/release logic has run.
 * The tradeoff: pressing-and-dragging on a cube (to orbit-rotate)
 * will also fire select on it. Operators who want to orbit-rotate
 * without changing the selection start their drag from empty plane
 * space (or use the toolbar / WASD / Esc, all of which are deselect-
 * safe).
 */
function onNodeClick(node: SceneServiceNode): void {
  // Stamp so the canvas-host pointerup handler knows a cube absorbed
  // this gesture and must not treat the same release as an empty click.
  lastCubeClickAt = performance.now();
  dbgBadge(`CUBE CLICKED → ${node.shortName}`, '#f97316', `(${node.layerKey})`);
  dbg('node.pointerdown', {
    shortName: node.shortName,
    nodeId: node.nodeId,
    layer: node.layerKey,
    selected: props.selectedNodeId,
    hovered: props.hoveredNodeId,
  });
  emit('select', node);
}

// ── Stable per-node handler cache ────────────────────────────────────
// TresJS's `nodeOps.patchProp` calls `node.addEventListener(type, fn)`
// on every prop patch but never removes the previous handler. THREE's
// `addEventListener` dedupes by REFERENCE — so a fresh arrow function
// every render (the natural `@pointerdown="() => onNodeClick(n.node)"`
// pattern) is a NEW reference, gets added as ANOTHER listener while
// the old ones linger, and one pmndrs dispatch fires all N of them.
// Symptom: hover/click logs flood with N copies after a while, click
// emits N times → parent's onSelect toggles N times → parity gamble.
//
// Caching one stable handler tuple per node keeps the listener count
// at exactly one per event per mesh, no matter how often the parent
// re-renders. The cache is keyed by nodeId so a node that toggles
// visibility (hide / show via the side panel) re-uses the same
// handlers when it remounts.
interface NodeHandlers {
  pointerenter: () => void;
  pointerleave: () => void;
  pointerdown: () => void;
}
const nodeHandlerCache = new Map<string, NodeHandlers>();
function nodeHandlers(node: SceneServiceNode): NodeHandlers {
  let h = nodeHandlerCache.get(node.nodeId);
  if (!h) {
    h = {
      pointerenter: () => onNodePointerOver(node),
      pointerleave: () => onNodePointerOut(node),
      pointerdown: () => onNodeClick(node),
    };
    nodeHandlerCache.set(node.nodeId, h);
  }
  return h;
}

// Empty-space deselect. pmndrs `pointermissed` only fires on a true
// void hit (the ray hits nothing) — clicking a colored zone/tier plane
// hits the plane (raycast stays on so planes occlude cubes), so it
// never cleared the selection. We can't add a deselect handler to the
// planes either: operators orbit-drag FROM empty plane space to rotate
// WITHOUT changing selection (see CLAUDE.md). So detect an empty click
// at the DOM level on the canvas itself, with three guards:
//   - target is the <canvas> (not a portaled <Html> overlay like the
//     detail card — clicking the card must not deselect)
//   - the pointer barely moved (a click, not an orbit/pan drag)
//   - no cube absorbed this gesture (onNodeClick stamped recently)
let lastCubeClickAt = 0;
let pointerDownX = 0;
let pointerDownY = 0;
const CLICK_SLOP_PX = 5;
function onHostPointerDown(e: PointerEvent): void {
  pointerDownX = e.clientX;
  pointerDownY = e.clientY;
}
function onHostPointerUp(e: PointerEvent): void {
  if ((e.target as HTMLElement | null)?.tagName !== 'CANVAS') return;
  if (Math.hypot(e.clientX - pointerDownX, e.clientY - pointerDownY) > CLICK_SLOP_PX) return;
  if (performance.now() - lastCubeClickAt < 120) return;
  if (props.selectedNodeId !== null) emit('select', null);
}

// Diagnostic — fires whenever the parent updates `selectedNodeId`.
// Confirms that emit('select', node) reached the parent and round-
// tripped back as a prop. If you see `CUBE CLICKED` but NO subsequent
// `SELECTION` line under debug, the parent's onSelect handler is the
// broken link.
watch(
  () => props.selectedNodeId,
  (next, prev) => {
    if (next) {
      const n = graph.nodesByKey.get(next);
      dbgBadge(
        `SELECTION → ${n?.shortName ?? next}`,
        '#22c55e',
        `(${n?.layerKey ?? ''})`,
      );
    } else if (prev) {
      dbgBadge('SELECTION CLEARED', '#5b6373');
    }
    dbg('props.selectedNodeId', { prev, next });
  },
);
watch(
  () => props.hoveredNodeId,
  (next, prev) => dbg('props.hoveredNodeId', { prev, next }),
);

// Camera plumbing — we drive the THREE camera + OrbitControls DIRECTLY,
// not through reactive Vue props. The reason: mouse interaction
// (rotate, zoom, pan) mutates the underlying THREE objects in place,
// while a Vue prop bound to a static initial value would silently
// stomp those mutations back on every diff. By talking to the
// instances directly, both the mouse and the button affordances
// share one source of truth.
//
// The initial pose is applied via `:position` / `:target` on first
// mount; after that, all updates go through the refs.

function defaultCameraPos(): [number, number, number] {
  const b = placement.bounds;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const spanXZ = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
  const spanY = Math.max(8, b.maxY - b.minY);
  const radius = spanXZ * 1.0 + 6;
  return [cx + radius * 0.8, b.minY + spanY * 0.55 + radius * 0.55, cz + radius * 0.8];
}
function defaultTargetPos(): [number, number, number] {
  const b = placement.bounds;
  return [(b.minX + b.maxX) / 2, b.minY + (b.maxY - b.minY) * 0.4, (b.minZ + b.maxZ) / 2];
}
const initialCameraPos = defaultCameraPos();
const initialTarget = defaultTargetPos();

// cientos OrbitControls's setup does `__expose({ instance: controlsRef })`
// where controlsRef is a shallowRef<THREE.OrbitControls>. Vue's expose
// machinery wraps the exposed object in a proxy that AUTO-UNWRAPS
// refs — so from the parent's perspective `componentRef.value.instance`
// returns the THREE.OrbitControls directly, NOT a ref.
//
// TresJS template refs work the same way for `<Tres*>` elements: the
// ref is set to the underlying THREE object once the renderer mounts.
//
// Both refs may still be `null` between mount-tick and the THREE
// object actually attaching, so every accessor guards for that.
const controlsRef = shallowRef<any>(null);
function getControls(): any | null {
  const r = controlsRef.value;
  if (!r) return null;
  // Defensive: handle both auto-unwrapped expose AND the (older /
  // alternative) shape where `instance` would still be a ref.
  const inst = r.instance;
  if (!inst) return null;
  if (typeof inst.update === 'function' && inst.target) return inst;
  if (inst.value && typeof inst.value.update === 'function') return inst.value;
  return null;
}
function getCamera(): PerspectiveCamera | null {
  const r = cameraRef.value as any;
  if (!r) return null;
  if (r.isPerspectiveCamera) return r as PerspectiveCamera;
  if (r.value?.isPerspectiveCamera) return r.value as PerspectiveCamera;
  return null;
}

/** Zoom by a scalar around the orbit controls' current target. */
function zoom(factor: number): void {
  const cam = getCamera();
  const c = getControls();
  if (!cam || !c) return;
  const dx = cam.position.x - c.target.x;
  const dy = cam.position.y - c.target.y;
  const dz = cam.position.z - c.target.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-3) return;
  const newDist = Math.min(240, Math.max(8, dist * factor));
  const k = newDist / dist;
  cam.position.set(c.target.x + dx * k, c.target.y + dy * k, c.target.z + dz * k);
  c.update();
}

/** Rotate the camera around the orbit target's Y axis (azimuth). */
function rotateY(degrees: number): void {
  const cam = getCamera();
  const c = getControls();
  if (!cam || !c) return;
  const angle = (degrees * Math.PI) / 180;
  const dx = cam.position.x - c.target.x;
  const dz = cam.position.z - c.target.z;
  const cs = Math.cos(angle);
  const sn = Math.sin(angle);
  cam.position.x = c.target.x + dx * cs - dz * sn;
  cam.position.z = c.target.z + dx * sn + dz * cs;
  c.update();
}

/** Pan along the camera's right (X) and up (Y) screen axes. */
function pan(rightAmount: number, upAmount: number): void {
  const cam = getCamera();
  const c = getControls();
  if (!cam || !c) return;
  const view = new Vector3().subVectors(c.target, cam.position);
  const dist = view.length();
  if (dist < 1e-3) return;
  view.divideScalar(dist);
  const right = new Vector3().crossVectors(view, new Vector3(0, 1, 0)).normalize();
  const up = new Vector3().crossVectors(right, view).normalize();
  // Step is a fraction of the current view distance so the per-click
  // pan feels consistent across zoom levels.
  const step = dist * 0.12;
  const dxv = right.x * rightAmount * step + up.x * upAmount * step;
  const dyv = right.y * rightAmount * step + up.y * upAmount * step;
  const dzv = right.z * rightAmount * step + up.z * upAmount * step;
  cam.position.x += dxv;
  cam.position.y += dyv;
  cam.position.z += dzv;
  c.target.x += dxv;
  c.target.y += dyv;
  c.target.z += dzv;
  c.update();
}

/** Reset to the initial framing. */
function resetView(): void {
  const cam = getCamera();
  const c = getControls();
  if (!cam || !c) return;
  const [cx, cy, cz] = defaultCameraPos();
  cam.position.set(cx, cy, cz);
  const [tx, ty, tz] = defaultTargetPos();
  c.target.set(tx, ty, tz);
  c.update();
}

defineExpose({ zoom, rotateY, pan, resetView });

const hoveredNode = computed(() => {
  if (!props.hoveredNodeId) return null;
  // Suppress the hover preview entirely whenever a node is selected —
  // the detail card next to the selected cube is the active info
  // surface, and any concurrent hover tooltip just doubles up the
  // same content on screen ("info shows twice"). Operators can still
  // see hover previews on every other cube once they dismiss the
  // selection.
  if (props.selectedNodeId) return null;
  const n = graph.nodesByKey.get(props.hoveredNodeId);
  if (!n) return null;
  const pos = placement.nodes.get(props.hoveredNodeId);
  if (!pos) return null;
  return { node: n, pos };
});

// Pre-built layer-key → {name, group} map so the detail card can show
// the human-readable layer name + group alongside the cube it sits on.
const layerInfo = new Map<string, { name: string; group: string | null }>();
for (const L of graph.layers) {
  layerInfo.set(L.key, { name: L.name, group: L.group });
}

const selectedNodeDetail = computed(() => {
  if (!props.selectedNodeId) return null;
  const n = graph.nodesByKey.get(props.selectedNodeId);
  if (!n) return null;
  const pos = placement.nodes.get(props.selectedNodeId);
  if (!pos) return null;
  const layer = layerInfo.get(n.layerKey) ?? null;
  return { node: n, pos, layer };
});

// ── Detail-card side: flip to whichever side of the canvas has more
//    room. Recomputed during the render loop alongside the label-hide
//    pass so it tracks orbit / pan / zoom. The card itself is
//    portaled by cientos <Html> at the cube's projected position;
//    `selectedSide` controls a CSS class that translates the card
//    horizontally either to the right of the cube (`side=right`) or
//    to the left (`side=left`).
//
//    Hysteresis on the flip: when the cube projects close to the
//    canvas centerline a naive `x < 0` rule would oscillate on every
//    sub-pixel camera move and the card would visually flash between
//    the two sides. We only flip when the cube has clearly crossed
//    to the OPPOSITE half (|NDC.x| > 0.25), AND we re-pick freely
//    the first time a new node is selected (so the initial side is
//    always correct).
const selectedSide = ref<'left' | 'right'>('right');
let lastSidedNodeId: string | null = null;
const _projVec = new Vector3();
function updateSelectedSide(): void {
  const detail = selectedNodeDetail.value;
  const cam = getCamera();
  if (!detail || !cam) {
    lastSidedNodeId = null;
    return;
  }
  _projVec.set(detail.pos.x, detail.pos.y, detail.pos.z).project(cam);
  if (lastSidedNodeId !== detail.node.nodeId) {
    // First reading for this selection: choose side from raw projection.
    lastSidedNodeId = detail.node.nodeId;
    selectedSide.value = _projVec.x < 0 ? 'right' : 'left';
    return;
  }
  // Subsequent readings: only flip on a clear crossing.
  const HYST = 0.25;
  if (selectedSide.value === 'right' && _projVec.x > HYST) {
    selectedSide.value = 'left';
  } else if (selectedSide.value === 'left' && _projVec.x < -HYST) {
    selectedSide.value = 'right';
  }
}

onUnmounted(() => {
  nodeGeometry.dispose();
  packetGeometry.dispose();
  planeMaterial.dispose();
  for (const m of zoneMaterials.values()) m.dispose();
  for (const m of nodeMaterials.values()) m.dispose();
  for (const m of hoverMaterials.values()) m.dispose();
  selectedMat.dispose();
  callEdgeMat.dispose();
  callPacketMat.dispose();
  crossEdgeMat.dispose();
  crossArrowMat.dispose();
  hierarchyMat.dispose();
  crossArrowGeometry.dispose();
  alarmCapGeometry.dispose();
  alarmCapMat.dispose();
  for (const m of iconStampMaterials.values()) m.dispose();
  disposeLayerIconTextures();
  for (const t of callTubes.value) t.geometry.dispose();
  for (const t of crossTubes.value) t.geometry.dispose();
  for (const t of verticalTubes.value) t.geometry.dispose();
  for (const t of hierarchyTubes.value) t.geometry.dispose();
});
</script>

<template>
  <div
    ref="canvasHostEl"
    class="canvas-host"
    @pointerdown="onHostPointerDown"
    @pointerup="onHostPointerUp"
  >
    <TresCanvas
      clear-color="#0a0d12"
      :antialias="true"
      power-preference="high-performance"
      @loop="onSceneLoop"
    >
      <TresPerspectiveCamera
        ref="cameraRef"
        :position="initialCameraPos"
        :fov="42"
        :near="0.1"
        :far="600"
      />
      <OrbitControls
        ref="controlsRef"
        :target="initialTarget"
        :enable-pan="true"
        :enable-zoom="true"
        :enable-rotate="true"
        :min-distance="8"
        :max-distance="240"
        :max-polar-angle="Math.PI * 0.49"
      />
      <TresAmbientLight :intensity="0.75" />
      <TresDirectionalLight :position="[40, 60, 30]" :intensity="0.9" />
      <TresDirectionalLight :position="[-30, 40, -20]" :intensity="0.3" color="#38bdf8" />

      <!-- Tier planes — neutral slate backdrops. These DO participate
           in raycasting on purpose: they occlude. A plane between
           the camera and a cube behind it must absorb the click /
           hover so the operator doesn't get a see-through pick of a
           cube they can't visually see. The plane carries no @click
           handler, so a click on an empty plane area lands on the
           plane and is harmlessly dropped — exactly what we want for
           empty-space behaviour. -->
      <TresMesh
        v-for="P in placement.planes"
        :key="`plane:${P.id}`"
        :position="[0, P.y, 0]"
        :rotation="[-Math.PI / 2, 0, 0]"
      >
        <TresPlaneGeometry :args="[P.width, P.depth]" />
        <primitive :object="planeMaterial" />
      </TresMesh>

      <!-- Layer zones — colored backplates. Same occlusion rule as
           the tier planes above: they raycast, so they hide cubes
           visually-behind them from picking. -->
      <template v-for="Z in visibleZones" :key="`zone:${Z.layerKey}`">
        <TresMesh
          :position="[Z.centerX, Z.y + 0.02, Z.centerZ]"
          :rotation="[-Math.PI / 2, 0, 0]"
        >
          <TresPlaneGeometry :args="[Z.width, Z.depth]" />
          <primitive :object="zoneMaterial(resolveLayerColor(Z.layerKey, Z.tint))" />
        </TresMesh>
        <!-- Layer mark — the project's logo PRINTED onto the zone's
             colour swatch. Built as a textured PlaneGeometry rotated
             flat to the zone surface so it tilts and rotates with the
             camera like a real stamp (operator can read it from any
             angle as long as the camera is above the plane). With the
             side panel showing only tiers, this stamp is the
             operator's primary cue for which project a zone represents:
             Istio sail for mesh layers, K8s helm wheel for k8s, and
             generic family marks for everything else. -->
        <TresMesh
          :position="[Z.centerX - Z.width / 2 + 1.1, Z.y + 0.04, Z.centerZ + Z.depth / 2 - 1.1]"
          :rotation="[-Math.PI / 2, 0, 0]"
          :ref="(el) => disableRaycast(el)"
        >
          <TresPlaneGeometry :args="[1.7, 1.7]" />
          <primitive :object="iconStampMaterial(Z.layerKey, Z.tint)" />
        </TresMesh>
      </template>

      <TresMesh
        v-for="n in visibleNodes"
        :key="n.node.nodeId"
        :position="[n.pos.x, n.pos.y + 0.55, n.pos.z]"
        v-on="nodeHandlers(n.node)"
      >
        <primitive :object="nodeGeometry" />
        <primitive
          :object="
            props.selectedNodeId === n.node.nodeId
              ? selectedMat
              : props.hoveredNodeId === n.node.nodeId
              ? hoverMaterial(n.colorHex)
              : nodeMaterial(n.colorHex)
          "
        />
      </TresMesh>

      <!-- Alarm cap — the top ~20% of an alarmed cube, painted red. The
           cube keeps its layer color below; the red crown is the alert
           signal. raycast disabled (it sits on the cube top and would
           otherwise steal clicks aimed at the cube). -->
      <TresMesh
        v-for="n in alarmedNodes"
        :key="`alarmcap:${n.node.nodeId}`"
        :position="[n.pos.x, n.pos.y + 0.95, n.pos.z]"
        :ref="(el) => disableRaycast(el)"
      >
        <primitive :object="alarmCapGeometry" />
        <primitive :object="alarmCapMat" />
      </TresMesh>

      <!-- Traffic chip — small numeric pill that LIVES WITH its cube.
           Anchored at the cube's centre so the chip follows the
           cube's screen projection as the camera moves. Occlude is
           OFF: anchoring inside the cube would make the cube
           self-occlude its own chip (raycaster hits the cube's near
           face first). The "occluded together" semantic is then
           approximated by depth — cienitos draws the chip at the
           anchor's depth, so when a foreground object hides the
           cube, the chip's pixels also fall behind that object.
           Rendered only on cubes that are close enough to read
           (projected width ≥ CHIP_PIXEL_MIN px) OR on the currently-
           selected cube (always shown). -->
      <template v-for="n in visibleNodes" :key="`chip:${n.node.nodeId}`">
        <Html
          v-if="chipVisible(n.node)"
          :position="[n.pos.x, n.pos.y + 0.55, n.pos.z]"
          center
          :occlude="false"
          pointer-events="none"
          :z-index-range="[35, 1]"
        >
          <div class="traffic-chip" :style="{ borderColor: n.colorHex }">
            <span class="val">{{ trafficText(n.node) }}</span>
            <span class="unit">{{ trafficUnit(n.node) }}</span>
          </div>
        </Html>
      </template>

      <TresMesh
        v-for="(t, ti) in callTubes"
        :key="`cedge:${ti}`"
        :ref="(el) => disableRaycast(el)"
      >
        <primitive :object="t.geometry" />
        <primitive :object="callEdgeMat" />
      </TresMesh>

      <!-- Hierarchy edges — soft cyan tubes connecting agent / mesh /
           k8s_service views of the SAME logical service. Selection-
           gated: only rendered when the operator picks a cube, then
           hidden on deselect. Undirected, no arrow, no animated
           packets — they tell identity, not traffic. -->
      <TresMesh
        v-for="(t, ti) in hierarchyTubes"
        :key="`hedge:${ti}`"
        :ref="(el) => disableRaycast(el)"
      >
        <primitive :object="t.geometry" />
        <primitive :object="hierarchyMat" />
      </TresMesh>

      <!-- Cross-layer call edges (in-level, always-on) — amber tube +
           arrow cone at target. e.g. BROWSER agent::ui → GENERAL
           agent::frontend, GENERAL agent::songs → VIRTUAL_DB psql. -->
      <template v-for="(t, ti) in crossTubes" :key="`xedge:${ti}`">
        <TresMesh :ref="(el) => disableRaycast(el)">
          <primitive :object="t.geometry" />
          <primitive :object="crossEdgeMat" />
        </TresMesh>
        <TresMesh
          :position="[t.edge.arrowPos.x, t.edge.arrowPos.y, t.edge.arrowPos.z]"
          :quaternion="[t.arrowQuat.x, t.arrowQuat.y, t.arrowQuat.z, t.arrowQuat.w]"
          :ref="(el) => disableRaycast(el)"
        >
          <primitive :object="crossArrowGeometry" />
          <primitive :object="crossArrowMat" />
        </TresMesh>
      </template>

      <!-- Vertical cross-plane call edges — selection-gated. Only
           drawn when the operator has selected a cube AND that cube
           sits at one end. Shows the selected service's relatives on
           other planes, then hides on deselect. -->
      <template v-for="(t, ti) in verticalTubes" :key="`vedge:${ti}`">
        <TresMesh :ref="(el) => disableRaycast(el)">
          <primitive :object="t.geometry" />
          <primitive :object="crossEdgeMat" />
        </TresMesh>
        <TresMesh
          :position="[t.edge.arrowPos.x, t.edge.arrowPos.y, t.edge.arrowPos.z]"
          :quaternion="[t.arrowQuat.x, t.arrowQuat.y, t.arrowQuat.z, t.arrowQuat.w]"
          :ref="(el) => disableRaycast(el)"
        >
          <primitive :object="crossArrowGeometry" />
          <primitive :object="crossArrowMat" />
        </TresMesh>
      </template>

      <TresMesh
        v-for="(p, pi) in packets"
        :key="`pkt:${pi}`"
        :position="p.pos"
        :ref="(el) => disableRaycast(el)"
      >
        <primitive :object="packetGeometry" />
        <primitive :object="callPacketMat" />
      </TresMesh>

      <!-- Hover tooltip — anchored above the hovered cube via cientos
           <Html>, so it follows the cube in 3D. occlude=false because
           the operator's intent is to read what they just hovered;
           hiding the tooltip behind 3D geometry would be surprising. -->
      <Html
        v-if="hoveredNode"
        :position="[hoveredNode.pos.x, hoveredNode.pos.y + 1.3, hoveredNode.pos.z]"
        center
        :occlude="false"
        pointer-events="none"
        :z-index-range="[2000000000, 2000000000]"
      >
        <div class="floating-tip">
          <span class="tip-name">{{ hoveredNode.node.shortName }}</span>
          <span class="tip-layer">{{ hoveredNode.node.layerKey }}</span>
          <span class="tip-full">{{ hoveredNode.node.name }}</span>
        </div>
      </Html>

      <!-- Detail card — anchored beside the SELECTED cube. The card's
           horizontal side ("left" / "right") is flipped each render-
           loop tick based on which half of the canvas the cube lands
           on (so it stays clear of the screen edge). Visibility of
           the card is bound 1-to-1 with `selectedNodeId` — selecting
           always shows it, deselecting always hides it. -->
      <Html
        v-if="selectedNodeDetail"
        :position="[selectedNodeDetail.pos.x, selectedNodeDetail.pos.y + 0.6, selectedNodeDetail.pos.z]"
        :occlude="false"
        :z-index-range="[2100000000, 2100000000]"
      >
        <div class="detail-card" :data-side="selectedSide">
          <div class="d-head">
            <div class="d-title">
              <span class="d-name">{{ selectedNodeDetail.node.shortName }}</span>
              <span class="d-sub">service</span>
            </div>
            <button
              type="button"
              class="d-close"
              aria-label="close detail"
              @click.stop="emit('select', null)"
            >×</button>
          </div>
          <div class="d-rows">
            <div class="d-row">
              <span class="d-label">Layer</span>
              <span class="d-val">
                {{ selectedNodeDetail.layer?.name ?? selectedNodeDetail.node.layerKey }}
              </span>
            </div>
            <div v-if="selectedNodeDetail.layer?.group" class="d-row">
              <span class="d-label">Group</span>
              <span class="d-val">{{ selectedNodeDetail.layer.group }}</span>
            </div>
          </div>
          <div class="d-foot">
            <!-- Plain anchor (not RouterLink) so `target="_blank"` opens a
                 real new tab. We point at the layer's main service view,
                 which is the default landing for every active layer. -->
            <a
              :href="`/layer/${selectedNodeDetail.node.layerKey}/service`"
              target="_blank"
              rel="noopener"
              class="d-btn"
            >
              Open dashboard
              <span class="d-btn-arrow">↗</span>
            </a>
          </div>
        </div>
      </Html>
    </TresCanvas>
  </div>
</template>

<style scoped>
.canvas-host {
  position: relative;
  width: 100%;
  height: 100%;
  background: #0a0d12;
}
/* Hover tooltip + zone label content lives inside cientos <Html>
   portals — declared in the non-scoped block below since the portal
   escapes scoped CSS. The `infra3d-html-passthrough` class on the
   wrapper makes the entire portal pointer-transparent so it can't
   absorb clicks meant for cubes (see "click-thief" notes in
   CLAUDE.md). */
</style>

<style>
/* NOTE: pointer-events on cientos <Html> wrappers is set via the
   component's `pointer-events="none"` prop (NOT a CSS class). Cientos
   applies `pointerEvents` as an INLINE style on the wrapper, which
   has higher specificity than any external class rule we could write.
   See CLAUDE.md "click-thief" section. */

/* Hover tooltip — portaled via cientos <Html>, so non-scoped.
   Anchored at the hovered cube; the translate-Y offset lifts it
   slightly above the cube so the cube stays visible while the
   tooltip reads. pointer-events: none keeps it from absorbing
   the click the operator's about to make on the cube. */
.floating-tip {
  background: rgba(15, 19, 26, 0.96);
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  padding: 5px 9px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-size: 11px;
  color: var(--sw-fg-0);
  pointer-events: none;
  white-space: nowrap;
  transform: translateY(-100%);
  box-shadow: 0 4px 14px -6px rgba(0, 0, 0, 0.6);
  /* Sits above every traffic chip — cientos portals every <Html> as a
     stacking-context-less absolute element, and without an explicit
     z-index the per-cube chips (rendered later in the v-for) end up
     painted on top of the hover tooltip. The tooltip is the operator's
     focused-on info, so it always wins. */
  position: relative;
  z-index: 20;
}
.floating-tip .tip-name { font-weight: 700; font-size: 12px; }
.floating-tip .tip-layer {
  font-size: 9px;
  color: var(--sw-fg-3);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.floating-tip .tip-full {
  font-size: 10px;
  color: var(--sw-fg-2);
  font-family: var(--sw-mono, monospace);
}

/* Traffic chip — small numeric pill below each cube reading the
   stage-5 MQE result. Border picks up the layer color so the chip
   visually parents to its cube; the body stays dark so the number
   is the loudest thing on the chip. */
.traffic-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 3px;
  padding: 1px 5px;
  background: rgba(11, 14, 19, 0.88);
  border: 1px solid;
  border-radius: 8px;
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--sw-fg-0);
  white-space: nowrap;
  user-select: none;
  pointer-events: none;
  /* The Html anchor sits at the cube centre so depth is shared with
     the cube (cientos occlusion test). Push the chip in screen space
     to a spot just below the cube so it visually labels the cube
     without sitting inside the geometry. */
  transform: translate(-50%, 36px);
  position: relative;
  left: 50%;
  /* Quiet fade so a fresh value reads as "new" without distracting. */
  animation: chip-fade 0.45s ease-out;
}
.traffic-chip .val  { font-variant-numeric: tabular-nums; }
.traffic-chip .unit { font-size: 8.5px; color: var(--sw-fg-3); font-weight: 500; }
@keyframes chip-fade {
  from { opacity: 0; transform: translate(-50%, 28px); }
  to   { opacity: 1; transform: translate(-50%, 36px); }
}

/* Detail card — portaled via cientos <Html> at the selected cube.
   The `data-side` attribute picks which side of the cube the card
   anchors to (right vs left), recomputed each render-loop tick so
   the card stays clear of the canvas edge as the operator rotates
   the scene. Positioning is by `transform` (not `left`/`right`) so
   the card hangs precisely from the cube's projected pixel without
   forcing layout. */
.detail-card {
  width: 244px;
  background: rgba(15, 19, 26, 0.97);
  border: 1px solid rgba(249, 115, 22, 0.55);
  border-radius: 10px;
  box-shadow:
    0 0 0 1px rgba(249, 115, 22, 0.15),
    0 12px 28px -10px rgba(0, 0, 0, 0.7),
    0 0 18px -6px rgba(249, 115, 22, 0.35);
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  color: var(--sw-fg-0);
}
.detail-card[data-side='right'] {
  transform: translate(20px, -50%);
}
.detail-card[data-side='left'] {
  transform: translate(calc(-100% - 20px), -50%);
}
.detail-card .d-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 10px 12px 8px;
  gap: 8px;
}
.detail-card .d-title {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.detail-card .d-name {
  font-weight: 700;
  font-size: 15px;
  color: var(--sw-fg-0);
  line-height: 1.15;
  word-break: break-all;
}
.detail-card .d-sub {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--sw-accent-2);
  font-weight: 700;
}
.detail-card .d-close {
  background: transparent;
  border: none;
  color: var(--sw-fg-3);
  font-size: 18px;
  cursor: pointer;
  line-height: 1;
  padding: 0 4px;
  flex: 0 0 auto;
}
.detail-card .d-close:hover { color: var(--sw-fg-0); }
.detail-card .d-rows {
  padding: 0 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.detail-card .d-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 12px;
}
.detail-card .d-label {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sw-fg-3);
  flex: 0 0 50px;
  font-weight: 600;
}
.detail-card .d-val {
  color: var(--sw-fg-0);
  flex: 1 1 auto;
  min-width: 0;
  word-break: break-word;
}
.detail-card .d-foot {
  padding: 0 12px 12px;
}
.detail-card .d-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  padding: 8px 12px;
  background: linear-gradient(180deg, rgba(249, 115, 22, 0.18), rgba(249, 115, 22, 0.08));
  border: 1px solid rgba(249, 115, 22, 0.55);
  border-radius: 6px;
  color: var(--sw-accent-2);
  font-size: 12px;
  font-weight: 700;
  text-decoration: none;
  letter-spacing: 0.02em;
  transition: background 160ms, border-color 160ms, color 160ms;
}
.detail-card .d-btn:hover {
  background: linear-gradient(180deg, rgba(249, 115, 22, 0.32), rgba(249, 115, 22, 0.16));
  border-color: rgba(249, 115, 22, 0.85);
  color: #ffe6c8;
}
.detail-card .d-btn-arrow {
  font-size: 11px;
  opacity: 0.9;
}
</style>
