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

/**
 * Material + geometry factory for the 3D infra scene.
 *
 * Pure resource ownership — no Vue reactivity, no template refs. Every
 * geometry / material here is SHARED across all meshes of the same kind
 * and freed once by `dispose()` (called from the Scene's `onUnmounted`).
 * Colors are cached by resolved hex, NOT by tint, so an admin layer-color
 * override gets its own material while two layers with identical colors
 * share one. Cube colors are pulled toward a calmer pastel via
 * `mutedCubeColor`; the side-panel swatches keep the full tint.
 *
 * The cache maps (`zone/node/hover/iconStamp` materials, `clusterLabel`
 * bakes) grow lazily as layers/colors appear and are emptied on dispose;
 * the per-frame ripple opacity and flash opacity are driven directly on
 * the returned materials by the Scene's frame loop.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  DoubleSide,
  EdgesGeometry,
  LinearFilter,
  LineBasicMaterial,
  MeshBasicMaterial,
  MeshLambertMaterial,
  RingGeometry,
  SphereGeometry,
  SpriteMaterial,
  type Texture,
} from 'three';
import { layerIcon as layerIconByKey } from '@/shell/icons';
import {
  disposeLayerIconTextures,
  getLayerIconTexture,
  type LayerIconName,
} from './useLayerIconTexture';
import { colorForLayer } from './useInfra3dConfig';
import { readTintColor, type ZoneTint } from './useScenePlacement';

/** Resolve the per-layer icon glyph. Routed through the same helper
 *  the sidebar uses (`shell/icons.layerIcon`) so the two surfaces
 *  always agree — change the mapping in one place and both update.
 *  Narrowed to the subset the texture baker knows; unknown glyphs
 *  fall back to the generic service mark. */
const KNOWN_ICONS: ReadonlySet<LayerIconName> = new Set([
  'mesh', 'cluster', 'sky', 'skywalking', 'web', 'fn', 'db', 'cache', 'topic', 'flame', 'svc',
]);
function iconForLayer(layerKey: string): LayerIconName {
  const n = layerIconByKey(layerKey);
  return KNOWN_ICONS.has(n as LayerIconName) ? (n as LayerIconName) : 'svc';
}

// Tier "planes" are volumetric glass slabs, not flat sheets — a box of
// PLANE_THICKNESS whose TOP face sits at the plane's Y (where cubes
// rest). Centred half a thickness below the plane Y so the slab's top
// face is exactly where the cubes rest.
export const PLANE_THICKNESS = 0.5;

// Alarm ripple — RIPPLE_PHASES concentric red rings expand and fade on
// staggered phases. One shared material per phase (opacity animated by
// the Scene's frame loop); the per-ring scale is set on each mesh.
export const RIPPLE_PHASES = 3;
export const RIPPLE_PERIOD = 3.2; // seconds for a ring to travel fully out
export const RIPPLE_MIN_SCALE = 0.9;
export const RIPPLE_MAX_SCALE = 4.2;
export const RIPPLE_MAX_OPACITY = 0.5;

/** Base world height of a cluster label stamp. */
export const CLUSTER_LABEL_H = 0.66;

// Baked namespace labels (cached by text|colour). The canvas is sized to
// the TEXT (up to a wide cap) so the namespace isn't truncated; the plane
// then uses the frame width. Mirrors the icon-stamp baker.
function bakeClusterLabel(text: string, hex: string): { tex: CanvasTexture; aspect: number } | null {
  if (typeof document === 'undefined') return null;
  const H = 128, FONT = 84, MAXW = 2048, PAD = 18;
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) return null;
  const font = `700 ${FONT}px system-ui, -apple-system, sans-serif`;
  probe.font = font;
  let t = text;
  while (probe.measureText(t).width > MAXW - PAD * 2 && t.length > 1) t = `${t.slice(0, -2)}…`;
  const W = Math.max(Math.ceil(probe.measureText(t).width) + PAD * 2, 64);
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const cx = cv.getContext('2d');
  if (!cx) return null;
  cx.font = font;
  cx.fillStyle = hex;
  cx.textBaseline = 'middle';
  cx.textAlign = 'left';
  cx.fillText(t, PAD, H / 2 + 2);
  const tex = new CanvasTexture(cv);
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.anisotropy = 4;
  return { tex, aspect: W / H };
}

// Soft red radial halo billboarded over each alarmed cube — the "beacon"
// glow. Built from a canvas radial-gradient texture so it's a cheap
// sprite, additively blended for a luminous bloom.
function makeGlowTexture(): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const size = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const cx = cv.getContext('2d');
  if (!cx) return null;
  const g = cx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,120,110,0.95)');
  g.addColorStop(0.35, 'rgba(239,68,68,0.55)');
  g.addColorStop(1, 'rgba(239,68,68,0)');
  cx.fillStyle = g;
  cx.fillRect(0, 0, size, size);
  return new CanvasTexture(cv);
}

