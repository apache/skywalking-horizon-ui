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
 * Which services an alarm concerns, read from its entity, and the layers and
 * groups they are in.
 *
 * OAP's alarm `id` is the entity's own id: a service id, or
 * `<serviceId>_<base64 name>` for an instance or an endpoint — for a relation,
 * the SOURCE side's. OAP keeps the destination's id too, but the query
 * protocol does not return it, so the destination is read back from the name,
 * which OAP formats as `<source> to <destination>`.
 */

import type { AlarmOwner } from '@skywalking-horizon-ui/api-client';
import type { Index, ResolvedService } from '../services/service-identity.js';
import { serviceIdOfChild, serviceNameOfId } from '../services/service-identity.js';

export interface AlarmEntity {
  scope: string | null;
  id: string;
  name: string;
}

const CHILD_SCOPES = new Set(['ServiceInstance', 'Endpoint', 'ServiceInstanceRelation', 'EndpointRelation']);
const RELATION_SCOPES = new Set(['ServiceRelation', 'ServiceInstanceRelation', 'EndpointRelation', 'ProcessRelation']);

function decode(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf8');
}


export function isRelationAlarm(m: { scope: string | null }): boolean {
  return m.scope !== null && RELATION_SCOPES.has(m.scope);
}

/** The id of the service that owns the alarm's entity — for a relation, its
 *  source. Null for a scope no service owns (`All`, a process). */
export function alarmSourceId(m: AlarmEntity): string | null {
  if (m.scope === 'Service' || m.scope === 'ServiceRelation') return m.id;
  if (m.scope && CHILD_SCOPES.has(m.scope)) return serviceIdOfChild(m.id);
  return null;
}

/**
 * Every service the destination of a relation alarm could be. OAP names them
 * `<src> to <dst>`, `<srcInst> of <srcSvc> to <dstInst> of <dstSvc>` and
 * `<srcEp> in <srcSvc> to <dstEp> in <dstSvc>`. The source part is rebuilt
 * from the id, so only the destination is parsed, and a name does not always
 * pin it down: an instance or endpoint name may itself contain ` of ` / ` in `,
 * so every suffix the catalog knows is a candidate, and a normal and a
 * conjectured service can share a name.
 *
 * For placing a row only: whether the reader may see it is decided by
 * `readable.ts`, which also asks OAP about a namesake the catalog lacks.
 */
export function alarmDestinations(m: AlarmEntity, index: Index): ResolvedService[] {
  return alarmDestinationNames(m).flatMap((name) => index.byName.get(name) ?? []);
}

/** Every service NAME the destination of a relation alarm could be — each
 *  suffix after ` of ` / ` in ` for an instance or endpoint relation. What
 *  each name means is for the caller to look up. */
export function alarmDestinationNames(m: AlarmEntity): string[] {
  const source = alarmSourceId(m);
  const sourceName = source ? serviceNameOfId(source) : null;
  if (!source || sourceName === null) return [];
  let prefix: string;
  let joiner: string | null = null;
  if (m.scope === 'ServiceRelation') {
    prefix = `${sourceName} to `;
  } else if (m.scope === 'ServiceInstanceRelation' || m.scope === 'EndpointRelation') {
    joiner = m.scope === 'ServiceInstanceRelation' ? ' of ' : ' in ';
    prefix = `${decode(m.id.slice(source.length + 1))}${joiner}${sourceName} to `;
  } else {
    return [];
  }
  if (!m.name.startsWith(prefix)) return [];
  const rest = m.name.slice(prefix.length);
  if (!joiner) return [rest];
  const out: string[] = [];
  for (let i = rest.indexOf(joiner); i >= 0; i = rest.indexOf(joiner, i + 1)) out.push(rest.slice(i + joiner.length));
  return out;
}

/** Does the alarm concern the service `serviceId`: its entity is the
 *  service's own, one of its instances or endpoints, or a relation from it —
 *  or a relation whose destination can only be it. A destination the name
 *  fits to a namesake too is not pinned down, so it does not count. */
export function alarmConcernsService(m: AlarmEntity, serviceId: string, index: Index): boolean {
  if (alarmSourceId(m) === serviceId) return true;
  const dests = alarmDestinations(m, index);
  return dests.length > 0 && dests.every((d) => d.id === serviceId);
}

/** The keys of the owner service, then those of the destination. A
 *  destination the name fits more than one service to adds only the keys all
 *  of them share, since OAP does not return its id. */
function ownedKeys(m: AlarmEntity, index: Index, keysOf: (s: ResolvedService) => string[]): string[] {
  const out = new Set<string>();
  const source = alarmSourceId(m);
  const owner = source ? index.byId.get(source) : undefined;
  for (const k of owner ? keysOf(owner) : []) out.add(k);
  const [dest, ...others] = alarmDestinations(m, index);
  if (dest) {
    const shared = others.map((s) => new Set(keysOf(s)));
    for (const k of keysOf(dest)) if (shared.every((keys) => keys.has(k))) out.add(k);
  }
  return [...out];
}

/** Every layer of the services an alarm belongs to — for a relation both
 *  ends, the source's first. Empty when neither end is a service the catalog
 *  knows. */
export function alarmLayers(m: AlarmEntity, index: Index): string[] {
  return ownedKeys(m, index, (s) => s.layers);
}

/** Every layer and group of the services an alarm belongs to, by the same
 *  rule as {@link alarmLayers}. A pin with groups counts a row by these. */
export function alarmOwners(m: AlarmEntity, index: Index): AlarmOwner[] {
  // Keyed as a JSON pair only to dedupe them here.
  return ownedKeys(m, index, (s) => s.layers.map((layer) => JSON.stringify([layer, s.group]))).map((k) => {
    const [layer, group] = JSON.parse(k) as [string, string];
    return { layer, group };
  });
}

/** One incident per entity and rule. OAP's `id` names the entity only, and
 *  exposes no rule id, so the rule is told apart by its expression; the name
 *  separates relations that share a source. */
export function alarmIncidentKey(m: AlarmEntity & { snapshot?: { expression?: string } | null }): string {
  return [m.scope ?? '', m.id, m.name, m.snapshot?.expression ?? ''].join('|');
}
