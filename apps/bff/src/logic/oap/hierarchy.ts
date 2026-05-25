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
 * Service-hierarchy fetcher — wraps OAP's `getServiceHierarchy` +
 * `listLayerLevels`, flattens the upper/lower relations into a per-layer
 * peer list, and caches the level table per OAP queryUrl for the BFF
 * process lifetime (the level mapping is immutable per deployment).
 *
 * Powers the per-layer service map's Smartscape overlay. NOT used by
 * the overview dashboard's topology widget — that view is intentionally
 * non-interactive and would fight the focus+context geometry.
 */

import type {
  FetchLike,
  HierarchyLayerGroup,
  HierarchyPeer,
  LayerLevel,
  ServiceHierarchyResponse,
} from '@skywalking-horizon-ui/api-client';
import type { HorizonConfig } from '../../config/schema.js';
import { buildOapOpts, graphqlPost } from '../../client/graphql.js';

const HIERARCHY_QUERY = /* GraphQL */ `
  query HorizonServiceHierarchy($serviceId: ID!, $layer: String!) {
    hierarchy: getServiceHierarchy(serviceId: $serviceId, layer: $layer) {
      relations {
        upperService { id name layer normal }
        lowerService { id name layer normal }
      }
    }
  }
`;

const LEVELS_QUERY = /* GraphQL */ `
  query HorizonLayerLevels {
    levels: listLayerLevels { layer level }
  }
`;

interface RawRelService {
  id: string;
  name: string;
  layer: string;
  normal: boolean;
}
interface RawHierarchyResp {
  hierarchy: {
    relations: Array<{
      upperService: RawRelService;
      lowerService: RawRelService;
    }>;
  };
}
interface RawLevelsResp {
  levels: LayerLevel[];
}

// Per-queryUrl process-lifetime cache. The level table doesn't change
// at OAP runtime; a new deployment recycles the BFF anyway. We still
// short-cache failures (60s) so a transient OAP outage recovers
// without forever returning stale-or-empty.
interface LevelEntry {
  levels: LayerLevel[] | null;
  fetchedAt: number;
  ok: boolean;
}
const levelsCache = new Map<string, LevelEntry>();
const LEVELS_FAIL_MS = 60_000;

/** Test-only — clear the level cache. */
export function _resetLevelsCache(): void {
  levelsCache.clear();
}

async function getLayerLevels(
  config: HorizonConfig,
  fetchImpl?: FetchLike,
): Promise<LayerLevel[]> {
  const key = config.oap.queryUrl;
  const hit = levelsCache.get(key);
  if (hit && hit.ok) return hit.levels ?? [];
  if (hit && !hit.ok && Date.now() - hit.fetchedAt < LEVELS_FAIL_MS) {
    return hit.levels ?? [];
  }
  try {
    const data = await graphqlPost<RawLevelsResp>(
      buildOapOpts(config, fetchImpl),
      LEVELS_QUERY,
    );
    const levels = (data.levels ?? []).slice().sort((a, b) => a.level - b.level);
    levelsCache.set(key, { levels, fetchedAt: Date.now(), ok: true });
    return levels;
  } catch {
    // Cache the failure briefly; downstream callers still get a usable
    // response (UI groups by layer name, just without canonical order).
    levelsCache.set(key, { levels: null, fetchedAt: Date.now(), ok: false });
    return [];
  }
}

/** Group peers by layer in `levels` order, with the focused service
 *  always appearing under its own layer as `role: 'self'`. */