export interface SceneMaterials {
  // Shared geometries.
  nodeGeometry: BoxGeometry;
  packetGeometry: SphereGeometry;
  crossArrowGeometry: ConeGeometry;
  rippleGeometry: RingGeometry;
  cubeEdgesGeometry: EdgesGeometry;
  // Static materials.
  planeMaterial: MeshBasicMaterial;
  planeEdgeMaterial: LineBasicMaterial;
  selectedMat: MeshLambertMaterial;
  alarmMat: MeshLambertMaterial;
  callEdgeMat: MeshBasicMaterial;
  callPacketMat: MeshBasicMaterial;
  crossEdgeMat: MeshBasicMaterial;
  crossArrowMat: MeshLambertMaterial;
  crossPacketMat: MeshBasicMaterial;
  hierarchyMat: MeshBasicMaterial;
  ghostMat: MeshBasicMaterial;
  cubeEdgeMat: LineBasicMaterial;
  glowMat: SpriteMaterial;
  flashMat: MeshBasicMaterial;
  clusterFrameMat: LineBasicMaterial;
  rippleMats: MeshBasicMaterial[];
  // Color resolution + cached factories.
  resolveLayerColor: (layerKey: string, tintFallback: ZoneTint) => string;
  zoneMaterial: (hex: string) => MeshBasicMaterial;
  nodeMaterial: (hex: string) => MeshLambertMaterial;
  hoverMaterial: (hex: string) => MeshLambertMaterial;
  iconStampMaterial: (layerKey: string, tint: ZoneTint) => MeshBasicMaterial;
  groupStampMaterial: (icon: string, hex: string) => MeshBasicMaterial;
  clusterLabel: (text: string, hex: string) => { mat: MeshBasicMaterial; aspect: number };
  dispose: () => void;
}

/**
 * Build the scene's shared material/geometry set. Called once at Scene
 * setup; the returned `dispose()` frees every GL resource — call it from
 * the Scene's `onUnmounted`. Per-batch geometries (tubes, cluster frames)
 * are owned by `useSceneEdges` / the Scene template, not here.
 */
