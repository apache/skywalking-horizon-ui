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
  EdgesGeometry,
  type Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Vector3,
} from 'three';
import {
  buildSceneGraph,
  loadFallbackTopology,
  type MapTopology,
  type SceneServiceNode,
} from './composables/useMapTopology';
import {
  computePlacement,
  type SceneGroupSpec,
  type NodePlacement,
  type PlaneSpec,
  type PlanePlacement,
  type ZonePlacement,
  type ZoneTint,
} from './composables/useScenePlacement';
import type { ServiceNamingRule } from '@skywalking-horizon-ui/api-client';
import { levelForLayer, isLayerExcluded } from './composables/useInfra3dConfig';
import { resolveServiceIdentity } from '@/utils/serviceName';
import { useInfra3dAlarms, alarmKey } from './composables/useInfra3dAlarms';
import { useInfra3dMetrics, formatMetricValue } from './composables/useInfra3dMetrics';
import { useSceneCamera } from './composables/useSceneCamera';
import { useSceneEdges } from './composables/useSceneEdges';
import {
  CLUSTER_LABEL_H,
  PLANE_THICKNESS,
  RIPPLE_MAX_OPACITY,
  RIPPLE_MAX_SCALE,
  RIPPLE_MIN_SCALE,
  RIPPLE_PERIOD,
  RIPPLE_PHASES,
  useSceneMaterials,
} from './composables/useSceneMaterials';

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
  /** Beacon mode — dim every healthy cube to a dark wireframe ghost and
   *  let only alarmed cubes glow, so the operator's eye locks onto what
   *  is firing. */
  beaconMode?: boolean;
  /** Logic groups from the config — clustered into one block per group
   *  on the group's tier. */
  groups?: SceneGroupSpec[];
  /** Single-layer focus mode (`/3d/map?layer=<key>`): render ONLY this
   *  plane's slab so the scene reads as one layer's internal topology
   *  rather than the full multi-tier map. Null = full map (default). The
   *  parent also narrows `visibleLayers` to the focused layer, so only
   *  its zone + cubes draw. */
  soloPlane?: string | null;
  /** Per-layer topology-cluster rules (upper-case key → rule). A solo
   *  layer with a rule yielding ≥2 clusters is laid out cluster-by-
   *  cluster (k8s/mesh namespace grouping), matching the 2D map. */
  namingByLayer?: Record<string, ServiceNamingRule | null>;
  /** Live-assembled topology to render instead of the committed snapshot.
   *  Null/absent ⇒ the snapshot. The build below runs once at setup, so
   *  the parent re-keys this component to rebuild when the live structure
   *  changes. */
  topology?: MapTopology | null;
}
const props = defineProps<Props>();
const emit = defineEmits<{
  (e: 'hover', node: SceneServiceNode | null): void;
  (e: 'select', node: SceneServiceNode | null): void;
  (e: 'zones', zones: ZonePlacement[]): void;
  (e: 'planes', planes: PlanePlacement[]): void;
  (e: 'nodes-by-layer', byLayer: Record<string, SceneServiceNode[]>): void;
}>();

// Build with the config-aware level resolver so each layer lands on
// its admin-configured plane. The parent guarantees the config is
// loaded before mounting this component (see Infra3DView.vue), so
// `levelForLayer` returns deterministic values here, not the synchronous
// fallback. `planeOrder` is the source of truth for vertical stacking.
const topo = props.topology ?? loadFallbackTopology();
const graph = buildSceneGraph(topo, levelForLayer, isLayerExcluded);
const placement = computePlacement(graph, props.planeOrder, props.groups, props.namingByLayer);

// Shared geometries + materials (cache-and-dispose factory). `dispose()`
// in onUnmounted frees every GL resource owned here.
const mats = useSceneMaterials();
const {
  resolveLayerColor,
  zoneMaterial,
  nodeMaterial,
  hoverMaterial,
  iconStampMaterial,
  groupStampMaterial,
  clusterLabel,
} = mats;

// Past-20m alarm overlay — affected service names get the red alarm
// material in place of the layer tint. Polled every 1 min on a shared
// timer (refcount inside the composable).
const { alarmedKeys, alarmedNamesNoLayer } = useInfra3dAlarms();

