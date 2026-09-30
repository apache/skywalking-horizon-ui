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
 * The pre-handler that applies a {@link ScopeRule}: builds the request's
 * {@link RequestAccess}, then checks the URL's layer and every identity the
 * rule names before the handler runs.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ConfigSource } from '../config/loader.js';
import { clientGone } from '../http/client-gone.js';
import {
  buildRequestAccess,
  isExactIdentity,
  readsByNameOnly,
  serviceRefFromName,
  type AccessDeps,
  type RequestAccess,
  type ServiceRef,
} from './request-access.js';
import { sessionHasVerb } from './policy.js';
import { fieldValue, type IdSpec, type ScopeRule } from './route-scope.js';
import type { Verb } from './verbs.js';
import { ownershipUnavailable } from '../http/ownership-unavailable.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the scope gate on every route `ROUTE_SCOPE` lists. Absent where
     *  the gate is not wired (unit tests), which handlers read as "no layer
     *  restriction" — the behaviour before layer grants existed. */
    access?: RequestAccess;
  }
}

const SERVICE_ID = /^[A-Za-z0-9+/=]+\.[01]$/;
/** An id a service owns: `<serviceId>_<base64 name>`. A value that does not
 *  look like one is a NAME the handler searches within an already-checked
 *  service (the endpoint-dependency `endpoint` field), not an id to check. */
const CHILD_ID = /^[A-Za-z0-9+/=]+\.[01]_./;

/** What the request names: services to check one by one, relation ends of
 *  which one is enough, and ids the BFF cannot attribute to a service. */
interface Named {
  refs: ServiceRef[];
  relations: ServiceRef[][];
  unattributable: boolean;
  /** An identity OAP would not read as written — see `isExactIdentity`. The
   *  service checked could differ from the one read, so it is refused; no
   *  client sends one. */
  padded: boolean;
}

function flag(v: unknown): boolean | undefined {
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return undefined;
}

/** A non-empty identity value. One OAP would not read as written is recorded
 *  as padded (see {@link Named.padded}). */
function str(v: unknown, into: Named): string | null {
  if (typeof v !== 'string' || v === '') return null;
  if (!isExactIdentity(v)) into.padded = true;
  return v;
}

function refsOf(req: FastifyRequest, spec: IdSpec, into: Named): ServiceRef[] {
  const out: ServiceRef[] = [];
  if ('serviceId' in spec) {
    const v = str(fieldValue(req, spec.serviceId), into);
    if (v) out.push({ id: v });
  } else if ('serviceIds' in spec) {
    const v = str(fieldValue(req, spec.serviceIds), into);
    for (const id of v ? v.split(',') : []) if (id.trim()) out.push({ id: id.trim() });
  } else if ('serviceName' in spec) {
    const v = str(fieldValue(req, spec.serviceName), into);
    if (v) out.push(serviceRefFromName(v, spec.normal ? flag(fieldValue(req, spec.normal)) : undefined));
  } else if ('serviceIdOrName' in spec) {
    const v = str(fieldValue(req, spec.serviceIdOrName), into);
    if (v) out.push({ idOrName: v });
  } else if ('childId' in spec) {
    const v = str(fieldValue(req, spec.childId), into);
    if (v && CHILD_ID.test(v)) out.push({ childId: v });
  } else if ('childIds' in spec) {
    const v = fieldValue(req, spec.childIds);
    for (const c of Array.isArray(v) ? v : []) {
      const s = str(c, into);
      if (s && CHILD_ID.test(s)) out.push({ childId: s });
      else if (s) into.unattributable = true;
    }
  } else if ('taskId' in spec) {
    const v = str(fieldValue(req, spec.taskId), into);
    if (v) {
      const cut = v.indexOf('_');
      const owner = cut > 0 ? v.slice(cut + 1) : '';
      if (SERVICE_ID.test(owner)) out.push({ id: owner });
      else into.unattributable = true;
    }
  } else if ('entity' in spec) {
    const e = fieldValue(req, spec.entity);
    if (e && typeof e === 'object') {
      const ent = e as Record<string, unknown>;
      const src = str(ent.serviceName, into);
      // The entity does not say the metric's scope: a Service-scope metric
      // reads `serviceName` and ignores the `dest*` side. So the source must be
      // readable whatever the destination is; a relation then reads the
      // caller's own outbound calls, which it owns an end of.
      // With no source the expression names no service at all (a `top_n`
      // filters by `serviceName` only): the handler asks for inspect:read.
      // `baseline` ignores `normal`: it reads every service the name can mean.
      const expression = bodyOf(req).expression;
      const byName = typeof expression === 'string' && readsByNameOnly([expression]);
      if (src) out.push(byName ? { name: src } : serviceRefFromName(src, flag(ent.normal)));
    }
  } else if ('serviceList' in spec) {
    const v = fieldValue(req, spec.serviceList);
    for (const item of Array.isArray(v) ? v : []) {
      const s = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      const name = str(s.name, into);
      const byName = typeof s.mqe === 'string' && readsByNameOnly([s.mqe]);
      if (name) out.push(byName ? { name } : serviceRefFromName(name, flag(s.normal)));
    }
  } else if ('serviceIdElse' in spec) {
    const id = str(fieldValue(req, spec.serviceIdElse), into);
    const other = id ? null : str(fieldValue(req, spec.idOrName), into);
    if (id) out.push({ id });
    else if (other) out.push({ idOrName: other });
  }
  return out;
}