export function useSceneMaterials(): SceneMaterials {
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

  // ONE node geometry shared by every cube — hover / select only change
  // the material, never the geometry (swapping geometry mid-pointer-event
  // rebuilt the raycaster's bbox and made clicks miss).
  const nodeGeometry = new BoxGeometry(1.3, 1.0, 1.3);
  const packetGeometry = new SphereGeometry(0.18, 12, 8);
  const crossArrowGeometry = new ConeGeometry(0.18, 0.5, 10);
  const rippleGeometry = new RingGeometry(0.6, 0.78, 44);
  const cubeEdgesGeometry = new EdgesGeometry(nodeGeometry);

  // Transparent slate glass tier slab; depthWrite off so cubes/zones
  // blend through cleanly. Backface culling off so the slab looks solid.
  const planeMaterial = new MeshBasicMaterial({
    color: new Color('#151a23'),
    transparent: true,
    opacity: 0.4,
    side: DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const planeEdgeMaterial = new LineBasicMaterial({
    color: new Color('#3a4658'),
    transparent: true,
    opacity: 0.8,
  });
  const selectedMat = new MeshLambertMaterial({ color: 0xf97316, emissive: 0xf97316, emissiveIntensity: 0.85 });
  const alarmMat = new MeshLambertMaterial({ color: 0xef4444, emissive: 0xef4444, emissiveIntensity: 0.6 });
  const callEdgeMat = new MeshBasicMaterial({
    color: new Color('#7dd3fc'),
    transparent: true,
    opacity: 0.75,
  });
  const callPacketMat = new MeshBasicMaterial({ color: new Color('#e0f2fe') });
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
  const crossPacketMat = new MeshBasicMaterial({ color: new Color('#ffd9b0') });
  const hierarchyMat = new MeshBasicMaterial({
    color: new Color('#8b95a3'),
    transparent: true,
    opacity: 0.7,
  });
  const ghostMat = new MeshBasicMaterial({
    color: new Color('#1b2433'),
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  });
  const cubeEdgeMat = new LineBasicMaterial({
    color: new Color('#7d8ba3'),
    transparent: true,
    opacity: 0.9,
  });
  const glowTexture = makeGlowTexture();
  const glowMat = new SpriteMaterial({
    map: glowTexture ?? undefined,
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const flashMat = new MeshBasicMaterial({
    color: new Color('#cfe3ff'),
    transparent: true,
    opacity: 0,
    side: DoubleSide,
    depthWrite: false,
  });
  const clusterFrameMat = new LineBasicMaterial({
    color: new Color('#5a6b86'),
    transparent: true,
    opacity: 0.85,
  });
  const rippleMats = Array.from(
    { length: RIPPLE_PHASES },
    () =>
      new MeshBasicMaterial({
        color: 0xef4444,
        transparent: true,
        opacity: 0,
        side: DoubleSide,
        depthWrite: false,
      }),
  );

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

  // Cubes read too saturated against the dark scene; pull toward a calmer
  // pastel (drop saturation, lift lightness) so the hue stays recognizable
  // next to the full-tint side-panel swatches. Cloned before mutating; the
  // shared cached Color must not be touched.
  const _hsl = { h: 0, s: 0, l: 0 };
  function mutedCubeColor(hex: string): Color {
    const c = colorByHex(hex).clone();
    c.getHSL(_hsl);
    c.setHSL(_hsl.h, _hsl.s * 0.5, Math.min(1, _hsl.l * 1.1 + 0.06));
    return c;
  }

  const nodeMaterials = new Map<string, MeshLambertMaterial>();
  function nodeMaterial(hex: string): MeshLambertMaterial {
    let m = nodeMaterials.get(hex);
    if (!m) {
      const base = mutedCubeColor(hex);
      // Soft self-glow so the pastel reads luminous, not matte-flat.
      m = new MeshLambertMaterial({ color: base, emissive: base.clone().multiplyScalar(0.22) });
      nodeMaterials.set(hex, m);
    }
    return m;
  }
  // Hover is a brightened version of the layer color, NOT pure white —
  // pure white loses the layer association. Lerp only 25% toward white so
  // the cube keeps its tint and stays distinct from the orange selected.
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

  // Layer/group icon stamps — the icon BAKED into a texture (SVG of the
  // project mark in the layer colour) pasted onto a small PlaneGeometry.
  // Cached by `(icon-name, hex)` so two zones with the same mark share one.
  const iconStampMaterials = new Map<string, MeshBasicMaterial>();
  function stampMaterial(name: LayerIconName, hex: string): MeshBasicMaterial {
    const key = `${name}|${hex}`;
    let m = iconStampMaterials.get(key);
    if (!m) {
      const tex: Texture = getLayerIconTexture(name, hex);
      m = new MeshBasicMaterial({
        map: tex,
        transparent: true,
        // Disable depth write so the stamp doesn't fight with the colored
        // zone plate below it for z-buffer pixels.
        depthWrite: false,
        // Slight transparency keeps the stamp from over-asserting — it's a
        // brand cue, not the main signal.
        opacity: 0.85,
      });
      iconStampMaterials.set(key, m);
    }
    return m;
  }
  function iconStampMaterial(layerKey: string, tint: ZoneTint): MeshBasicMaterial {
    return stampMaterial(iconForLayer(layerKey), resolveLayerColor(layerKey, tint));
  }
  /** Stamp for a logic group — its configured icon in the group color.
   *  Unknown icon names fall back to the generic service glyph. */
  function groupStampMaterial(icon: string, hex: string): MeshBasicMaterial {
    const name = KNOWN_ICONS.has(icon as LayerIconName) ? (icon as LayerIconName) : 'svc';
    return stampMaterial(name, hex);
  }

  const clusterLabels = new Map<string, { mat: MeshBasicMaterial; aspect: number }>();
  function clusterLabel(text: string, hex: string): { mat: MeshBasicMaterial; aspect: number } {
    const key = `${text}|${hex}`;
    let e = clusterLabels.get(key);
    if (!e) {
      const baked = bakeClusterLabel(text, hex);
      const mat = new MeshBasicMaterial({ map: baked?.tex ?? undefined, transparent: true, depthWrite: false, opacity: 0.95 });
      e = { mat, aspect: baked?.aspect ?? 4 };
      clusterLabels.set(key, e);
    }
    return e;
  }

  function dispose(): void {
    nodeGeometry.dispose();
    packetGeometry.dispose();
    crossArrowGeometry.dispose();
    rippleGeometry.dispose();
    cubeEdgesGeometry.dispose();
    planeMaterial.dispose();
    planeEdgeMaterial.dispose();
    for (const m of zoneMaterials.values()) m.dispose();
    for (const m of nodeMaterials.values()) m.dispose();
    for (const m of hoverMaterials.values()) m.dispose();
    selectedMat.dispose();
    alarmMat.dispose();
    callEdgeMat.dispose();
    callPacketMat.dispose();
    crossPacketMat.dispose();
    flashMat.dispose();
    crossEdgeMat.dispose();
    crossArrowMat.dispose();
    hierarchyMat.dispose();
    for (const m of rippleMats) m.dispose();
    ghostMat.dispose();
    cubeEdgeMat.dispose();
    glowTexture?.dispose();
    glowMat.dispose();
    for (const m of iconStampMaterials.values()) m.dispose();
    disposeLayerIconTextures();
    clusterFrameMat.dispose();
    for (const e of clusterLabels.values()) { e.mat.map?.dispose(); e.mat.dispose(); }
  }

  return {
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
    resolveLayerColor,
    zoneMaterial,
    nodeMaterial,
    hoverMaterial,
    iconStampMaterial,
    groupStampMaterial,
    clusterLabel,
    dispose,
  };
}