// Visible cubes that currently carry an active 20m alarm. Matched on
// (layer, name) so an alarm reddens only the exact service in the exact
// tier — never every same-named cube across layers; alarms with no
// resolved layer fall back to name-only. We compute the subset once per
// render so the template iterates ONLY the alarmed cubes (no per-cube v-if).
const alarmedNodes = computed(() =>
  visibleNodes.value.filter(
    (n) =>
      alarmedKeys.value.has(alarmKey(n.node.layerKey, n.node.name)) ||
      alarmedNamesNoLayer.value.has(n.node.name),
  ),
);
/** Alarmed cube ids — O(1) lookup for the per-cube material pick. */
const alarmedNodeIds = computed(() => new Set(alarmedNodes.value.map((n) => n.node.nodeId)));

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

const visibleZones = computed(() =>
  placement.zones.filter((z) =>
    // A group zone shows if any member layer is visible; a solo zone if
    // its own layer is.
    z.group ? z.group.layerKeys.some((k) => isVisible(k)) : isVisible(z.layerKey),
  ),
);

// Topology-cluster bands (k8s/mesh namespace grouping) of the visible
// zones, flattened with their plane Y for the floating labels. Absent
// for layers without a naming rule (most), so this is usually empty.
const clusterBands = computed(() =>
  visibleZones.value.flatMap((z) =>
    (z.clusters ?? []).map((b, i) => ({
      ...b,
      y: z.y,
      colorHex: resolveLayerColor(z.layerKey, z.tint),
      key: `${z.layerKey}:${i}`,
    })),
  ),
);

// ── Cluster frames + baked-text labels ─────────────────────────────
// Each topology-cluster band draws as a thin wireframe rectangle on the
// plane (一个线条的框) with its namespace baked into a flat texture stamp
// at the frame's bottom-left corner — the same baked-plane treatment as
// the layer-icon stamps, so the name tilts with the camera in 3D. The
// frame material + baked-label cache live in useSceneMaterials.
const clusterFrames = computed(() =>
  clusterBands.value.map((b) => {
    const pg = new PlaneGeometry(b.width, b.depth);
    const geom = new EdgesGeometry(pg);
    pg.dispose();
    const { mat, aspect } = clusterLabel(b.label, b.colorHex);
    const labelW = Math.min(b.width - 0.4, aspect * CLUSTER_LABEL_H);
    const labelH = labelW / aspect;
    return { band: b, geom, labelMat: mat, labelW, labelH };
  }),
);
// Free the previous frame batch when a visibility change re-mints the set.
watch(clusterFrames, (_now, prev) => { for (const f of prev) f.geom.dispose(); }, { flush: 'post' });

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
  // Map every layer to its zone. A group zone is keyed by the group id,
  // so fan it out to each member layer key — otherwise grouped layers
  // (e.g. so11y_*) find no zone and their cubes vanish (empty block).
  const zoneByLayer = new Map<string, ZonePlacement>();
  for (const z of placement.zones) {
    if (z.group) for (const k of z.group.layerKeys) zoneByLayer.set(k, z);
    else zoneByLayer.set(z.layerKey, z);
  }
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

// Edge model + per-edge tube geometries (intra-layer call, same-plane
// cross-layer call, selection-gated cross-plane call, selection-gated
// hierarchy). The composable owns the fresh-batch / free-prev-batch
// dispose discipline; `edges.disposeAll()` frees the current batch on
// unmount. Selection + visibility gates are passed in.
const edges = useSceneEdges(
  graph,
  placement,
  isVisible,
  computed(() => props.selectedNodeId),
);
const {
  visibleCallEdges,
  visibleCrossEdges,
  visibleVerticalEdges,
  callTubes,
  crossTubes,
  verticalTubes,
  hierarchyTubes,
} = edges;

// All shared geometries / materials live in useSceneMaterials (cache-and-
// dispose factory); destructure the handful the template + frame loop
// reference directly.
const {
  nodeGeometry,
  packetGeometry,
  crossArrowGeometry,
  rippleGeometry,
  cubeEdgesGeometry,
  planeMaterial,
  planeEdgeMaterial,
  selectedMat,
  alarmMat,
  callEdgeMat,
  callPacketMat,
  crossEdgeMat,
  crossArrowMat,
  crossPacketMat,
  hierarchyMat,
  ghostMat,
  cubeEdgeMat,
  glowMat,
  flashMat,
  clusterFrameMat,
  rippleMats,
} = mats;

