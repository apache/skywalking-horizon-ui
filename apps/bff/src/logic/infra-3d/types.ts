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
 * at `apps/bff/src/bundled_templates/infra-3d/config.json`. Admin saves
 * shadow the bundled file via `Infra3dStore` (same file-backed pattern as
 * alarms / setup) — the resolved config the UI consumes is `store.load()`,
 * which returns the saved file when present, otherwise the bundled
 * defaults verbatim.
 *
 * Vocabulary:
 *   - level    — one of the four planes the operator sees stacked top↓bottom
 *                (apps / mesh / middleware / infra). Owns a label, a layer
 *                allow-list, and an additional per-level regex filter.
 *   - layer    — OAP layer key (GENERAL, MESH, K8S_SERVICE, …). Carries
 *                its render color and either a `topology` (server + client)
 *                metric pair OR a single `load` metric. Topology layers
 *                prefer server-side for the cube traffic ring, fall back
 *                to client-side; non-topology layers always use `load`.
 *   - filter   — two-tier: `filter.layer` global regex AND the per-level
 *                `layerFilter` regex (intersection). A layer is admitted
 *                to a level if it passes the global regex AND (matches
 *                the level's regex OR appears in the explicit `layers`
 *                list).
 *   - edges    — render styling for the three edge classes drawn on the
 *                map (hierarchy / cross-level call / intra-layer call).
 *
 * Schema versioning: there is none on the wire — admin saves are full-doc
 * replacements, structural drift is detected at load time and falls back
 * to bundled defaults (the operator sees a stale UI rather than a hard
 * 500). Bump intentionally if the shape ever changes incompatibly.
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
  /** Two metrics for layers whose template carries a topology widget.
   *  `server` is preferred for the cube traffic; `client` is the
   *  fallback when server data is empty. `client` may be omitted (e.g.
   *  `cilium_service` ships server-only). */
  topology?: {
    server?: InfraMqe;
    client?: InfraMqe;
  };
  /** Single metric for layers without a topology widget. Mutually
   *  exclusive with `topology` at the bundled layer; admin overrides
   *  may set either. If neither is present the cube renders without a
   *  traffic ring. */
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
  /** Per-level layer regex. Default `.*`. A layer is admitted to a
   *  level when it passes the global filter AND (matches this regex OR
   *  appears in `layers`). */
  layerFilter: string;
  /** Explicit allow-list of OAP layer keys (canonical upper-case form). */
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
