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
 * Shape of the 3D Infrastructure Map admin config. Bundled defaults live
 * at `apps/bff/src/bundled_templates/infra-3d/config.json`. The config is
 * a first-class template kind (`horizon.infra-3d.config`): admin edits are
 * published to OAP through the generic template-sync surface and win over
 * bundled at render, exactly like layer / overview dashboards.
 *
 * Vocabulary:
 *   - level    — one of the planes the operator sees stacked top↓bottom
 *                (apps / mesh / middleware / infra). Owns a label and an
 *                explicit layer allow-list — the only way to pin a layer.
 *   - layer    — OAP layer key (GENERAL, MESH, K8S_SERVICE, …). Carries
 *                its render color and a single traffic `metric`.
 *   - filter   — `filter.layer`, ONE global regex applied before levelling:
 *                a layer it excludes is off the map entirely. There is no
 *                per-level regex — pinning is via the explicit `layers` list,
 *                and anything unpinned falls to `unknownLayer.level`.
 *   - edges    — render styling carried for a future interaction layer;
 *                not rendered on the always-on map today.
 *
 * Schema versioning: there is none on the wire — saves are full-doc
 * replacements validated before they reach OAP (see validate.ts); a
 * remote row that's somehow invalid falls back to bundled at read.
 */

/** MQE entry — used for both topology-pair metrics and the single load
 *  metric. `label` and `unit` are the strings the UI renders next to the
 *  value; `mqe` is the OAP expression sent to `/api/dashboard/widget/exp`. */
export interface InfraMqe {
  mqe: string;
  label: string;
  unit: string;
}

export interface InfraLayerSpec {
  /** Render color for the cube + level tinting. Hex (`#rrggbb`) or any
   *  CSS color string accepted by Three.js (`new THREE.Color(str)`). */
  color: string;
  /** The cube's traffic ring is a single scalar, so each layer carries
   *  ONE metric. Absent ⇒ the cube renders without a ring. This is the
   *  canonical shape; new saves write only this. */
  metric?: InfraMqe;
  /** @deprecated Pre-single-metric shapes. The cube ring always resolves
   *  to one value (`server ?? client ?? load`), so these collapsed into
   *  `metric`. Still accepted on the wire so an older saved OAP row keeps
   *  rendering; the renderer prefers `metric`, then falls back to these. */
  topology?: {
    server?: InfraMqe;
    client?: InfraMqe;
  };
  /** @deprecated See `topology` — folded into `metric`. */
  load?: InfraMqe;
}

export interface InfraLevelSpec {
  /** Stable id used as the keyboard-nav anchor and the YAML key. */
  id: string;
  /** 0-based vertical order (0 = top plane). Resolved at render time so
   *  the admin can reshuffle by editing this number alone. */
  order: number;
  /** Operator-facing name for the level (rendered in the side panel). */
  label: string;
  /** Explicit allow-list of OAP layer keys (canonical upper-case form).
   *  The ONLY way a layer is pinned to a level — there is no per-level
   *  regex; layers no level claims fall to `unknownLayer.level`. */
  layers: string[];
}

/** A logic group inside a tier — several layers drawn as ONE colored
 *  block on `level`, but each member layer keeps its own cube colors and
 *  starts its own column run (members are row-aligned, never colour-mixed).
 *  Defined explicitly in the 3D-map config (managed on the config page),
 *  NOT inferred from a layer template's `group`. A grouped layer is
 *  placed on the group's `level`, overriding its own level resolution. */
export interface InfraGroupSpec {
  /** Stable kebab id (config key + side-panel key). */
  id: string;
  /** Operator-facing name (group block label + side-panel row). */
  label: string;
  /** Level (tier) id the group sits on. */
  level: string;
  /** Group block color (hex `#rrggbb` or any CSS/Three color string). */
  color: string;
  /** Icon stamped on the group block. One of the shared 3D icon names
   *  (see the UI icon catalog); `skywalking` renders the SkyWalking
   *  crescent brand mark. */
  icon: string;
  /** Member OAP layer keys (canonical upper-case). */
  layers: string[];
}

export interface InfraEdgeStyle {
  color: string;
  /** `solid` | `dashed` — passed through to the line renderer; anything
   *  else falls back to solid at render time. */
  style: 'solid' | 'dashed';
  /** True draws an arrow head at the target endpoint. Hierarchy edges
   *  are undirected; cross-level call edges are directed. */
  arrow: boolean;
}

export interface InfraPipelineLimits {
  /** Service-bundles per MQE batch in stage 5. Mirrors the existing
   *  landing / dashboard chunking constant (6) so the 3D map shares the
   *  same OAP back-pressure profile. */
  metricChunkSize: number;
  /** Max concurrent `getServicesTopology` calls in stage 3. */
  topologyConcurrency: number;
  /** Max concurrent `getLayerTemplate` calls in stage 2. */
  templateConcurrency: number;
}

export interface Infra3dConfig {
  filter: {
    /** Global layer regex applied before levelling. Default `.*`. */
    layer: string;
  };
  edges: {
    hierarchy: InfraEdgeStyle;
    crossLevelCall: InfraEdgeStyle;
    intraCall: InfraEdgeStyle;
  };
  pipeline: InfraPipelineLimits;
  /** Where to put OAP layers that don't appear in any level's explicit
   *  `layers` list and don't match any level's regex. The cube renders
   *  with a small `badge` chip so the admin notices. */
  unknownLayer: {
    level: string;
    badge: string;
  };
  levels: InfraLevelSpec[];
  /** Logic groups inside tiers (e.g. Self-Observability). Optional;
   *  defaults to empty. A layer listed in a group is clustered into the
   *  group's block on the group's level. */
  groups: InfraGroupSpec[];
  /** Per-layer overrides keyed by canonical upper-case OAP layer key.
   *  Unknown layers fall back to a neutral default at render time. */
  layers: Record<string, InfraLayerSpec>;
}

export const INFRA3D_CONFIG_VERSION = 1 as const;