// Opt decorative geometry out of pointer picking.
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

// Tier "planes" are volumetric glass slabs, not flat sheets — a box of
// PLANE_THICKNESS whose TOP face sits at the plane's Y (where cubes rest).
// Slab geometry is per-plane (each tier has its own footprint) and the
// layout is static, so bake the box + its edge wireframe once. Centred
// half a thickness BELOW the plane Y so the slab's top face is exactly
// where the cubes rest. (The slab + rim MATERIALS live in useSceneMaterials.)
const planeSlabs = placement.planes.map((P) => {
  const box = new BoxGeometry(P.width, PLANE_THICKNESS, P.depth);
  return {
    id: P.id,
    y: P.y - PLANE_THICKNESS / 2,
    box,
    edges: new EdgesGeometry(box),
  };
});

// Animated traffic packets — intra-layer call edges only.
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

// Cross-layer call edges flow too — packets travel caller→callee along
// the curve (getPoint 0→1 = from→to) so the operator reads the call
// DIRECTION, not just the static arrow head. Covers the always-on
// same-plane edges and the selection-gated vertical ones. Amber to
// match the cross-edge tubes; intra-layer packets stay cyan (crossPacketMat
// lives in useSceneMaterials).
const crossPackets = shallowRef<Packet[]>([]);
function rebuildCrossPackets(): void {
  const out: Packet[] = [];
  const add = (e: { curve: CatmullRomCurve3 }): void => {
    for (let k = 0; k < 2; k++) out.push({ curve: e.curve, phase: k / 2, pos: new Vector3() });
  };
  visibleCrossEdges.value.forEach(add);
  visibleVerticalEdges.value.forEach(add);
  crossPackets.value = out;
}
watch([visibleCrossEdges, visibleVerticalEdges], rebuildCrossPackets, { immediate: true });

// One ripple entry per (alarmed cube × phase). `pos` is the ring's
// anchor on the plane (static — the cube doesn't move); `mesh` is the
// live THREE mesh captured via the template ref so onSceneLoop can set
// its scale each frame.
interface AlarmRipple {
  pos: [number, number, number];
  phase: number;
  mesh: Object3D | null;
}
const alarmRipples = shallowRef<AlarmRipple[]>([]);
function rebuildAlarmRipples(): void {
  const out: AlarmRipple[] = [];
  for (const n of alarmedNodes.value) {
    for (let p = 0; p < RIPPLE_PHASES; p++) {
      out.push({ pos: [n.pos.x, n.pos.y + 0.03, n.pos.z], phase: p, mesh: null });
    }
  }
  alarmRipples.value = out;
}
watch(alarmedNodes, rebuildAlarmRipples, { immediate: true });
function bindRipple(r: AlarmRipple, el: unknown): void {
  if (!el) {
    r.mesh = null;
    return;
  }
  const obj = (el as { isObject3D?: boolean }).isObject3D
    ? (el as Object3D)
    : (el as { value?: { isObject3D?: boolean } }).value?.isObject3D
      ? (el as { value: Object3D }).value
      : null;
  r.mesh = obj;
  if (obj) obj.raycast = _noopRaycast;
}

// Camera controller — owns the THREE camera + OrbitControls plumbing and
// the toolbar action methods (re-exposed below). `camGoal` is the side-
// panel focus goal the frame loop glides toward.
const camera = useSceneCamera(placement.bounds);
const {
  cameraRef,
  controlsRef,
  camGoal,
  initialCameraPos,
  initialTarget,
  getCamera,
  getControls,
  zoom,
  rotateY,
  pan,
  resetView,
  focusOn,
} = camera;

