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
 * A route's `serviceId` (id) / `service` (name) argument → OAP service id, for
 * every entity-scoped query route (traces, logs, browser errors, and each
 * profiling flavour).
 *
 * The result is a THREE-way outcome on purpose. "No service asked for" and
 * "the service asked for does not exist" are different answers, and a caller
 * that collapses them into `string | null` — then spreads
 * `...(id ? { serviceId: id } : {})` into an OAP condition — silently turns an
 * unknown or stale name into an UNSCOPED query: OAP answers with every
 * service's records and the operator reads them as the one service they
 * picked. Callers must branch on `unknown` and refuse instead of querying.
 */

import type { GraphqlOptions } from '../../client/graphql.js';
import { graphqlPost } from '../../client/graphql.js';

/** Outcome of resolving a caller-supplied `service` argument.
 *
 *  - `all`     — nothing was supplied; a cross-service query is legitimate.
 *  - `service` — resolved to an OAP service id; scope the query to it.
 *  - `unknown` — supplied but matched nothing in the layer; DO NOT query. */
export type ServiceScope =
  | { kind: 'all' }
  | { kind: 'service'; serviceId: string }
  | { kind: 'unknown'; serviceArg: string; message: string };

const LIST_SERVICES_FOR_RESOLVE = /* GraphQL */ `
  query HorizonResolveServiceId($layer: String!) {
    services: listServices(layer: $layer) {
      id
      name
      normal
    }
  }
`;

/** Resolution for a caller that cannot query without a service — `all` is not
 *  one of the outcomes. */
export type ResolvedService = Exclude<ServiceScope, { kind: 'all' }>;

/** A layer's roster row, as {@link resolveServiceScope} reads it. `normal` is
 *  OAP's agent-detected (`true`) vs conjectured/virtual (`false`) flag; it is
 *  optional because an older/partial roster may not carry it. */
export interface RosterService {
  id: string;
  name: string;
  normal?: boolean | null;
}

/**
 * What a caller knows about the normal/virtual identity behind a NAME.
 *
 * OAP mints a service id as `base64(<name>).<1 = normal | 0 = virtual>`
 * (`IDManager.ServiceID.buildId`), so an agent-detected service and a
 * conjectured peer that share a name are two DIFFERENT entities whose ids
 * differ in that last digit. A roster holding both answers such a name with two
 * ids; the hint says which one was meant, and a caller that has none gets a
 * refusal instead of a coin flip.
 *
 * No route passes one today, and none has to: every roster resolved here is ONE
 * layer's (`listServices(layer)`), and a layer's services are all normal or all
 * virtual — `ServiceTraffic` builds the id with `layer.isNormal()`, and OAP's
 * own name-based input (`ServiceCondition`) derives the flag from the layer the
 * same way. A name is therefore never two ids within one layer. The hint is for
 * a roster that spans layers.
 */
export interface ServiceNameHint {
  normal?: boolean | null;
}

/** The refusal text a caller reports when resolution came back `unknown`. */
export function unknownServiceMessage(serviceArg: string, layer: string): string {
  return `Unknown service "${serviceArg}" in layer ${layer.toUpperCase()}.`;
}

/**
 * Which service a NAME refers to inside one layer's roster — the whole
 * decision, pulled out of the OAP round-trip so every branch is directly
 * testable.
 *
 * Names are matched before ids on purpose: the argument is a NAME, and an OAP
 * id is `base64(<name>).<0|1>`, a shape an ordinary name can wear too (`api.1`,
 * `orders.2026`). The `id` column is matched only as a fallback, for a caller
 * that has no id slot to use — and when the same string is one service's name
 * AND another's id, the slot cannot say which was meant, so this refuses rather
 * than picking the name silently.
 */
export function matchServiceInRoster(
  services: readonly RosterService[],
  serviceArg: string,
  layer: string,
  hint: ServiceNameHint = {},
): ServiceScope {
  const refuse = (message: string): ServiceScope => ({ kind: 'unknown', serviceArg, message });
  const named = services.filter((s) => s.name === serviceArg);
  // A roster row with no flag can't contradict the hint — keep it in play.
  const wanted =
    hint.normal === null || hint.normal === undefined
      ? named
      : named.filter((s) => s.normal === null || s.normal === undefined || s.normal === hint.normal);
  const namedIds = [...new Set(wanted.map((s) => s.id))];
  if (namedIds.length > 1) {
    return refuse(
      `Service name "${serviceArg}" in layer ${layer.toUpperCase()} matches both a normal and a virtual service. Query it by service id.`,
    );
  }
  if (named.length > 0 && wanted.length === 0) {
    return refuse(
      `No ${hint.normal ? 'normal' : 'virtual'} service "${serviceArg}" in layer ${layer.toUpperCase()}.`,
    );
  }
  const namedId = namedIds[0];
  const idMatch = services.find((s) => s.id === serviceArg)?.id;
  if (namedId && idMatch && idMatch !== namedId) {
    return refuse(
      `"${serviceArg}" is both a service name and another service's id in layer ${layer.toUpperCase()}. Send it as serviceId (id) or service (name).`,
    );
  }
  const serviceId = namedId ?? idMatch;
  return serviceId ? { kind: 'service', serviceId } : refuse(unknownServiceMessage(serviceArg, layer));
}

