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
 * The tools' side of the layer grants: the same questions the HTTP scope gate
 * asks, for tools that read OAP directly. A tool checks BEFORE it reads and
 * before it emits a figure — a captured figure replays from its payload and
 * never passes back through a route that could check it.
 */

import type { ToolContext } from '../tool-context.js';
import { isExactIdentity, type ServiceRef } from '../../../rbac/request-access.js';

/** The verb gate a tool opens with: held plainly, or on some layer. Which
 *  layer and which service is decided once the tool knows them. */
export function holds(ctx: ToolContext, verb: string): boolean {
  return ctx.access ? ctx.access.session.holds(verb) : ctx.hasVerb(verb);
}

/** The denial every tool answers with — the chat activity line marks a tool
 *  "denied" only when its output starts with `Permission denied:`. */
export function denied(verb: string, what = ''): string {
  return `Permission denied: the current user lacks ${verb}${what ? ` on ${what}` : ''}.`;
}

/** What a tool answers for a service name or id OAP would not read as
 *  written — see {@link isExactIdentity}. Null when it is exact. */
export function inexact(value: string | undefined, what = 'the service', source = 'list_services'): string | null {
  return value !== undefined && isExactIdentity(value) ? null : `Name ${what} exactly as ${source} returns it.`;
}

export type ReadDecision = 'allow' | 'deny' | 'unavailable';

export async function decide(ctx: ToolContext, verb: string, ref: ServiceRef): Promise<ReadDecision> {
  return ctx.access ? ctx.access.decide([verb], ref) : 'allow';
}

/** An OAP that could not say who owns a service is an outage, not a refusal —
 *  the model must not tell the operator they lack a permission they hold. */
export function unverifiable(what: string): string {
  return `OAP did not answer which layer ${what} belongs to, so it cannot be read right now. This is not a permission problem; try again shortly.`;
}

/** A caller holding `verb` plainly is told a name is unknown, as before layer
 *  grants existed; a layer-limited one gets one answer for "no such service"
 *  and "not yours", so a refusal does not confirm another team's service. */
export function tellsUnknownApart(ctx: ToolContext, verb: string): boolean {
  return !ctx.access || !ctx.access.layerLimited([verb]);
}

export function noReadableService(verb: string, layer: string, name: string): string {
  return `Permission denied: layer ${layer.toUpperCase()} has no service "${name}" the current user may read with ${verb}. list_services shows the ones it can.`;
}

/** The roster row named `name`, when the caller may read it; otherwise what
 *  the tool answers — see {@link tellsUnknownApart}. */
export async function readableRow<T extends { id: string; name: string }>(
  ctx: ToolContext,
  verb: string,
  layer: string,
  name: string,
  rows: readonly T[],
): Promise<{ row: T } | { answer: string }> {
  const row = rows.find((s) => s.name === name);
  if (!row) {
    return {
      answer: tellsUnknownApart(ctx, verb)
        ? `Unknown service "${name}" in layer ${layer}. Use list_services first.`
        : noReadableService(verb, layer, name),
    };
  }
  const d = await decide(ctx, verb, { id: row.id });
  if (d === 'allow') return { row };
  return { answer: d === 'unavailable' ? unverifiable(`service ${name}`) : noReadableService(verb, layer, name) };
}

/** Null when the caller may read `ref`; otherwise what the tool answers. */
export async function refusal(ctx: ToolContext, verb: string, ref: ServiceRef, what: string): Promise<string | null> {
  const d = await decide(ctx, verb, ref);
  return d === 'allow' ? null : d === 'unavailable' ? unverifiable(what) : denied(verb, what);
}

/** The graph block to draw for the caller — see `RequestAccess.graphConfig`. */
export async function graphConfig<T>(ctx: ToolContext, verb: string, focusIds: readonly string[], cfg: T): Promise<T> {
  return ctx.access ? ctx.access.graphConfig([verb], focusIds, cfg) : cfg;
}

/** Keep the rows of `layer` the caller may read with `verb`. */
export function readableRows<T extends { group?: string | null }>(
  ctx: ToolContext,
  verb: string,
  layer: string,
  rows: T[],
): T[] {
  return ctx.access ? ctx.access.filterRoster([verb], layer, rows) : rows;
}

/** A whole-deployment read (a store with no service scoping, alarms with no
 *  entity): only for a caller who holds the verb with no layer limit. */
export function readsEverything(ctx: ToolContext, verb: string): boolean {
  return ctx.access ? ctx.access.plain(verb) : ctx.hasVerb(verb);
}
