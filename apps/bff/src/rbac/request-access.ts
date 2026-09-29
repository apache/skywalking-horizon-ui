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
 * One request's answer to "may this caller read that": the session's grants,
 * the operate-layer classification and the service resolver, bound together.
 * Route pre-handlers, handlers that filter rosters, and the AI / MCP tool
 * context all ask through this, so the three cannot drift apart.
 *
 * An identity OAP answers it does not know is allowed for a PLAIN verb, which
 * is what every request did before layer grants existed: an operate-layer
 * service is always one OAP knows, so nothing that rule protects slips
 * through. For a LAYER-LIMITED verb it is refused. An identity OAP could not
 * be asked about decides nothing either way; the gate reports it as an outage.
 */

import type { HorizonConfig } from '../config/schema.js';
import type { LayerClassification } from '../logic/layers/operate-layers.js';
import { canonicalLayerKey } from '../logic/templates/identity.js';
import {
  ServiceLookupUnavailable,
  entityServiceName,
  isBlankToOap,
  serviceIdOf,
  serviceIdOfChild,
  type ResolvedService,
  type ServiceIdentityResolver,
} from '../logic/services/service-identity.js';
import { SessionAccess, type LayerReach } from './layer-access.js';
import type { VerbSubject } from './policy.js';
import { LAYER_PAGE_VERBS, resolveVerbsForRoles, type Verb } from './verbs.js';

export interface AccessDeps {
  services: ServiceIdentityResolver;
  classify(): Promise<LayerClassification>;
}

/** A service named by the request, in whichever form it arrived. */
export type ServiceRef =
  | { id: string }
  | { name: string; normal?: boolean }
  /** Instance / endpoint / browser-version / page-path id: owned by the service in its prefix. */
  | { childId: string }
  /** Either an id or a name — the dashboard and evaluation-record `service` field. */
  | { idOrName: string };

export type Resolution =
  | { kind: 'found'; services: ResolvedService[] }
  /** OAP answered: no such service. */
  | { kind: 'unknown' }
  /** OAP could not be asked — never taken as an answer. */
  | { kind: 'unavailable' };

/** What a graph builder learns of the services it drew: the ones the caller
 *  may see the values of, and the ones OAP could not say the owner of. */
export interface GraphReach {
  readable: ReadonlySet<string>;
  unavailable: ReadonlySet<string>;
}

export interface GraphChecks {
  /** By service id. */
  readableOf?: (ids: readonly string[]) => Promise<GraphReach>;
  /** By service name, for a metric OAP resolves by name alone. */
  namesReadableOf?: (names: readonly string[]) => Promise<GraphReach>;
}

/** MQE functions OAP evaluates by the service NAME alone — `baseline` looks up
 *  its prediction by name, whatever the entity's `normal` says — so they read
 *  every service the name can mean. */
const NAME_ONLY_MQE = /\bbaseline\s*\(/;

export function readsByNameOnly(expressions: readonly string[]): boolean {
  return expressions.some((e) => NAME_ONLY_MQE.test(e));
}

/** A graph metric definition (`{ mqe }`, in any template graph block) that
 *  reads by service name alone. */
function isNameOnlyMetric(v: unknown): boolean {
  const mqe = v && typeof v === 'object' ? (v as { mqe?: unknown }).mqe : undefined;
  return typeof mqe === 'string' && NAME_ONLY_MQE.test(mqe);
}

function hasNameOnlyMetric(v: unknown): boolean {
  if (isNameOnlyMetric(v)) return true;
  if (Array.isArray(v)) return v.some(hasNameOnlyMetric);
  return !!v && typeof v === 'object' && Object.values(v).some(hasNameOnlyMetric);
}

function withoutNameOnlyMetrics(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter((x) => !isNameOnlyMetric(x)).map(withoutNameOnlyMetrics);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withoutNameOnlyMetrics(x)]));
  return v;
}