/**
 * Resolve a service NAME within a layer, through `listServices(layer)`.
 *
 * The argument is a NAME; {@link matchServiceInRoster} owns what that means.
 * Callers that hold a real id pass it in its own parameter and never come
 * through here ({@link resolveServiceArgs}) — that is both cheaper (no
 * round-trip) and exact (no name to collide with).
 *
 * Throws whatever the OAP round-trip throws — an unreachable OAP is not the
 * same as an unknown service, and callers report it as the transport failure it
 * is.
 */
export async function resolveServiceScope(
  opts: GraphqlOptions,
  layer: string,
  serviceArg: string | null | undefined,
  hint: ServiceNameHint = {},
): Promise<ServiceScope> {
  if (!serviceArg) return { kind: 'all' };
  const data = await graphqlPost<{ services: RosterService[] }>(opts, LIST_SERVICES_FOR_RESOLVE, {
    layer: layer.toUpperCase(),
  });
  return matchServiceInRoster(data.services ?? [], serviceArg, layer, hint);
}

/**
 * {@link resolveServiceScope} for callers whose OAP query is meaningless
 * without a service — the profiling task lists. The reason differs per
 * endpoint: `queryEBPFProfilingTasks(serviceId: ID)` is nullable, so omitting
 * it really does answer with every service's tasks; async-profiler and pprof
 * take `serviceId: ID!`, where omitting it is simply a malformed query. Either
 * way there is nothing sane to send, so this folds `all` into a refusal and
 * leaves those routes just two outcomes to handle.
 */
export async function resolveRequiredService(
  opts: GraphqlOptions,
  layer: string,
  serviceArg: string | null | undefined,
  hint: ServiceNameHint = {},
): Promise<ResolvedService> {
  const scope = await resolveServiceScope(opts, layer, serviceArg, hint);
  if (scope.kind === 'all') {
    return { kind: 'unknown', serviceArg: '', message: `No service supplied for layer ${layer.toUpperCase()}.` };
  }
  return scope;
}

/** How a route received its service: as an OAP id, as a name, or not at all.
 *  Keeping the two apart is what removes the guesswork — a UI screen that
 *  already holds the id sends `serviceId`, and only a caller that genuinely has
 *  a name (the alarms filter's instance / endpoint pickers, a hand-written
 *  request) sends `service`. `normal` qualifies that name; see
 *  {@link ServiceNameHint} for why no caller sends one. */
export interface ServiceArgs {
  /** OAP service id, trusted as an id — no lookup, no shape test. */
  serviceId?: string | null;
  /** Service NAME, resolved against the layer's roster. */
  service?: string | null;
  /** {@link ServiceNameHint} for `service`. Ignored when `serviceId` is set. */
  normal?: boolean | null;
}

/** A route's `?serviceId=&service=&normal=` query pairs as {@link ServiceArgs}.
 *  `normal` is only a hint when it is literally `true` / `false`; anything else
 *  (absent, empty, junk) leaves the name unqualified rather than asserting a
 *  flag the caller never sent. */
export function serviceArgsFromQuery(q: {
  serviceId?: string;
  service?: string;
  normal?: string;
}): ServiceArgs {
  const normal = (q.normal ?? '').trim().toLowerCase();
  return {
    serviceId: (q.serviceId ?? '').trim(),
    service: (q.service ?? '').trim(),
    normal: normal === 'true' ? true : normal === 'false' ? false : null,
  };
}

/** {@link resolveServiceScope} over a route's `serviceId` / `service` pair. An
 *  explicit id wins and costs no round-trip. */
export async function resolveServiceArgs(
  opts: GraphqlOptions,
  layer: string,
  args: ServiceArgs,
): Promise<ServiceScope> {
  if (args.serviceId) return { kind: 'service', serviceId: args.serviceId };
  return resolveServiceScope(opts, layer, args.service, { normal: args.normal });
}

/** {@link resolveRequiredService} over a route's `serviceId` / `service` pair. */
export async function resolveRequiredServiceArgs(
  opts: GraphqlOptions,
  layer: string,
  args: ServiceArgs,
): Promise<ResolvedService> {
  if (args.serviceId) return { kind: 'service', serviceId: args.serviceId };
  return resolveRequiredService(opts, layer, args.service, { normal: args.normal });
}
