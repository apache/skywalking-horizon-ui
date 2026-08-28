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
  /**
   * The read that produced this failed.
   *
   * An empty catalog is indistinguishable from a catalog OAP could not be
   * read for — and the second one, served as though it were the first, told
   * the operator their layer has no services. After the cache TTL expired
   * that is what an ordinary refresh during an outage did: it replaced the
   * service picker with an empty list, and nothing downstream could tell,
   * because the answer looked successful.
   */
  unreachable?: boolean;
  /**
   * The rows are a PREVIOUS good read, kept because the latest one failed.
   *
   * Distinct from `unreachable`, which describes the latest attempt: together
   * they say "these services are real but may have moved on". A consumer that
   * renders counts should prefer stale rows to none — publishing zero is a
   * statement about the operator's system made from a failure to read it — but
   * anything that reports health must still treat the read as failed.
   */
  stale?: boolean;
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

  /** How long a FAILED read is allowed to suppress the next attempt. Short,
   *  because the point is only to stop a hard outage re-probing on every
   *  request — not to hold an unreadable answer for a full TTL. */
  private readonly failureTtl = 5_000;

  async get(): Promise<ServiceCatalog> {
    const now = Date.now();
    // A failed read expires on the short clock, so recovery is seconds away
    // rather than a minute. Caching an empty `unreachable` snapshot for the
    // full TTL meant a two-second storage hiccup blanked the sidebar's service
    // counts and collapsed group navigation until it expired, long after OAP
    // itself was healthy again.
    const ttl = this.cached?.unreachable ? this.failureTtl : this.ttl;
    if (this.cached && now - this.lastFetchAt < ttl) return this.cached;
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh()
      .then((r) => {
        // An unreadable answer never REPLACES a roster we already had. The
        // rows are the operator's own services, merely stale; discarding them
        // publishes a service count of zero, which every consumer that does
        // not check `unreachable` — the sidebar among them — renders as fact.
        // Keyed on whether the RETAINED rows are worth keeping, not on whether
        // the previous read succeeded. Asking `!this.cached.unreachable` made
        // the retention last exactly one failure: the first marked the snapshot
        // unreachable, and the second then saw that mark and overwrote the rows
        // with the empty answer — so a sustained outage still collapsed the
        // sidebar, only a beat later than before.
        const keep = r.unreachable && this.cached !== null && this.cached.byName.size > 0;
        this.cached = keep
          ? { ...(this.cached as ServiceCatalog), unreachable: true, stale: true }
          : r;
        this.lastFetchAt = Date.now();
        return this.cached;
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
      return { layers: [], byLayer: new Map(), byName: new Map(), unreachable: true };
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
      return { layers, byLayer: new Map(), byName: new Map(), unreachable: true };
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