function groupPeers(
  serviceId: string,
  focusLayer: string,
  raw: RawHierarchyResp['hierarchy']['relations'],
  levels: LayerLevel[],
): { groups: HierarchyLayerGroup[]; relationCount: number } {
  const byLayer = new Map<string, Map<string, HierarchyPeer>>();
  const ensure = (layer: string): Map<string, HierarchyPeer> => {
    let m = byLayer.get(layer);
    if (!m) {
      m = new Map();
      byLayer.set(layer, m);
    }
    return m;
  };

  // Self always appears, even if OAP returned no relations — we want the
  // focused service on its own layer ribbon as the anchor for connectors.
  // OAP doesn't echo `name` on the hierarchy response for the self id; the
  // UI already has the name from the topology query, so we just store the
  // id and let the UI substitute. Marking name === id is a safe fallback
  // when the UI hasn't pre-loaded it (e.g. deep-linked overlay).
  let selfName: string | null = null;
  let selfNormal = true;

  for (const r of raw) {
    const u = r.upperService;
    const l = r.lowerService;
    if (u.id === serviceId) {
      selfName = u.name;
      selfNormal = u.normal;
      // Counterparty is the lower service.
      ensure(l.layer).set(l.id, { id: l.id, name: l.name, normal: l.normal, role: 'lower' });
    } else if (l.id === serviceId) {
      selfName = l.name;
      selfNormal = l.normal;
      // Counterparty is the upper service.
      ensure(u.layer).set(u.id, { id: u.id, name: u.name, normal: u.normal, role: 'upper' });
    } else {
      // Neither side is the focused service — OAP shouldn't return
      // these but cope defensively by tagging both ends as siblings.
      // Sibling peers (both upper/lower link to OTHER services) are
      // a hierarchy-graph oddity; surfacing them as `lower` is the
      // least-misleading choice (still cross-layer, still navigable).
      ensure(u.layer).set(u.id, { id: u.id, name: u.name, normal: u.normal, role: 'lower' });
      ensure(l.layer).set(l.id, { id: l.id, name: l.name, normal: l.normal, role: 'lower' });
    }
  }

  // Inject self under its own layer.
  ensure(focusLayer).set(serviceId, {
    id: serviceId,
    name: selfName ?? serviceId,
    normal: selfNormal,
    role: 'self',
  });

  // Order layers by `level`; layers OAP didn't return a level for fall
  // to the end (alphabetical for stability).
  const levelOf = new Map(levels.map((L) => [L.layer, L.level] as const));
  const orderedLayers = Array.from(byLayer.keys()).sort((a, b) => {
    const la = levelOf.get(a);
    const lb = levelOf.get(b);
    if (la !== undefined && lb !== undefined) return la - lb;
    if (la !== undefined) return -1;
    if (lb !== undefined) return 1;
    return a.localeCompare(b);
  });

  // Within a layer: self first, then upper-role peers, then lower-role
  // peers, each group alphabetical for stable rendering.
  const roleOrder: Record<HierarchyPeer['role'], number> = { self: 0, upper: 1, lower: 2 };
  const groups: HierarchyLayerGroup[] = orderedLayers.map((layer) => {
    const services = Array.from(byLayer.get(layer)!.values()).sort((a, b) => {
      const r = roleOrder[a.role] - roleOrder[b.role];
      return r !== 0 ? r : a.name.localeCompare(b.name);
    });
    return { layer, services };
  });

  // Final peer count = every non-self service across all layer groups.
  // This is the number the UI uses to decide "show expand chip?" — it
  // mirrors what the operator will actually see in the overlay (direct
  // peers + transitively-discovered cross-layer projections of those
  // peers), not the raw upper/lower relation count from OAP.
  const peerCount = groups.reduce(
    (sum, g) => sum + g.services.filter((s) => s.role !== 'self').length,
    0,
  );
  return { groups, relationCount: peerCount };
}

/**
 * Fetch the service hierarchy and shape it for the UI. Never throws —
 * an unreachable OAP yields `reachable: false` so the overlay can
 * degrade gracefully.
 */
export async function getServiceHierarchy(
  config: HorizonConfig,
  serviceId: string,
  layer: string,
  fetchImpl?: FetchLike,
): Promise<ServiceHierarchyResponse> {
  const opts = buildOapOpts(config, fetchImpl);
  const layerUpper = layer.toUpperCase();
  let levels: LayerLevel[] = [];
  try {
    levels = await getLayerLevels(config, fetchImpl);
  } catch {
    // Non-fatal — proceed with empty level table, peers still group.
  }
  try {
    const data = await graphqlPost<RawHierarchyResp>(opts, HIERARCHY_QUERY, {
      serviceId,
      layer: layerUpper,
    });
    const { groups, relationCount } = groupPeers(
      serviceId,
      layerUpper,
      data.hierarchy?.relations ?? [],
      levels,
    );
    return {
      reachable: true,
      layer: layerUpper,
      serviceId,
      levels,
      relations: relationCount,
      peers: groups,
    };
  } catch (err) {
    return {
      reachable: false,
      layer: layerUpper,
      serviceId,
      levels,
      relations: 0,
      peers: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
