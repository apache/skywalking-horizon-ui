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
 * What a graph builder may read of the services it drew — shared by the
 * service map, the instance map and the API dependency graph, so the three
 * cannot disagree.
 *
 * A graph draws every service OAP connects; what the caller's grant decides is
 * which metrics are READ:
 *  - a node's metrics, only for a service the caller may read;
 *  - a call's metrics, when the caller reads either end — but an expression
 *    reads its metric's own scope, so a call read through its destination
 *    alone runs only relation-metric expressions (see metric-scopes.ts);
 *  - a `baseline`, which OAP resolves by the service name, only where every
 *    service of the name it is sent with (a node's, a call source's) is
 *    readable.
 * A service OAP could not say the owner of is not read either, and is marked
 * apart from one the caller may not read: an outage, not a refusal.
 */

import type { GraphChecks, GraphReach } from '../../rbac/request-access.js';
import { readsByNameOnly } from '../../rbac/request-access.js';
import type { GraphqlOptions } from '../../client/graphql.js';
import { entityServiceName } from '../services/service-identity.js';
import { relationOnlyExpressions } from './metric-scopes.js';

/** The service a drawn node or call end belongs to. */
export interface GraphOwner {
  id: string;
  name: string;
}

export type WithheldMark = { metricsBlocked?: true; metricsUnavailable?: true };

export interface GraphAccess {
  /** Its values are not read. */
  withheld(owner: GraphOwner): boolean;
  /** How a node, or a call whose ends are all withheld, says so. */
  mark(...owners: GraphOwner[]): WithheldMark;
  /** How a call says its values were not read: both ends withheld, or read
   *  only through its destination while OAP's metric catalog could not be. */
  markCall(source: GraphOwner, target: GraphOwner): WithheldMark;
  /** May `mqe` run for this node? */
  runsOnNode(mqe: string, owner: GraphOwner): boolean;
  /** May `mqe` run for this call? */
  runsOnCall(mqe: string, source: GraphOwner, target: GraphOwner): boolean;
}

const EVERY: GraphAccess = {
  withheld: () => false,
  mark: () => ({}),
  markCall: () => ({}),
  runsOnNode: () => true,
  runsOnCall: () => true,
};

export interface GraphAccessInput {
  opts: GraphqlOptions;
  checks: GraphChecks;
  /** Real nodes, whose metrics would be read. */
  nodes: readonly GraphOwner[];
  calls: ReadonlyArray<{ source: GraphOwner; target: GraphOwner }>;
  nodeMqe: readonly string[];
  callMqe: readonly string[];
}

export async function graphAccess(input: GraphAccessInput): Promise<GraphAccess> {
  const { readableOf, namesReadableOf } = input.checks;
  if (!readableOf) return EVERY;
  const ids = new Set<string>();
  for (const n of input.nodes) ids.add(n.id);
  for (const c of input.calls) {
    ids.add(c.source.id);
    ids.add(c.target.id);
  }
  const reach = await readableOf([...ids]);
  const withheld = (o: GraphOwner): boolean => !reach.readable.has(o.id);
  const open = (source: GraphOwner, target: GraphOwner): boolean => !withheld(source) || !withheld(target);

  const nodeByName = input.nodeMqe.some((m) => readsByNameOnly([m]));
  const callByName = input.callMqe.some((m) => readsByNameOnly([m]));
  let names: GraphReach | null = null;
  if (namesReadableOf && (nodeByName || callByName)) {
    const wanted = [
      ...(nodeByName ? input.nodes.filter((n) => !withheld(n)).map((n) => n.name) : []),
      ...(callByName ? input.calls.filter((c) => open(c.source, c.target)).map((c) => c.source.name) : []),
    ];
    names = await namesReadableOf(wanted);
  }
  const nameReadable = (name: string): boolean => names === null || names.readable.has(entityServiceName(name));

  const throughDestination = input.calls.some((c) => withheld(c.source) && !withheld(c.target));
  const relationOnly = throughDestination ? await relationOnlyExpressions(input.opts, input.callMqe) : new Set<string>();

  const mark = (...owners: GraphOwner[]): WithheldMark => {
    if (!owners.every(withheld)) return {};
    return owners.some((o) => reach.unavailable.has(o.id)) ? { metricsUnavailable: true } : { metricsBlocked: true };
  };
  return {
    withheld,
    mark,
    markCall(source, target) {
      if (withheld(source) && withheld(target)) return mark(source, target);
      return withheld(source) && relationOnly === null && input.callMqe.length > 0 ? { metricsUnavailable: true } : {};
    },
    runsOnNode: (mqe, owner) => !withheld(owner) && (!readsByNameOnly([mqe]) || nameReadable(owner.name)),
    runsOnCall(mqe, source, target) {
      if (withheld(source) && (withheld(target) || !relationOnly?.has(mqe))) return false;
      return !readsByNameOnly([mqe]) || nameReadable(source.name);
    },
  };
}
