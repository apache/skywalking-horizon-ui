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
 * A paged session read returns only the records captured since the previous
 * read, so the view keeps what it already holds and folds each page in.
 */

import type { NodeSlice, SessionResponse } from '@skywalking-horizon-ui/api-client';
import { nodeKey } from './nodeIdentity.js';


/** Whether a page brought records, so more may be waiting to be read. */
export function pageHasRecords(page: SessionResponse): boolean {
  return page.nodes.some((n) => n.records.length > 0);
}

/**
 * A whole read, from an OAP before paged reads, put over what is held. It replaces what is held node by node: a node it
 * brings back with records replaces the node's records as a whole, while a peer it brings back with none keeps those
 * held for it, for an empty peer slice is a peer that did not answer (OAP 11.1 answers a peer that timed out as an
 * empty slice) and must not erase what that peer captured. The node serving the read always answers, and is taken as
 * it is: behind a load balancer the nodes serving reads may share a node id, so its key may be another node's. A node
 * the read does not list is not kept either, as the node serving a read names itself otherwise than as a peer.
 */
export function mergeWholeRead(held: SessionResponse | null, read: SessionResponse): SessionResponse {
  if (held === null || held.sessionId !== read.sessionId) return read;
  const heldRecords = new Map(held.nodes.map((node) => [nodeKey(node), node.records ?? []]));
  return {
    ...read,
    nodes: read.nodes.map((node) => {
      if (!node.peer || (node.records?.length ?? 0) > 0) return node;
      const before = heldRecords.get(nodeKey(node)) ?? [];
      return before.length > 0 ? { ...node, records: before } : node;
    }),
  };
}

/**
 * The session with one more page folded in: each node's records appended in
 * the order they came, its status, cap flag and size taken from the page,
 * which is the latest. A node the page did not mention keeps what it had. A
 * node that did not answer has no instance id, only its address: it is the
 * node seen last at that address, and a slice known only by its address goes
 * once a node names itself there.
 */
export function mergeSessionPage(held: SessionResponse | null, page: SessionResponse): SessionResponse {
  if (held === null || held.sessionId !== page.sessionId) return page;
  // Held in the order the view learned them, so the last at an address is the newest process seen there.
  const atAddress = new Map<string, string>();
  for (const node of held.nodes) if (node.peer) atAddress.set(node.peer, nodeKey(node));
  const keyOf = (node: NodeSlice): string => {
    const own = nodeKey(node);
    return node.instanceId || !node.peer ? own : atAddress.get(node.peer) ?? own;
  };
  const pageNodes = new Map<string, NodeSlice>();
  for (const node of page.nodes) pageNodes.set(keyOf(node), node);
  const nodes: NodeSlice[] = [];
  for (const node of held.nodes) {
    const key = nodeKey(node);
    const fresh = pageNodes.get(key);
    if (fresh === undefined) {
      // A slice known only by its address and holding nothing is a node an earlier read could not reach. Once a page
      // no longer lists it there, as when that node served the read and named itself without an address, it goes:
      // kept, it would stand beside the node it was as a second one.
      if (!node.instanceId && node.records.length === 0) continue;
      nodes.push(node);
      continue;
    }
    pageNodes.delete(key);
    nodes.push({
      ...fresh,
      // The node serving a read names itself without these; another read named it with them.
      peer: fresh.peer ?? node.peer,
      nodeId: fresh.nodeId ?? node.nodeId,
      instanceId: fresh.instanceId ?? node.instanceId,
      records: [...node.records, ...fresh.records],
    });
  }
  nodes.push(...pageNodes.values());
  const named = new Set(nodes.filter((n) => n.instanceId && n.peer).map((n) => n.peer));
  return {
    ...page,
    ruleKey: page.ruleKey ?? held.ruleKey,
    nodes: nodes.filter((n) => n.instanceId || !n.peer || !named.has(n.peer)),
  };
}
