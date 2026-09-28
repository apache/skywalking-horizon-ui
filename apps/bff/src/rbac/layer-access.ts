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
 * Which layers, and which services in them, a session may read with a verb.
 *
 * Two kinds of grant answer the question. A PLAIN verb (`metrics:read`) reaches
 * every layer except the operate layers (Platform monitoring), which also need
 * `cluster:read` — the rule the sidebar and the Roles page have always stated.
 * A LAYER verb (`metrics:read@GENERAL[payments]`) reaches exactly its layer,
 * and within it only the named OAP service groups; an explicit grant on an
 * operate layer opens it without `cluster:read`.
 *
 * A service is reachable when one of the layers it belongs to is reachable for
 * its group. OAP keys a service by `(name, normal)` with no layer in the id, so
 * a service in two layers is one entity: granting either layer grants it.
 *
 * Pure: the caller supplies which layers are operate and who the service is.
 */

import type { Verb } from './verbs.js';
import { hasVerb, parseGrant, qualifiedVerbCovers, type ParsedGrant } from './verbs.js';

export interface LayerReach {
  /** Every service of the layer. */
  whole: boolean;
  /** When not whole: the OAP `Service.group` values reachable (`''` = ungrouped). */
  groups: ReadonlySet<string>;
}

export interface ServiceIdentity {
  id: string;
  name: string;
  normal: boolean | null;
  /** OAP `Service.group`, `''` when the service has none. */
  group: string;
  /** Canonical layer keys the service reports into. */
  layers: readonly string[];
}

export interface AccessFacts {
  /** Canonical layer key → is it an operate (Platform monitoring) layer. */
  isOperate(layer: string): boolean;
  /** Fold an OAP / grant layer spelling to the canonical key. */
  canonical(layer: string): string;
}

const WHOLE: LayerReach = { whole: true, groups: new Set() };

export class SessionAccess {
  private readonly qualified: ParsedGrant[];

  constructor(
    /** The session's resolved grants (roles expanded, aliases applied). */
    private readonly grants: readonly Verb[],
    /** An OAuth scope's plain-verb cap; absent = no cap. */
    private readonly cap: readonly Verb[] | undefined,
    private readonly facts: AccessFacts,
  ) {
    this.qualified = [];
    for (const g of grants) {
      if (!g.includes('@')) continue;
      const parsed = parseGrant(g);
      if (parsed?.qualifier) this.qualified.push(parsed);
    }
  }

  /** The cap narrows by verb and never by layer, so `*:read` over
   *  `metrics:read@GENERAL` leaves `metrics:read@GENERAL`. */
  private capAllows(verb: Verb): boolean {
    return this.cap ? hasVerb(this.cap, verb) : true;
  }

  /** The question every route asked before layer grants existed. A route
   *  that is not about one layer or one service still asks exactly this. */
  plain(verb: Verb): boolean {
    return this.capAllows(verb) && hasVerb(this.grants, verb);
  }

  isOperate(layer: string): boolean {
    return this.facts.isOperate(this.facts.canonical(layer));
  }

  /** Does the session hold any layer-limited grant at all? A session with
   *  none sees the menu it has always seen. */
  hasLayerGrants(): boolean {
    return this.qualified.length > 0;
  }

  /** Is `verb` held at all — plainly, or on some layer? */
  holds(verb: Verb): boolean {
    if (this.plain(verb)) return true;
    return this.capAllows(verb) && this.qualified.some((q) => qualifiedVerbCovers(q, verb));
  }

  /** Is `verb` held only through layer grants (no plain grant)? Decided per
   *  verb: a plain `alarms:read` beside `metrics:read@GENERAL` leaves metrics
   *  layer-limited and alarms not. */
  layerLimited(verb: Verb): boolean {
    return !this.plain(verb);
  }

  onLayer(verb: Verb, layer: string): LayerReach | null {
    if (!this.capAllows(verb)) return null;
    const key = this.facts.canonical(layer);
    if (hasVerb(this.grants, verb) && (!this.facts.isOperate(key) || this.plain('cluster:read'))) {
      return WHOLE;
    }
    let groups: Set<string> | null = null;
    for (const q of this.qualified) {
      if (this.facts.canonical(q.qualifier!.layer) !== key || !qualifiedVerbCovers(q, verb)) continue;
      if (!q.qualifier!.groups) return WHOLE;
      groups ??= new Set();
      for (const g of q.qualifier!.groups) groups.add(g);
    }
    return groups ? { whole: false, groups } : null;
  }

  /** Any of `verbs` reaching `layer`, merged. */
  onLayerAny(verbs: readonly Verb[], layer: string): LayerReach | null {
    let merged: Set<string> | null = null;
    for (const v of verbs) {
      const r = this.onLayer(v, layer);
      if (!r) continue;
      if (r.whole) return WHOLE;
      merged ??= new Set();
      for (const g of r.groups) merged.add(g);
    }
    return merged ? { whole: false, groups: merged } : null;
  }

  onService(verb: Verb, service: ServiceIdentity): boolean {
    return this.onServiceAny([verb], service);
  }

  onServiceAny(verbs: readonly Verb[], service: ServiceIdentity): boolean {
    // A service OAP reports under no layer cannot be in an operate layer, and
    // no layer grant can name it.
    if (service.layers.length === 0) return verbs.some((v) => this.plain(v));
    return service.layers.some((layer) => {
      const r = this.onLayerAny(verbs, layer);
      return r !== null && (r.whole || r.groups.has(service.group));
    });
  }
}
