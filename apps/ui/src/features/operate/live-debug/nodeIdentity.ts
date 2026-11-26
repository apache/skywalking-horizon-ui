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
 * How the live debugger tells the OAP nodes of a session apart, on every tab. A node id repeats across the nodes that
 * bind 0.0.0.0 (`0.0.0.0_11800` by default), so it cannot key a node: each OAP process names itself by an instance id
 * (OAP 11.2 and later), else a node is known by the address a read reached it at; the node that served a read gives
 * no address. Keyed by node id, a whole cluster would read as one node, its records mixed.
 */

interface NodeNames {
  instanceId?: string;
  peer?: string;
  nodeId?: string;
}

/** The node's identity in a session: its instance id, else its address, else its node id. */
export function nodeKey(node: NodeNames): string {
  if (node.instanceId) return `instance:${node.instanceId}`;
  if (node.peer) return `peer:${node.peer}`;
  return node.nodeId ? `node:${node.nodeId}` : 'local';
}

/** The node as the debugger names it: its address, else its node id. */
export function nodeLabel(node: NodeNames): string {
  return node.peer ?? node.nodeId ?? 'local';
}

/** Nodes in the order the debugger lists them: by name, then by identity, so each card keeps its place. */
export function byNode(a: NodeNames, b: NodeNames): number {
  return nodeLabel(a).localeCompare(nodeLabel(b)) || nodeKey(a).localeCompare(nodeKey(b));
}