const SERVICE_ID = /^[A-Za-z0-9+/=]+\.[01]$/;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Does OAP read this service name, or id, exactly as written? OAP trims a name
 * (Java's `trim()`, which also drops control characters) and reads a blank one
 * as `_blank`; its encoder writes a lone UTF-16 surrogate as `?` where Node's
 * writes U+FFFD. Any of those makes the service checked differ from the one
 * read, so such an identity is refused rather than interpreted.
 */
export function isExactIdentity(v: string): boolean {
  return v !== '' && v === v.trim() && !CONTROL.test(v) && !LONE_SURROGATE.test(v);
}


export class RequestAccess {
  constructor(
    readonly session: SessionAccess,
    private readonly services: ServiceIdentityResolver,
    private readonly signal?: AbortSignal,
  ) {}

  plain(verb: Verb): boolean {
    return this.session.plain(verb);
  }

  isOperate(layer: string): boolean {
    return this.session.isOperate(layer);
  }

  /**
   * Should the sidebar show this layer (and, when it is split, this group's
   * entry)? A session with no layer grant sees exactly the menu it always
   * has: every layer, with the operate layers only for `cluster:read`. A
   * session with layer grants sees the layers its page verbs reach.
   */
  menuShows(layer: string, group?: string): boolean {
    if (!this.session.hasLayerGrants()) return !this.isOperate(layer) || this.plain('cluster:read');
    const reach = this.onLayer(LAYER_PAGE_VERBS, layer);
    if (!reach) return false;
    return reach.whole || group === undefined || reach.groups.has(group);
  }

  /** Holds one of `verbs` on every layer, operate layers included, so nothing
   *  a request names can be out of reach. */
  readsEveryLayer(verbs: readonly Verb[]): boolean {
    return verbs.some((v) => this.plain(v)) && this.plain('cluster:read');
  }

  /** Every verb in `verbs` is held only through layer grants. */
  layerLimited(verbs: readonly Verb[]): boolean {
    return verbs.every((v) => this.session.layerLimited(v));
  }

  onLayer(verbs: readonly Verb[], layer: string): LayerReach | null {
    return this.session.onLayerAny(verbs, layer);
  }

  private readonly resolved = new Map<string, Promise<Resolution>>();

  resolve(ref: ServiceRef): Promise<Resolution> {
    const key = JSON.stringify(ref);
    let r = this.resolved.get(key);
    if (!r) {
      r = this.lookup(ref).catch((err: unknown) => {
        if (err instanceof ServiceLookupUnavailable) return { kind: 'unavailable' } as const;
        throw err;
      });
      this.resolved.set(key, r);
    }
    return r;
  }

  private async lookup(ref: ServiceRef): Promise<Resolution> {
    // A name means the service OAP files it under — a blank one is `_blank`.
    // An empty id names no service at all.
    let found: ResolvedService[] | null = null;
    if ('id' in ref) {
      if (isBlankToOap(ref.id)) return { kind: 'unknown' };
      const one = await this.services.byId(ref.id, this.signal);
      found = one ? [one] : null;
    } else if ('childId' in ref) {
      if (isBlankToOap(ref.childId)) return { kind: 'unknown' };
      const owner = serviceIdOfChild(ref.childId);
      const one = owner ? await this.services.byId(owner, this.signal) : null;
      found = one ? [one] : null;
    } else if ('idOrName' in ref) {
      if (SERVICE_ID.test(ref.idOrName)) {
        const one = await this.services.byId(ref.idOrName, this.signal);
        if (one) found = [one];
      }
      found ??= await this.services.byName(entityServiceName(ref.idOrName), undefined, this.signal);
    } else {
      found = await this.services.byName(entityServiceName(ref.name), ref.normal, this.signal);
    }
    return found && found.length > 0 ? { kind: 'found', services: found } : { kind: 'unknown' };
  }

  /** Asks OAP at once about every service `refs` name that the catalog does
   *  not list, before many rows are decided one by one. Best effort: what it
   *  could not settle is asked, and reported, by the decision that needs it. */
  async prefetch(refs: readonly ServiceRef[]): Promise<void> {
    const ids: string[] = [];
    for (const ref of refs) {
      if ('id' in ref) {
        if (!isBlankToOap(ref.id)) ids.push(ref.id);
      } else if ('name' in ref) {
        if (ref.normal !== undefined) ids.push(serviceIdOf(ref.name, ref.normal));
        else ids.push(serviceIdOf(ref.name, true), serviceIdOf(ref.name, false));
      } else if ('childId' in ref) {
        const owner = isBlankToOap(ref.childId) ? null : serviceIdOfChild(ref.childId);
        if (owner) ids.push(owner);
      }
    }
    await this.services.prefetch(ids, this.signal);
  }

  /** Of `ids`, the services the caller may read with any of `verbs`, and those
   *  OAP could not say the owner of — OAP asked at once about the ids the
   *  catalog lacks. Neither kind is read; they are told apart on screen. */
  async readableIds(verbs: readonly Verb[], ids: readonly string[]): Promise<GraphReach> {
    await this.prefetch(ids.map((id): ServiceRef => ({ id })));
    const readable = new Set<string>();
    const unavailable = new Set<string>();
    for (const id of ids) {
      const d = await this.decide(verbs, { id });
      if (d === 'allow') readable.add(id);
      else if (d === 'unavailable') unavailable.add(id);
    }
    return { readable, unavailable };
  }

  /** Of `names`, those every service of which the caller may read — what a
   *  metric OAP resolves by name alone (`baseline`) needs — and those OAP could
   *  not answer about. */
  async readableNames(verbs: readonly Verb[], names: readonly string[]): Promise<GraphReach> {
    const unique = [...new Set(names.map((n) => entityServiceName(n)))];
    await this.prefetch(unique.map((name): ServiceRef => ({ name })));
    const readable = new Set<string>();
    const unavailable = new Set<string>();
    for (const name of unique) {
      const d = await this.decide(verbs, { name });
      if (d === 'allow') readable.add(name);
      else if (d === 'unavailable') unavailable.add(name);
    }
    return { readable, unavailable };
  }

  /** For a graph builder: the checks that tell which drawn services, and which
   *  names, the caller may see the values of — none to pass when it may see
   *  every one. */
  graphReadable(verbs: readonly Verb[]): GraphChecks {
    return this.readsEveryLayer(verbs)
      ? {}
      : { readableOf: (ids) => this.readableIds(verbs, ids), namesReadableOf: (names) => this.readableNames(verbs, names) };
  }

  /** May the caller read this service with any of `verbs`? A name that can
   *  mean several services must be allowed for every one of them. */
  async allows(verbs: readonly Verb[], ref: ServiceRef): Promise<boolean> {
    return (await this.decide(verbs, ref)) === 'allow';
  }

  /** {@link allows}, keeping "OAP could not be asked" apart from "no": the
   *  first is an outage to report as one, not a refusal. */
  async decide(verbs: readonly Verb[], ref: ServiceRef): Promise<'allow' | 'deny' | 'unavailable'> {
    const r = await this.resolve(ref);
    if (r.kind === 'unavailable') return 'unavailable';
    if (r.kind === 'unknown') return verbs.some((v) => this.session.plain(v)) ? 'allow' : 'deny';
    return r.services.every((s) => this.allowsResolved(verbs, s)) ? 'allow' : 'deny';
  }

  /**
   * The graph block a caller may evaluate over the services `focusIds` — for a
   * graph whose every metric is read for those services (a deployment, a
   * profiled process pair). A `baseline` among them reads a service by name
   * alone, the real service and any conjectured namesake, so such metrics stay
   * only when every name of every focus is readable; otherwise they are left
   * out, as a refused landing column is. The service map, instance map and API
   * dependency graph decide this per node and per call instead
   * (graph-access.ts). Throws {@link ServiceLookupUnavailable} when OAP could
   * not answer: the whole block depends on it.
   */
  async graphConfig<T>(verbs: readonly Verb[], focusIds: readonly string[], cfg: T): Promise<T> {
    if (!hasNameOnlyMetric(cfg) || this.readsEveryLayer(verbs)) return cfg;
    const strip = withoutNameOnlyMetrics(cfg) as T;
    if (focusIds.length === 0) return strip;
    for (const id of focusIds) {
      const r = await this.resolve({ id });
      if (r.kind === 'unavailable') throw new ServiceLookupUnavailable('OAP did not answer which service a graph reads');
      // A focus OAP does not know has no name to check, but OAP still answers
      // a `baseline` for whatever name the request carries.
      if (r.kind !== 'found') return strip;
      for (const s of r.services) {
        const d = await this.decide(verbs, { name: entityServiceName(s.name) });
        if (d === 'unavailable') throw new ServiceLookupUnavailable('OAP did not answer which service a graph reads');
        if (d !== 'allow') return strip;
      }
    }
    return cfg;
  }

  /** For a read that named no service: keep the rows of services the caller
   *  may read, each decided by the service it carries — an empty name is the
   *  service OAP files under `_blank`, not the absence of one. Throws
   *  {@link ServiceLookupUnavailable} when OAP could not say whose a row is:
   *  dropping it would pass a partial answer off as whole. */
  async keepReadable<T>(verbs: readonly Verb[], rows: readonly T[], refOf: (row: T) => ServiceRef): Promise<T[]> {
    if (this.readsEveryLayer(verbs)) return [...rows];
    const out: T[] = [];
    for (const row of rows) {
      const d = await this.decide(verbs, refOf(row));
      if (d === 'unavailable') throw new ServiceLookupUnavailable('OAP did not answer which service a row belongs to');
      if (d === 'allow') out.push(row);
    }
    return out;
  }

  /** Synchronous check for a service the caller already resolved (a roster
   *  row, a catalog entry). */
  allowsResolved(verbs: readonly Verb[], service: ResolvedService): boolean {
    if (this.blankIsOutOfReach(verbs, service.name)) return false;
    return this.session.onServiceAny(verbs, service);
  }

  /** OAP lists its blank-named service with the name it was registered
   *  under, and files its data under `_blank`. No layer grant is meant to
   *  reach it, so a layer-limited caller may not read through it. */
  private blankIsOutOfReach(verbs: readonly Verb[], name: string | undefined): boolean {
    return name !== undefined && isBlankToOap(name) && this.layerLimited(verbs);
  }

  /** Keep the roster rows of `layer` the caller may read. Rows carry their
   *  own group; the layer is the one they were listed under. */
  filterRoster<T extends { group?: string | null; name?: string }>(verbs: readonly Verb[], layer: string, rows: T[]): T[] {
    const reach = this.onLayer(verbs, layer);
    if (!reach) return [];
    const named = rows.filter((r) => !this.blankIsOutOfReach(verbs, r.name));
    if (reach.whole) return named;
    return named.filter((r) => reach.groups.has(r.group ?? ''));
  }
}

export function serviceRefFromName(name: string, normal?: boolean): ServiceRef {
  return normal === undefined ? { name } : { id: serviceIdOf(name, normal) };
}

export async function buildRequestAccess(
  config: HorizonConfig,
  subject: VerbSubject,
  deps: AccessDeps,
  signal?: AbortSignal,
): Promise<RequestAccess> {
  const grants = resolveVerbsForRoles(config.rbac.roles, subject.roles, config.rbac.enabled);
  const classification = await deps.classify();
  const session = new SessionAccess(grants, subject.verbCap, {
    isOperate: (layer) => classification.isOperate(layer),
    canonical: canonicalLayerKey,
  });
  return new RequestAccess(session, deps.services, signal);
}
