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
 * Service-hierarchy wire shape — the BFF-side view of OAP's
 * `getServiceHierarchy` + `listLayerLevels`. Powers the Smartscape
 * focus+context+suggestions overlay on the per-layer service map.
 *
 * SkyWalking's hierarchy is **one hop**: a logical service projected
 * across multiple observation layers (e.g. an app seen at GENERAL via
 * the Java agent, at MESH as an Envoy sidecar, and at K8S_SERVICE as a
 * Kubernetes Service object). Instances / pods / processes are
 * children of the service — they are NOT additional hierarchy levels.
 *
 * The BFF flattens OAP's `upperService`/`lowerService` relations into a
 * single peer list per layer, tags the focused service with
 * `role: 'self'`, and merges in the canonical layer ordering from
 * `listLayerLevels` so the UI can render lanes without re-deriving the
 * order client-side.
 */

/** One layer's canonical hierarchy position. Lower `level` is closer to
 *  the request edge (e.g. browser RUM); higher `level` is closer to the
 *  infrastructure (e.g. Kubernetes / OS). The ordering is OAP-supplied
 *  via `listLayerLevels` and cached BFF-process-lifetime. */
export interface LayerLevel {
  layer: string;
  level: number;
}

/** One peer service in the hierarchy of the focused service.
 *  `self` is the focused service itself, included so the UI can place
 *  it on the layer ribbon alongside its peers. */
export type HierarchyPeerRole = 'upper' | 'lower' | 'self';

export interface HierarchyPeer {
  /** OAP service id. */
  id: string;
  /** Service name (no group prefix). */
  name: string;
  /** OAP's `normal` flag — `false` for virtual peers (databases, MQs,
   *  etc.). The UI may surface this as a "virtual" tag. */
  normal: boolean;
  /** Relation to the focused service. `upper` = request-near peer
   *  (closer to user / browser layer); `lower` = infra-near peer
   *  (closer to platform); `self` = the focused service itself. */
  role: HierarchyPeerRole;
}

/** Peers grouped by layer. Layers are returned in the order they appear
 *  in `levels`; layers with no peers (other than `self`) are omitted. */
export interface HierarchyLayerGroup {
  layer: string;
  /** Sorted: `self` first, then `upper` peers, then `lower` peers. */
  services: HierarchyPeer[];
}

/** Wire shape of `GET /api/layer/:key/service-hierarchy?service=<id>`.
 *  Never throws on an unreachable OAP — `reachable: false` + `error`
 *  carries the diagnostic so the overlay can degrade rather than
 *  hard-fail. `relations` is the raw peer count across layers (excluding
 *  `self`) — the UI uses it as a quick "show expand chip?" check. */
export interface ServiceHierarchyResponse {
  reachable: boolean;
  error?: string;
  /** Echoed inputs so cache keys + UI labels don't drift. */
  layer: string;
  serviceId: string;
  /** Canonical layer ordering (request-near → infra-near). Cached
   *  BFF-process-lifetime — OAP's level table is immutable per
   *  deployment. */
  levels: LayerLevel[];
  /** Peer count across all layers, excluding `self`. `0` means the
   *  focused service has no cross-layer projections — the UI hides the
   *  expand affordance. Counts everything that will actually render in
   *  the overlay (direct peers + their transitive cross-layer twins),
   *  not just OAP's direct upper/lower relation count. */
  relations: number;
  /** Peers grouped by layer in `levels` order. The focused service
   *  appears under its own layer with `role: 'self'`. */
  peers: HierarchyLayerGroup[];
}
