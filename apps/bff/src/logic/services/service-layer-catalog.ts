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
 * **Server-global** service-by-layer index. The one place that issues
 * `listLayers` + the aliased `listServices(layer)` fan-out, with a 60s
 * TTL and single-flight dedup. Every BFF surface that needs the
 * service ↔ layer mapping — the sidebar menu's per-layer counts, the
 * alarms tagger, future consumers — reads from here so they all see the
 * same snapshot and OAP gets at most one fan-out per minute regardless
 * of how many routes are polling.
 *
 * The cached snapshot exposes three views:
 *
 *   - `layers`  — every layer key OAP's `listLayers` returned, RAW (not
 *     alias-collapsed; consumers canonicalize where it matters).
 *   - `byLayer` — `Map<layer, ServiceRow[]>` for count / first-normal /
 *     full roster needs.
 *   - `byName`  — `Map<lower-cased service name, layer>` for the
 *     reverse lookup the alarms tagger needs (name → layer). Last-wins
 *     when the same name appears under multiple layers; operators
 *     shouldn't reuse names cross-layer, but if they do the tag is
 *     best-effort.
 *
 * Soft-fails to an empty snapshot when OAP is unreachable, so callers
 * never break — the sidebar simply renders without counts.
 */

import { buildOapOpts, graphqlPost } from '../../client/graphql.js';
import type { ConfigSource } from '../../config/loader.js';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { logger } from '../../logger.js';

export interface ServiceRow {
  id: string;
  name: string;
  /** Per-layer `normal` flag from `listServices` — drives MQE entity
   *  scope (`{ normal: true|false }`) without a second roundtrip. */
  normal: boolean | null;
  /** OAP `Service.group` — the `<group>::` prefix (empty string when the
   *  service has no group). Drives the per-group menu split + the
   *  `?group=` service filter. */
  group: string;
}

export interface ServiceCatalog {
  layers: string[];
  byLayer: Map<string, ServiceRow[]>;
  byName: Map<string, string>;
}

export interface ServiceLayerCatalogDeps {
  config: ConfigSource;
  fetch?: FetchLike;
}

const LAYERS_QUERY = /* GraphQL */ `
  query HorizonServiceCatalogLayers {
    layers: listLayers
  }
`;

interface LayersRaw {
  layers: string[];
}

export class ServiceLayerCatalog {
  private cached: ServiceCatalog | null = null;
  private lastFetchAt = 0;
  private inflight: Promise<ServiceCatalog> | null = null;
  /** ms */
  private readonly ttl = 60_000;

  constructor(private readonly deps: ServiceLayerCatalogDeps) {}

  async get(): Promise<ServiceCatalog> {
    const now = Date.now();
    if (this.cached && now - this.lastFetchAt < this.ttl) return this.cached;
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh()
      .then((r) => {
        this.cached = r;
        this.lastFetchAt = Date.now();
        return r;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** Force a refresh on the next `get()`. Used when something just
   *  mutated the layer / alarms config and the existing snapshot is
   *  stale (e.g. a layer key was added to the alarms layer list). */
  invalidate(): void {
    this.cached = null;
    this.lastFetchAt = 0;
  }

  private async refresh(): Promise<ServiceCatalog> {
    const cfg = this.deps.config.current;
    const opts = buildOapOpts(cfg, this.deps.fetch);
    let layers: string[];
    try {
      const got = await graphqlPost<LayersRaw>(opts, LAYERS_QUERY);
      layers = Array.isArray(got.layers) ? got.layers : [];
    } catch (err) {
      logger.warn({ err }, 'service-layer-catalog: listLayers failed');
      return { layers: [], byLayer: new Map(), byName: new Map() };
    }
    if (layers.length === 0) {
      return { layers, byLayer: new Map(), byName: new Map() };
    }
    // One aliased GraphQL call instead of N separate roundtrips —
    // a single TCP/TLS handshake amortises across every layer.
    const aliased = layers
      .map((l, i) => `_${i}: listServices(layer: ${JSON.stringify(l)}) { id name normal group }`)
      .join('\n');
    const query = `query HorizonServiceCatalogServices { ${aliased} }`;
    try {
      const data = await graphqlPost<
        Record<string, Array<{ id: string; name: string; normal?: boolean | null; group?: string | null }>>
      >(opts, query);
      const byLayer = new Map<string, ServiceRow[]>();
      const byName = new Map<string, string>();
      layers.forEach((layer, i) => {
        const rows = (data[`_${i}`] ?? []).map<ServiceRow>((r) => ({
          id: r.id,
          name: r.name,
          normal: r.normal === true ? true : r.normal === false ? false : null,
          group: r.group ?? '',
        }));
        byLayer.set(layer, rows);
        for (const r of rows) if (r.name) byName.set(r.name.toLowerCase(), layer);
      });
      return { layers, byLayer, byName };
    } catch (err) {
      logger.warn({ err }, 'service-layer-catalog: listServices fan-out failed');
      return { layers, byLayer: new Map(), byName: new Map() };
    }
  }
}

// Process-global singleton. The first caller wins the dep injection;
// subsequent calls return the same instance regardless of the deps
// argument. Tests that need a fresh instance can `resetServiceLayerCatalog()`.
let inst: ServiceLayerCatalog | null = null;
export function serviceLayerCatalog(deps: ServiceLayerCatalogDeps): ServiceLayerCatalog {
  if (!inst) inst = new ServiceLayerCatalog(deps);
  return inst;
}
export function resetServiceLayerCatalog(): void {
  inst = null;
}
