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
 * Who a service is, for an access decision: its exact OAP id, name, `normal`
 * flag, group and EVERY layer it reports into.
 *
 * Built from the shared service catalog, indexed by exact id — never by the
 * catalog's lower-cased, last-wins name map, which is a display aid. A miss
 * (a service registered since the last refresh, or a catalog that could not
 * be read) asks OAP for that one service; a service OAP does not know is
 * `null`, and the caller refuses.
 */

import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { buildOapOpts, graphqlPost } from '../../client/graphql.js';
import type { ConfigSource } from '../../config/loader.js';
import { canonicalLayerKey } from '../templates/identity.js';
import type { ServiceCatalog, ServiceLayerCatalog } from './service-layer-catalog.js';

/** OAP could not be asked. Not the same as "OAP says there is no such
 *  service": an access decision may take the second as an answer, never the
 *  first. */
export class ServiceLookupUnavailable extends Error {
  constructor(cause: unknown) {
    super(`service lookup unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'ServiceLookupUnavailable';
  }
}

export interface ResolvedService {
  id: string;
  name: string;
  normal: boolean | null;
  group: string;
  /** Canonical layer keys. */
  layers: string[];
}

export interface ServiceIdentityDeps {
  config: ConfigSource;
  fetch?: FetchLike;
  catalog: ServiceLayerCatalog;
}

export interface Index {
  byId: Map<string, ResolvedService>;
  /** Exact name → every service carrying it (normal and conjectural). */
  byName: Map<string, ResolvedService[]>;
}

const indexes = new WeakMap<ServiceCatalog, Index>();

/** How long rows kept through failed refreshes still decide access. Past it
 *  they are re-checked with OAP, so a service that has since moved into a layer
 *  the caller cannot read is not granted on old membership. */
const RETAINED_TRUST_MS = 5 * 60_000;

function trusted(snapshot: ServiceCatalog): boolean {
  if (!snapshot.stale && !snapshot.unreachable) return true;
  return snapshot.readAt !== undefined && Date.now() - snapshot.readAt < RETAINED_TRUST_MS;
}

/** The catalog indexed by exact service id and exact name, each service
 *  carrying every layer it reports into. */
export function catalogIndex(snapshot: ServiceCatalog): Index {
  return indexOf(snapshot);
}

function indexOf(snapshot: ServiceCatalog): Index {
  const cached = indexes.get(snapshot);
  if (cached) return cached;
  const byId = new Map<string, ResolvedService>();
  for (const [layer, rows] of snapshot.byLayer) {
    const key = canonicalLayerKey(layer);
    for (const r of rows) {
      const s = byId.get(r.id);
      if (s) {
        if (!s.layers.includes(key)) s.layers.push(key);
      } else {
        byId.set(r.id, { id: r.id, name: r.name, normal: r.normal, group: r.group, layers: [key] });
      }
    }
  }
  const byName = new Map<string, ResolvedService[]>();
  for (const s of byId.values()) {
    const list = byName.get(s.name);
    if (list) list.push(s);
    else byName.set(s.name, [s]);
  }
  const idx = { byId, byName };
  indexes.set(snapshot, idx);
  return idx;
}

/** OAP's own blank test: Java's `trim()` drops every character up to U+0020
 *  and nothing else, so a name of U+00A0 is a real name to OAP. */
// eslint-disable-next-line no-control-regex
const OAP_BLANK = /^[\u0000-\u0020]*$/;

export function isBlankToOap(name: string): boolean {
  return OAP_BLANK.test(name);
}

/**
 * The name to put in an MQE entity for a roster row. OAP lists its blank-named
 * service with an empty name, but an MQE entity whose `serviceName` is empty
 * reads as NO service — a `top_n` then ranks the whole deployment — while OAP
 * keys that service's data under `_blank`.
 */
export function entityServiceName(name: string): string {
  return isBlankToOap(name) ? '_blank' : name;
}

/** OAP's service id: base64 of the UTF-8 name, `.`, then 1 (normal) or 0. A
 *  blank name is filed under `_blank`, as OAP's own id builder does. */
export function serviceIdOf(name: string, normal: boolean): string {
  return `${Buffer.from(entityServiceName(name), 'utf8').toString('base64')}.${normal ? 1 : 0}`;
}

/** Instance and endpoint ids are `<serviceId>_<base64(name)>`; base64 has no
 *  `_`, so the owning service is everything before the first one. */
export function serviceIdOfChild(childId: string): string | null {
  const cut = childId.indexOf('_');
  return cut > 0 ? childId.slice(0, cut) : null;
}

const GET_SERVICE = /* GraphQL */ `
  query HorizonAccessService($id: String!) {
    service: getService(serviceId: $id) { id name normal group layers }
  }
`;

interface RawService {
  id: string;
  name: string;
  normal?: boolean | null;
  group?: string | null;
  layers?: string[] | null;
}

export class ServiceIdentityResolver {
  constructor(private readonly deps: ServiceIdentityDeps) {}

  /** Null when OAP answers that it has no such service; throws
   *  {@link ServiceLookupUnavailable} when it could not be asked. Rows kept
   *  through failed refreshes decide access only while recent. */
  async byId(id: string, signal?: AbortSignal): Promise<ResolvedService | null> {
    const snapshot = await this.deps.catalog.get();
    if (trusted(snapshot)) {
      const hit = indexOf(snapshot).byId.get(id);
      if (hit) return hit;
    }
    const opts = buildOapOpts(this.deps.config.current, this.deps.fetch, signal);
    let got: { service: RawService | null };
    try {
      got = await graphqlPost<{ service: RawService | null }>(opts, GET_SERVICE, { id });
    } catch (err) {
      throw new ServiceLookupUnavailable(err);
    }
    const s = got.service;
    if (!s || s.id !== id) return null;
    return {
      id: s.id,
      name: s.name,
      normal: s.normal === true ? true : s.normal === false ? false : null,
      group: s.group ?? '',
      layers: [...new Set((s.layers ?? []).map(canonicalLayerKey))],
    };
  }

  /**
   * Every service a NAME can mean. With `normal` given there is exactly one
   * candidate id; without it a name can mean both the real and the
   * conjectural service, and the caller must be allowed BOTH.
   */
  async byName(name: string, normal: boolean | undefined, signal?: AbortSignal): Promise<ResolvedService[] | null> {
    if (normal !== undefined) {
      const one = await this.byId(serviceIdOf(name, normal), signal);
      return one ? [one] : null;
    }
    const snapshot = await this.deps.catalog.get();
    if (trusted(snapshot)) {
      // Both ids the name addresses, as well as the rows carrying it: OAP lists
      // its blank-named service with an empty name, and files it under `_blank`
      // — the same ids a service literally named `_blank` has.
      const idx = indexOf(snapshot);
      const known = new Map((idx.byName.get(name) ?? []).map((s) => [s.id, s]));
      for (const id of [serviceIdOf(name, true), serviceIdOf(name, false)]) {
        const s = idx.byId.get(id);
        if (s) known.set(id, s);
      }
      if (known.size > 0) return [...known.values()];
    }
    const found = (
      await Promise.all([this.byId(serviceIdOf(name, true), signal), this.byId(serviceIdOf(name, false), signal)])
    ).filter((s): s is ResolvedService => s !== null);
    return found.length > 0 ? found : null;
  }
}
