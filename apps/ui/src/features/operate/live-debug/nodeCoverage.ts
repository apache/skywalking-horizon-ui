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
 * The per-node coverage of a debug session: which OAP nodes recorded it, and how each answered the latest read.
 *
 * Two answers name the nodes, and differently. The start's install acks name every peer of the node that took the
 * start by its address, and never that node itself, which installs the session and reports it in the summary. A
 * read names every node by its identity (`nodeIdentity`) and, but for the node serving the read, by its address too;
 * behind a load balancer that is any node, read after read, and the session merge keeps an address once a read gave
 * it. The rows below are the nodes the two agree on.
 */

import type { NodeSlice, PeerInstallAck } from '@skywalking-horizon-ui/api-client';
import { nodeKey, nodeLabel } from './nodeIdentity.js';

export interface CoverageRow {
  key: string;
  label: string;
  install: PeerInstallAck['ack'] | null;
  collect: NodeSlice['status'] | null;
  /** The node that took the start: it sent no ack, and installed the session itself. */
  startedHere: boolean;
}

interface Building extends CoverageRow {
  peer?: string;
  nodeId?: string;
}

/**
 * @param acks the start's install acks, one per peer of the node that took it
 * @param reads the nodes of the session as read so far
 * @param startNodeId the node id the start reported for itself, to tell that node apart only when no other way does
 */
export function coverageRows(
  acks: readonly PeerInstallAck[],
  reads: readonly NodeSlice[],
  startNodeId?: string,
): CoverageRow[] {
  // Every node a read lists is a row.
  const rows: Building[] = reads.map((n) => ({
    key: nodeKey(n),
    label: nodeLabel(n),
    peer: n.peer,
    nodeId: n.nodeId,
    install: null,
    collect: n.status,
    startedHere: false,
  }));

  // An ack joins the row read at its address.
  const unmatched: PeerInstallAck[] = [];
  for (const ack of acks) {
    const row = rows.find((r) => r.peer !== undefined && r.peer === ack.peer && r.install === null);
    if (row) row.install = ack.ack;
    else unmatched.push(ack);
  }

  // The node serving a read lists itself without an address. When a load balancer sent the read to a node other than
  // the one that took the start, that node is one the acks name: the one ack no address matched is the one row read
  // without an address — unless their node ids say they are two nodes.
  const unaddressed = rows.filter((r) => r.peer === undefined);
  if (unmatched.length === 1 && unaddressed.length === 1) {
    const [ack, row] = [unmatched[0]!, unaddressed[0]!];
    if (!(ack.nodeId && row.nodeId && ack.nodeId !== row.nodeId)) {
      row.install = ack.ack;
      row.label = ack.peer;
      unmatched.length = 0;
    }
  }

  // An ack whose node no read lists yet is a row of its own.
  for (const ack of unmatched) {
    rows.push({ key: `peer:${ack.peer}`, label: ack.peer, peer: ack.peer, nodeId: ack.nodeId, install: ack.ack, collect: null, startedHere: false });
  }

  // The node that took the start is the one row no ack names. Should more be left, as a node that joined after the
  // start, it is the one carrying the node id the start reported, when only one does.
  const unacked = rows.filter((r) => r.install === null);
  const byStartId = startNodeId ? unacked.filter((r) => r.nodeId === startNodeId) : [];
  const start = unacked.length === 1 ? unacked[0] : byStartId.length === 1 ? byStartId[0] : undefined;
  if (start) start.startedHere = true;

  return rows
    .map(({ key, label, install, collect, startedHere }) => ({ key, label, install, collect, startedHere }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}
