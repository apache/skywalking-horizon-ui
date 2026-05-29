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
  | 'skywalking'
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
  // GENERAL application-services layer mark — the filled "sky" swoosh.
  // Mirrors Icon.vue's `sky` EXACTLY (currentColor body at .95 + a faint
  // white highlight at .22) so the layer's 3D map stamp matches the
  // sidebar-menu icon for the same layer.
  sky:
    '<path fill="currentColor" stroke="none" opacity="0.95" d="M3 14c4-3 8-3 12-1 3 1.4 5 .5 6-1-1 5-4 8-9 8-4 0-7-2-9-6z" />' +
    '<path fill="#fff" stroke="none" opacity="0.22" d="M5 10c3-2 7-2 11 0 3 1.3 5 .6 6-1-1 3.6-4 6-8 6-4 0-7-1.6-9-5z" />',
  // SkyWalking brand mark — the "Sw" lettermark + crescent moon from the
  // project icon (logo.svg). Both paths FILLED in the layer/group colour
  // via `fill="currentColor"` (resolved by the `color` attr buildSvg sets
  // on the root <svg>). The logo's viewBox is 3450×1823, so the wrapping
  // transform scales it onto the 24-wide stamp and centres the (wide)
  // mark vertically; the inner transforms are the logo's own (the group
  // y-shift and the moon's rotate(-183) tilt). Baker-only (not in
  // Icon.vue) — used solely as a logic-group brand glyph via the 3D-map
  // config `icon`.
  skywalking:
    '<g transform="translate(0 6) scale(0.006957)" fill="currentColor" stroke="none">' +
    '<g transform="translate(0 -29)">' +
    '<path d="M1050.01772,1394.31899 C1050.01772,1615.24051 912.21519,1851.47342 474.746835,1851.47342 C310.696203,1851.47342 192.579747,1836.16203 87.5873418,1812.10127 C65.7139241,1807.72658 46.0278481,1792.41519 46.0278481,1768.35443 L46.0278481,1610.86582 C46.0278481,1586.80506 65.7139241,1569.30633 87.5873418,1569.30633 L91.9620253,1569.30633 C179.455696,1580.24304 398.189873,1591.17975 479.121519,1591.17975 C673.794937,1591.17975 732.853165,1521.18481 732.853165,1394.31899 C732.853165,1309.01266 691.293671,1265.26582 546.929114,1179.95949 L258.2,1007.15949 C54.7772152,886.855696 0.0936708861,759.989873 0.0936708861,606.875949 C0.0936708861,366.268354 140.083544,191.281013 546.929114,191.281013 C691.293671,191.281013 892.529114,213.15443 966.898734,230.653165 C988.772152,235.027848 1006.27089,250.339241 1006.27089,272.212658 L1006.27089,434.075949 C1006.27089,455.949367 990.959494,473.448101 969.086076,473.448101 L964.711392,473.448101 C820.346835,460.324051 675.982278,451.574684 533.805063,451.574684 C371.941772,451.574684 304.134177,508.44557 304.134177,606.875949 C304.134177,679.058228 341.318987,722.805063 483.496203,801.549367 L745.977215,948.101266 C986.58481,1081.52911 1050.01772,1221.51899 1050.01772,1394.31899 Z M2852.63038,644.060759 C2852.63038,646.248101 2852.63038,648.435443 2852.63038,650.622785 L2653.58228,1656.8 C2627.33418,1788.04051 2592.33671,1840.53671 2458.90886,1840.53671 L2399.85063,1840.53671 C2281.73418,1840.53671 2220.48861,1783.66582 2192.05316,1669.92405 L2019.25316,1000.59747 C2017.06582,991.848101 2017.06582,989.660759 2012.69114,989.660759 C2008.31646,989.660759 2008.31646,991.848101 2006.12911,1000.59747 L1833.32911,1669.92405 C1804.89367,1783.66582 1743.6481,1840.53671 1625.53165,1840.53671 L1566.47342,1840.53671 C1433.04557,1840.53671 1398.0481,1788.04051 1371.8,1656.8 L1172.7519,650.622785 C1172.7519,648.435443 1172.7519,646.248101 1172.7519,644.060759 C1172.7519,620 1192.43797,600.313924 1216.49873,600.313924 L1428.67089,600.313924 C1450.5443,600.313924 1465.8557,620 1468.04304,639.686076 L1605.84557,1564.93165 C1608.03291,1584.61772 1612.40759,1595.55443 1616.78228,1595.55443 C1621.15696,1595.55443 1627.71899,1586.80506 1632.09367,1564.93165 L1813.64304,829.98481 C1835.51646,744.678481 1861.76456,735.929114 1936.13418,735.929114 L2089.2481,735.929114 C2163.61772,735.929114 2189.86582,744.678481 2211.73924,829.98481 L2393.28861,1564.93165 C2397.66329,1586.80506 2404.22532,1595.55443 2408.6,1595.55443 C2412.97468,1595.55443 2417.34937,1584.61772 2419.53671,1564.93165 L2557.33924,639.686076 C2559.52658,620 2574.83797,600.313924 2596.71139,600.313924 L2808.88354,600.313924 C2832.9443,600.313924 2852.63038,620 2852.63038,644.060759 Z" />' +
    '<g transform="translate(2932.164557 596) rotate(-183) translate(-2932.164557 -596) translate(2415.708861 26.379747)"><path d="M1025.31646,927.371333 C992.796119,932.841177 959.292071,935.576099 925.845888,935.576099 C590.40035,935.576099 318.259524,661.909325 318.259524,324.582876 C318.259524,209.134252 351.705707,96.3623597 412.290747,0 C171.802278,71.8062511 0,293.684076 0,557.342199 C0,878.317305 259.46831,1139.24051 578.65368,1139.24051 C753.17563,1139.24051 916.818891,1059.22949 1025.31646,927.371333 Z" /></g>' +
    '</g></g>',
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
  // <img> loader hands it off to the GL texture. `stroke`/`color` are
  // inserted unencoded — hex strings are URL-safe (#rrggbb), so the
  // base64 encoding below is purely for the data URI. `color="${hex}"`
  // makes `fill="currentColor"` paths (the SkyWalking crescent, the svc
  // dots) fill in the layer colour rather than the default black.
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1024" height="1024"' +
    ` fill="none" stroke="${hex}" color="${hex}" stroke-width="1.6"` +
    ' stroke-linecap="round" stroke-linejoin="round">' +
    inner +
    '</svg>';
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