const period = 2.6;
const canvasHostEl = ref<HTMLElement | null>(null);
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
let sceneElapsed = 0;
const FLASH_SECONDS = 4;
const flashState = shallowRef<{ keys: Set<string>; start: number } | null>(null);
// Frame loop: animate packets + glide the orbit target toward the focus
// goal, and recompute label-overflow / detail-card side. Everything writes
// the live THREE objects directly (not Vue reactivity) so mouse-driven and
// programmatic camera/label changes stay in sync.
function onSceneLoop(ctx: { elapsed: number; delta: number }): void {
  sceneElapsed = ctx.elapsed;
  for (const p of packets.value) {
    const t = ((ctx.elapsed / period) + p.phase) % 1;
    p.curve.getPoint(t, p.pos);
  }
  for (const p of crossPackets.value) {
    const t = ((ctx.elapsed / period) + p.phase) % 1;
    p.curve.getPoint(t, p.pos);
  }
  // Alarm ripples — expand + fade each phase's ring; the shared
  // per-phase material carries the opacity, each ring mesh its scale.
  if (alarmRipples.value.length > 0) {
    const scaleByPhase: number[] = [];
    for (let p = 0; p < RIPPLE_PHASES; p++) {
      const t = ((ctx.elapsed / RIPPLE_PERIOD) + p / RIPPLE_PHASES) % 1;
      scaleByPhase[p] = RIPPLE_MIN_SCALE + t * (RIPPLE_MAX_SCALE - RIPPLE_MIN_SCALE);
      rippleMats[p]!.opacity = (1 - t) * RIPPLE_MAX_OPACITY;
    }
    for (const r of alarmRipples.value) r.mesh?.scale.setScalar(scaleByPhase[r.phase]!);
  }
  // Side-panel focus — glide pos+target; precedes the target-only path.
  if (camGoal.value) {
    const cam = getCamera();
    const c = getControls();
    if (cam && c) {
      const g = camGoal.value;
      const k = Math.min(1, ctx.delta * 4);
      cam.position.lerp(g.pos, k);
      c.target.lerp(g.target, k);
      c.update();
      if (cam.position.distanceTo(g.pos) < 0.15 && c.target.distanceTo(g.target) < 0.1) {
        cam.position.copy(g.pos);
        c.target.copy(g.target);
        c.update();
        camGoal.value = null;
      }
    } else {
      camGoal.value = null;
    }
  } else if (props.focusTarget) {
    // Focus lerp — write straight into the live OrbitControls.target so
    // the move sticks even when the operator mouses on top of it. Snap
    // when close so the loop doesn't keep nudging the sub-pixel residual.
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
  // Region flash — pulse + fade the selected zones' plates over ~4s.
  if (flashState.value) {
    const age = ctx.elapsed - flashState.value.start;
    if (age >= FLASH_SECONDS) {
      flashState.value = null;
      flashMat.opacity = 0;
    } else {
      const pulse = 0.5 + 0.5 * Math.sin(age * Math.PI * 2.2);
      flashMat.opacity = pulse * (1 - age / FLASH_SECONDS) * 0.4;
    }
  }
  if (ctx.elapsed - lastLabelTick > 0.15) {
    lastLabelTick = ctx.elapsed;
    updateSelectedSide();
    updateCloseNodes();
  }
}

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

// Stable per-node handler cache.
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

function flashZones(layerKeys: string[]): void {
  flashState.value = { keys: new Set(layerKeys), start: sceneElapsed };
}
const flashRender = computed(() => {
  const fs = flashState.value;
  if (!fs) return [];
  return placement.zones.filter((z) =>
    z.group ? z.group.layerKeys.some((k) => fs.keys.has(k)) : fs.keys.has(z.layerKey),
  );
});

defineExpose({ zoom, rotateY, pan, resetView, focusOn, flashZones });

// Pre-built layer-key → {name, group} + layer-key → tier (plane) name,
// so the hover + detail cards can show the human-readable layer, its
// family group, and the tier the cube sits on.
const layerInfo = new Map<string, { name: string; group: string | null }>();
for (const L of graph.layers) layerInfo.set(L.key, { name: L.name, group: L.group });
const planeNameById = new Map(placement.planes.map((p) => [p.id, p.name]));
const layerPlaneName = new Map<string, string>();
for (const z of placement.zones) {
  const pn = planeNameById.get(z.plane) ?? z.plane;
  if (z.group) for (const k of z.group.layerKeys) layerPlaneName.set(k, pn);
  else layerPlaneName.set(z.layerKey, pn);
}

/** Shared cube description — drives BOTH the hover preview and the click
 *  detail card so they read identically. `group` is the service's
 *  `<group>::` prefix; `cluster` is the topology-cluster (k8s/mesh
 *  namespace) when the layer has a naming rule. */
interface NodeInfo {
  display: string;
  service: string;
  tier: string | null;
  layer: string;
  group: string | null;
  cluster: string | null;
  clusterAlias: string | null;
}
function describeNode(node: SceneServiceNode): NodeInfo {
  const li = layerInfo.get(node.layerKey);
  const rule = props.namingByLayer?.[node.layerKey.toUpperCase()] ?? null;
  const id = resolveServiceIdentity(node.name, rule);
  return {
    display: id.display || node.shortName,
    service: node.name,
    tier: layerPlaneName.get(node.layerKey) ?? null,
    layer: li?.name ?? node.layerKey,
    group: id.legacyGroup,
    cluster: id.cluster,
    clusterAlias: id.clusterAlias,
  };
}

// Hover preview is suppressed while a node is selected — the detail card
// is the active info surface and a concurrent hover would double up.
const hoveredNode = computed(() => {
  if (!props.hoveredNodeId || props.selectedNodeId) return null;
  const n = graph.nodesByKey.get(props.hoveredNodeId);
  if (!n) return null;
  const pos = placement.nodes.get(props.hoveredNodeId);
  if (!pos) return null;
  return { node: n, pos, info: describeNode(n) };
});

const selectedNodeDetail = computed(() => {
  if (!props.selectedNodeId) return null;
  const n = graph.nodesByKey.get(props.selectedNodeId);
  if (!n) return null;
  const pos = placement.nodes.get(props.selectedNodeId);
  if (!pos) return null;
  return { node: n, pos, info: describeNode(n) };
});

/** Deep-link to the selected service's layer dashboard, pre-selecting
 *  the service. The layer page seeds its pick from `?service=<id>` where
 *  `<id>` is the OAP service id (the cube carries the real id, e.g.
 *  `base64(name).1`); without it the page just auto-picks the first
 *  service. `import.meta.env.BASE_URL` keeps the path correct under a
 *  gateway sub-path (a bare `/layer/...` ignores the router base — the
 *  same trap fixed for the brand / login links). */
const openDashboardHref = computed<string>(() => {
  const d = selectedNodeDetail.value;
  if (!d) return import.meta.env.BASE_URL;
  const base = import.meta.env.BASE_URL; // ends with '/'
  const n = d.node;
  return `${base}layer/${n.layerKey}/service?service=${encodeURIComponent(n.serviceId)}`;
});

// Detail-card side: flip to whichever side of the canvas has more room,
// recomputed in the render loop alongside the label-hide pass so it tracks
// orbit / pan / zoom. The card is portaled by cientos <Html> at the cube's
// projected position; `selectedSide` just picks which way it translates.
//
// Hysteresis on the flip: near the canvas centerline a naive `x < 0`
// rule oscillates on every sub-pixel camera move and the card flashes
// between sides. We only flip when the cube clearly crosses to the
// OPPOSITE half (|NDC.x| > 0.25), AND re-pick freely the first time a
// new node is selected (so the initial side is always correct).
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
  // Composable-owned GL resources (shared materials/geometries, per-edge
  // tube batches) free themselves; the Scene only owns the per-plane slab
  // geometries and the per-batch cluster-frame edge geometries.
  mats.dispose();
  edges.disposeAll();
  for (const s of planeSlabs) {
    s.box.dispose();
    s.edges.dispose();
  }
  for (const f of clusterFrames.value) f.geom.dispose();
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
      :fps-limit="30"
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
      <template
        v-for="s in planeSlabs"
        :key="`plane:${s.id}`"
      >
        <!-- In single-layer focus mode only the focused layer's plane
             slab renders; the other tiers are hidden so the view reads
             as one layer's internal topology. -->
        <template v-if="!props.soloPlane || s.id === props.soloPlane">
        <!-- Volumetric glass slab — raycast left ON so it occludes
             cubes behind it and absorbs empty clicks (see CLAUDE.md). -->
        <TresMesh :position="[0, s.y, 0]">
          <primitive :object="s.box" />
          <primitive :object="planeMaterial" />
        </TresMesh>
        <!-- Rim wireframe — decorative, raycast disabled. -->
        <TresLineSegments :position="[0, s.y, 0]" :ref="(el) => disableRaycast(el)">
          <primitive :object="s.edges" />
          <primitive :object="planeEdgeMaterial" />
        </TresLineSegments>
        </template>
      </template>

      <!-- Layer zones — colored backplates. Same occlusion rule as
           the tier planes above: they raycast, so they hide cubes
           visually-behind them from picking. -->
      <template v-for="Z in visibleZones" :key="`zone:${Z.layerKey}`">
        <TresMesh
          :position="[Z.centerX, Z.y + 0.02, Z.centerZ]"
          :rotation="[-Math.PI / 2, 0, 0]"
        >
          <TresPlaneGeometry :args="[Z.width, Z.depth]" />
          <primitive :object="zoneMaterial(Z.group ? Z.group.color : resolveLayerColor(Z.layerKey, Z.tint))" />
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
          <primitive
            :object="Z.group ? groupStampMaterial(Z.group.icon, Z.group.color) : iconStampMaterial(Z.layerKey, Z.tint)"
          />
        </TresMesh>
      </template>

      <!-- Cluster frames (k8s/mesh namespace): wireframe rect + baked
           namespace stamp at the bottom-left. Decorative → raycast off. -->
      <template v-for="f in clusterFrames" :key="`cframe:${f.band.key}`">
        <TresLineSegments
          :position="[f.band.centerX, f.band.y + 0.05, f.band.centerZ]"
          :rotation="[-Math.PI / 2, 0, 0]"
          :ref="(el) => disableRaycast(el)"
        >
          <primitive :object="f.geom" />
          <primitive :object="clusterFrameMat" />
        </TresLineSegments>
        <TresMesh
          :position="[
            f.band.centerX - f.band.width / 2 + f.labelW / 2 + 0.25,
            f.band.y + 0.06,
            f.band.centerZ + f.band.depth / 2 - f.labelH / 2 - 0.25,
          ]"
          :rotation="[-Math.PI / 2, 0, 0]"
          :ref="(el) => disableRaycast(el)"
        >
          <TresPlaneGeometry :args="[f.labelW, f.labelH]" />
          <primitive :object="f.labelMat" />
        </TresMesh>
      </template>

      <TresMesh
        v-for="z in flashRender"
        :key="`flash:${z.layerKey}`"
        :position="[z.centerX, z.y + 0.04, z.centerZ]"
        :rotation="[-Math.PI / 2, 0, 0]"
        :ref="(el) => disableRaycast(el)"
      >
        <TresPlaneGeometry :args="[z.width, z.depth]" />
        <primitive :object="flashMat" />
      </TresMesh>

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
              : alarmedNodeIds.has(n.node.nodeId)
              ? alarmMat
              : props.beaconMode
              ? ghostMat
              : props.hoveredNodeId === n.node.nodeId
              ? hoverMaterial(n.colorHex)
              : nodeMaterial(n.colorHex)
          "
        />
      </TresMesh>

      <!-- Beacon mode: faint wireframe on every cube (blueprint read)
           + a red radial glow billboarded over each alarmed cube. Both
           decorative → raycast disabled. -->
      <template v-if="props.beaconMode">
        <TresLineSegments
          v-for="n in visibleNodes"
          :key="`cube-edge:${n.node.nodeId}`"
          :position="[n.pos.x, n.pos.y + 0.55, n.pos.z]"
          :ref="(el) => disableRaycast(el)"
        >
          <primitive :object="cubeEdgesGeometry" />
          <primitive :object="cubeEdgeMat" />
        </TresLineSegments>
        <TresSprite
          v-for="n in alarmedNodes"
          :key="`glow:${n.node.nodeId}`"
          :position="[n.pos.x, n.pos.y + 0.55, n.pos.z]"
          :scale="[2.8, 2.8, 1]"
          :ref="(el) => disableRaycast(el)"
        >
          <primitive :object="glowMat" />
        </TresSprite>
      </template>

      <!-- Alarm ripples — concentric red rings radiating across the
           plane from each alarmed cube (radar / seismic pulse). Scale
           is driven per-frame on the THREE mesh in onSceneLoop; raycast
           disabled so the flat rings never absorb cube clicks. -->
      <TresMesh
        v-for="(r, ri) in alarmRipples"
        :key="`ripple:${ri}`"
        :position="r.pos"
        :rotation="[-Math.PI / 2, 0, 0]"
        :ref="(el) => bindRipple(r, el)"
      >
        <primitive :object="rippleGeometry" />
        <primitive :object="rippleMats[r.phase]" />
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

      <TresMesh
        v-for="(p, pi) in crossPackets"
        :key="`xpkt:${pi}`"
        :position="p.pos"
        :ref="(el) => disableRaycast(el)"
      >
        <primitive :object="packetGeometry" />
        <primitive :object="crossPacketMat" />
      </TresMesh>

      <!-- Hover tooltip — anchored above the hovered cube via cientos
           <Html>, so it follows the cube in 3D. occlude=false because
           the operator's intent is to read what they just hovered;
           hiding the tooltip behind 3D geometry would be surprising. -->
      <Html
        v-if="hoveredNode"
        :position="[hoveredNode.pos.x, hoveredNode.pos.y + 0.6, hoveredNode.pos.z]"
        :occlude="false"
        pointer-events="none"
        :z-index-range="[2000000000, 2000000000]"
      >
        <!-- Hover preview — SAME card as the click detail, minus the
             "Open dashboard" footer (hover is read-only) and pointer-
             events (must never steal the click). -->
        <div class="detail-card hover">
          <div class="d-head">
            <div class="d-title">
              <span class="d-name">{{ hoveredNode.info.display }}</span>
              <span class="d-sub">service</span>
            </div>
          </div>
          <div class="d-rows">
            <div v-if="hoveredNode.info.tier" class="d-row">
              <span class="d-label">Tier</span><span class="d-val">{{ hoveredNode.info.tier }}</span>
            </div>
            <div class="d-row">
              <span class="d-label">Layer</span><span class="d-val">{{ hoveredNode.info.layer }}</span>
            </div>
            <div v-if="hoveredNode.info.group" class="d-row">
              <span class="d-label">Group</span><span class="d-val">{{ hoveredNode.info.group }}</span>
            </div>
            <div v-if="hoveredNode.info.cluster" class="d-row">
              <span class="d-label">{{ hoveredNode.info.clusterAlias || 'Cluster' }}</span>
              <span class="d-val">{{ hoveredNode.info.cluster }}</span>
            </div>
            <div class="d-row">
              <span class="d-label">Service</span><span class="d-val mono">{{ hoveredNode.info.service }}</span>
            </div>
          </div>
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
              <span class="d-name">{{ selectedNodeDetail.info.display }}</span>
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
            <div v-if="selectedNodeDetail.info.tier" class="d-row">
              <span class="d-label">Tier</span><span class="d-val">{{ selectedNodeDetail.info.tier }}</span>
            </div>
            <div class="d-row">
              <span class="d-label">Layer</span><span class="d-val">{{ selectedNodeDetail.info.layer }}</span>
            </div>
            <div v-if="selectedNodeDetail.info.group" class="d-row">
              <span class="d-label">Group</span><span class="d-val">{{ selectedNodeDetail.info.group }}</span>
            </div>
            <div v-if="selectedNodeDetail.info.cluster" class="d-row">
              <span class="d-label">{{ selectedNodeDetail.info.clusterAlias || 'Cluster' }}</span>
              <span class="d-val">{{ selectedNodeDetail.info.cluster }}</span>
            </div>
            <div class="d-row">
              <span class="d-label">Service</span><span class="d-val mono">{{ selectedNodeDetail.info.service }}</span>
            </div>
          </div>
          <div class="d-foot">
            <!-- Plain anchor (not RouterLink) so `target="_blank"` opens a
                 real new tab. We point at the layer's main service view,
                 which is the default landing for every active layer. -->
            <a
              :href="openDashboardHref"
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
/* Hover variant — same card, but read-only: centred above the cube and
   never absorbs pointer events (the click must reach the cube). */
.detail-card.hover {
  pointer-events: none;
  transform: translate(-50%, calc(-100% - 8px));
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
.detail-card .d-val.mono {
  font-family: var(--sw-mono, monospace);
  font-size: 11px;
  color: var(--sw-fg-2);
  word-break: break-all;
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
