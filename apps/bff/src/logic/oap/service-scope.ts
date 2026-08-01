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
    }
  }
`;

/** Resolution for a caller that cannot query without a service — `all` is not
 *  one of the outcomes. */
export type ResolvedService = Exclude<ServiceScope, { kind: 'all' }>;

/** The refusal text a caller reports when resolution came back `unknown`. */
export function unknownServiceMessage(serviceArg: string, layer: string): string {
  return `Unknown service "${serviceArg}" in layer ${layer.toUpperCase()}.`;
}

/**
 * Resolve a service NAME within a layer, through `listServices(layer)`.
 *
 * The argument is a NAME. Nothing here guesses at its shape: an OAP service id
 * is `base64(<name>).<0|1>` (`IDManager.ServiceID.buildId`), which an ordinary
 * name can wear too — `api.1`, `orders.2026` — so a shape test silently turned
 * such a name into an id that resolves to nothing. Callers that hold a real id
 * pass it in its own parameter and never come through here ({@link
 * resolveServiceArgs}). The roster's `id` column is still matched, after the
 * name, so an id handed to the name slot resolves rather than 404s — it just
 * costs the round-trip a caller with an explicit id avoids.
 *
 * Throws whatever the OAP round-trip throws — an unreachable OAP is not the
 * same as an unknown service, and callers report it as the transport failure it
 * is.
 */
export async function resolveServiceScope(
  opts: GraphqlOptions,
  layer: string,
  serviceArg: string | null | undefined,
): Promise<ServiceScope> {
  if (!serviceArg) return { kind: 'all' };
  const data = await graphqlPost<{ services: Array<{ id: string; name: string }> }>(
    opts,
    LIST_SERVICES_FOR_RESOLVE,
    { layer: layer.toUpperCase() },
  );
  const services = data.services ?? [];
  const serviceId =
    services.find((s) => s.name === serviceArg)?.id ?? services.find((s) => s.id === serviceArg)?.id;
  return serviceId
    ? { kind: 'service', serviceId }
    : { kind: 'unknown', serviceArg, message: unknownServiceMessage(serviceArg, layer) };
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
): Promise<ResolvedService> {
  const scope = await resolveServiceScope(opts, layer, serviceArg);
  if (scope.kind === 'all') {
    return { kind: 'unknown', serviceArg: '', message: `No service supplied for layer ${layer.toUpperCase()}.` };
  }
  return scope;
}

/** How a route received its service: as an OAP id, as a name, or not at all.
 *  Keeping the two apart is what removes the guesswork — a UI screen that
 *  already holds the id sends `serviceId`, and only a caller that genuinely has
 *  a name (the AI tools, a hand-written request) sends `service`. */
export interface ServiceArgs {
  /** OAP service id, trusted as an id — no lookup, no shape test. */
  serviceId?: string | null;
  /** Service NAME, resolved against the layer's roster. */
  service?: string | null;
}

/** {@link resolveServiceScope} over a route's `serviceId` / `service` pair. An
 *  explicit id wins and costs no round-trip. */
export async function resolveServiceArgs(
  opts: GraphqlOptions,
  layer: string,
  args: ServiceArgs,
): Promise<ServiceScope> {
  if (args.serviceId) return { kind: 'service', serviceId: args.serviceId };
  return resolveServiceScope(opts, layer, args.service);
}

/** {@link resolveRequiredService} over a route's `serviceId` / `service` pair. */
export async function resolveRequiredServiceArgs(
  opts: GraphqlOptions,
  layer: string,
  args: ServiceArgs,
): Promise<ResolvedService> {
  if (args.serviceId) return { kind: 'service', serviceId: args.serviceId };
  return resolveRequiredService(opts, layer, args.service);
}