function bodyOf(req: FastifyRequest): Record<string, unknown> {
  return req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
}

function named(req: FastifyRequest, rule: ScopeRule): Named {
  const n: Named = { refs: [], relations: [], unattributable: false, padded: false };
  for (const spec of rule.ids ?? []) n.refs.push(...refsOf(req, spec, n));
  if (rule.relation) {
    const ends = rule.relation.flatMap((spec) => refsOf(req, spec, n));
    if (ends.length > 0) n.relations.push(ends);
  }
  return n;
}

function unavailable(reply: FastifyReply): void {
  ownershipUnavailable(reply);
}

function deny(reply: FastifyReply, verbs: readonly Verb[], reason: string, extra: Record<string, unknown> = {}): void {
  reply.code(403).send({ error: 'permission_denied', verb: verbs.join(' or '), reason, ...extra });
}

export function scopeGate(
  config: ConfigSource,
  deps: AccessDeps | undefined,
  rule: ScopeRule,
  verbs: readonly Verb[],
) {
  return async function scopePreHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const session = req.session;
    if (!session) return void reply.code(401).send({ error: 'unauthenticated' });
    const cfg = config.current;

    const draft = rule.preview ? fieldValue(req, rule.preview) : undefined;
    // Anything but an empty string counts: a parser may coerce other shapes.
    const hasDraft = typeof draft === 'string' ? draft.trim() !== '' : draft !== undefined && draft !== null;
    if (hasDraft && !sessionHasVerb(cfg, session, 'layer-template:write')) {
      return deny(reply, ['layer-template:write'], 'preview_needs_template_write');
    }
    if (!deps) return;

    const access = await buildRequestAccess(cfg, session, deps, clientGone(reply));
    req.access = access;
    // A route with no layer and no service in it (the menu, a roster the
    // handler filters) only needs the access object.
    if (verbs.length === 0) return;
    if (access.readsEveryLayer(verbs)) return;

    const limited = access.layerLimited(verbs);
    if (limited && rule.limitedDenied) {
      const reason = rule.limitedDenied(req);
      if (reason) return deny(reply, verbs, reason);
    }

    if (rule.layer) {
      const key = (req.params as { key?: string }).key ?? '';
      if (!access.onLayer(verbs, key)) return deny(reply, verbs, 'layer_not_granted', { layer: key });
    }
    // The data lives in one layer whatever the URL says.
    if (rule.fixedLayer && !access.onLayer(verbs, rule.fixedLayer)) {
      return deny(reply, verbs, 'layer_not_granted', { layer: rule.fixedLayer });
    }

    const n = named(req, rule);
    if (n.padded) return deny(reply, verbs, 'identity_not_normalized');
    if (n.unattributable && limited) return deny(reply, verbs, 'id_names_no_service');
    for (const ref of n.refs) {
      const d = await access.decide(verbs, ref);
      if (d === 'unavailable') return unavailable(reply);
      if (d === 'deny') return deny(reply, verbs, 'service_not_granted');
    }
    for (const ends of n.relations) {
      const ds = [];
      for (const ref of ends) ds.push(await access.decide(verbs, ref));
      if (ds.includes('allow')) continue;
      if (ds.includes('unavailable')) return unavailable(reply);
      return deny(reply, verbs, 'service_not_granted');
    }
    const requireService = typeof rule.requireService === 'function' ? rule.requireService(req) : rule.requireService;
    if (requireService && limited && n.refs.length === 0 && n.relations.length === 0) {
      return deny(reply, verbs, 'service_required');
    }
  };
}
