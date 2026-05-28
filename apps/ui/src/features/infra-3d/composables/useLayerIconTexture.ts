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
 * Bake per-layer icons (Istio sail, Kubernetes wheel, generic family
 * marks) to Three.js textures so they can be PRINTED onto the layer's
 * 3D backplate — visually behaving like a stamp on the colour swatch,
 * tilting with the plane as the camera rotates.
 *
 * Approach: build an inline SVG data URL with the icon's stroke paths
 * tinted in the layer's resolved colour, then load it via Three.js
 * `TextureLoader`. SVG is rasterised at texture resolution (1024 px on
 * the long edge) so the icon stays crisp at the camera's working
 * distances; smaller bake sizes alias the spokes badly.
 *
 * The icon path data is mirrored from `components/icons/Icon.vue` so
 * the sidebar / topbar and the 3D zone stamps stay visually identical
 * — change one set, change the other. Yes, that's duplication, but
 * the alternative (parsing the .vue file's template at runtime) is
 * far more fragile.
 */

import { LinearFilter, Texture, TextureLoader } from 'three';

/** Icon names this module knows how to bake. Subset of the sidebar's
 *  `IconName` — only entries used by `shell/icons.layerIcon`. */
export type LayerIconName =
  | 'mesh'
  | 'cluster'
  | 'sky'
  | 'web'
  | 'fn'
  | 'db'
  | 'cache'
  | 'topic'
  | 'flame'
  | 'svc';

/** SVG inner content per icon name. Mirrors `Icon.vue`. Authored as
 *  outline-only strokes that read at small texel sizes; fills are
 *  reserved for the hub of the K8s wheel (so it doesn't look hollow). */
const PATHS: Record<LayerIconName, string> = {
  // Istio — true two-sail composition rendered as FILLED gray
  // shapes (the only filled icon in the set). Matches the project's
  // mark: a tall right main sail, smaller left jib, narrow vertical
  // mast gap between them, and a trapezoidal hull below.
  mesh:
    '<polygon points="13,1 13,19 21.5,19" fill="#8a8f96" stroke="none" />' +
    '<polygon points="11,7 11,19 3,19" fill="#8a8f96" stroke="none" />' +
    '<polygon points="2.5,20 21.5,20 18.5,22.5 5.5,22.5" fill="#8a8f96" stroke="none" />',
  // Kubernetes — outer heptagon + 7 spokes converging to a centre hub.
  cluster:
    '<path d="M12 3 L19.6 7 L20.7 15.6 L15 21 L9 21 L3.3 15.6 L4.4 7 Z" />' +
    '<path d="M12 3 L12 9 M19.6 7 L14.5 10 M20.7 15.6 L14.5 13.5 M15 21 L13 13.5 M9 21 L11 13.5 M3.3 15.6 L9.5 13.5 M4.4 7 L9.5 10" />' +
    '<circle cx="12" cy="12" r="2.4" />',
  // SkyWalking-flavoured "sky" mark — a stylised "S"-curve arrow.
  sky:
    '<path d="M5 8 C 8 6, 11 6, 14 9 S 19 14, 21 12" />' +
    '<path d="M3 14 C 6 16, 9 16, 12 13 S 17 8, 19 10" />',
  // Browser / RUM / mini-program — globe-style grid.
  web:
    '<circle cx="12" cy="12" r="9" />' +
    '<path d="M3 12h18 M12 3a14 14 0 010 18 M12 3a14 14 0 000 18" />',
  // FaaS — small folded-document mark.
  fn:
    '<path d="M6 4h8l4 4v12H6z" />' +
    '<path d="M14 4v4h4" />',
  // Database — stacked cylinders.
  db:
    '<ellipse cx="12" cy="5" rx="8" ry="3" />' +
    '<path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5 M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />',
  // Cache — clock-face dial reading "cached".
  cache:
    '<circle cx="12" cy="12" r="9" />' +
    '<path d="M12 7v5l3 2" />',
  // Topic / MQ — stacked horizontal tubes.
  topic:
    '<rect x="3" y="5" width="18" height="4" rx="1.5" />' +
    '<rect x="3" y="11" width="18" height="4" rx="1.5" />' +
    '<rect x="3" y="17" width="14" height="3" rx="1.2" />',
  // Self-observability / agent — flame.
  flame:
    '<path d="M12 3 C 14 7, 17 8, 17 13 a5 5 0 1 1 -10 0 c 0 -3 2 -5 5 -10 Z" />' +
    '<path d="M12 13 a2.5 2.5 0 1 0 2.5 2.5" />',
  // Generic service.
  svc:
    '<rect x="3" y="4" width="18" height="6" rx="1.5" />' +
    '<rect x="3" y="14" width="18" height="6" rx="1.5" />' +
    '<circle cx="7" cy="7" r="1" fill="currentColor" stroke="none" />' +
    '<circle cx="7" cy="17" r="1" fill="currentColor" stroke="none" />',
};

const loader = new TextureLoader();
const cache = new Map<string, Texture>();

/** Build (or fetch from cache) a Three.js texture of `name` stroked in
 *  `hex`. The texture rasterises a 24×24 SVG scaled to 1024×1024 so
 *  it stays crisp under camera zoom — operators land on the map with
 *  the icon as a clear brand cue, not a fuzzy smear. */
export function getLayerIconTexture(name: LayerIconName, hex: string): Texture {
  const key = `${name}|${hex}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const svg = buildSvg(name, hex);
  // `loadAsync` would be cleaner async-wise, but the sync `load` call
  // returns a Texture immediately; the bitmap arrives over the next
  // event-loop tick and triggers `needsUpdate` internally. The first
  // frame after mount renders blank for ~16ms; subsequent frames have
  // the icon. Acceptable for chrome.
  const tex = loader.load(svg);
  // Crisp downsampling for the bake-time SVG → texel mapping.
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.anisotropy = 4;
  cache.set(key, tex);
  return tex;
}

/** Dispose every cached texture. Call from the Scene's `onUnmounted`
 *  so navigating away frees GPU resources. */
export function disposeLayerIconTextures(): void {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}

function buildSvg(name: LayerIconName, hex: string): string {
  const inner = PATHS[name] ?? PATHS.svc;
  // 1024 long-edge SVG ensures crisp rasterisation when the browser's
  // <img> loader hands it off to the GL texture. `stroke="${hex}"` is
  // inserted unencoded — hex strings are URL-safe (#rrggbb), so the
  // base64 encoding below is purely for the data URI.
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1024" height="1024"' +
    ` fill="none" stroke="${hex}" stroke-width="1.6"` +
    ' stroke-linecap="round" stroke-linejoin="round">' +
    inner +
    '</svg>';
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
