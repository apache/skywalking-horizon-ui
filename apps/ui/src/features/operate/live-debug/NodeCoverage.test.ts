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

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { NodeSlice } from '@skywalking-horizon-ui/api-client';
import { i18n } from '@/i18n';
import NodeCoverage from './NodeCoverage.vue';
import { byNode, nodeKey, nodeLabel } from './nodeIdentity';
import { coverageRows } from './nodeCoverage';

/** OAP's default node id, the same on every node that binds 0.0.0.0. */
const SHARED = '0.0.0.0_11800';

const slice = (over: Partial<NodeSlice>): NodeSlice =>
  ({ nodeId: SHARED, status: 'ok', records: [], totalBytes: 0, ...over }) as NodeSlice;

const rows = (w: ReturnType<typeof mount>) =>
  w.findAll('.cov__row').map((r) =>
    Array.from(r.element.querySelectorAll('.cov__nodeid, .cov__label, .cov__pair > :last-child'))
      .map((e) => (e.textContent ?? '').trim())
      .join(' '),
  );

describe('nodeIdentity', () => {
  it('tells apart the nodes that share a node id, by instance id, else by address', () => {
    const a = slice({ instanceId: 'i-a', peer: '10.0.0.1:17129' });
    const b = slice({ instanceId: 'i-b' });
    expect(nodeKey(a)).not.toBe(nodeKey(b));
    expect(nodeKey(slice({ peer: '10.0.0.2:17129' }))).toBe('peer:10.0.0.2:17129');
    expect(nodeKey(slice({}))).toBe(`node:${SHARED}`);
    expect(nodeLabel(a)).toBe('10.0.0.1:17129');
    expect(nodeLabel(b), 'the node serving a read names itself by its node id').toBe(SHARED);
    expect([b, a].sort(byNode).map(nodeLabel)).toEqual([SHARED, '10.0.0.1:17129']);
  });
});

describe('NodeCoverage', () => {
  it('lists each node of a cluster whose nodes share a node id, the one that took the start installed', () => {
    const w = mount(NodeCoverage, {
      props: {
        peerAcks: [
          { peer: '10.0.0.2:17129', nodeId: SHARED, ack: 'INSTALLED' },
          { peer: '10.0.0.3:17129', nodeId: SHARED, ack: 'INSTALLED' },
        ],
        nodeStatuses: [
          slice({ instanceId: 'i-a' }),
          slice({ instanceId: 'i-b', peer: '10.0.0.2:17129', status: 'captured' }),
          slice({ instanceId: 'i-c', peer: '10.0.0.3:17129' }),
        ],
        installed: { created: 3, total: 3 },
        priorCleanup: null,
      },
      global: { plugins: [i18n] },
    });
    expect(rows(w)).toEqual([
      `${SHARED} recorder installed last read answered`,
      '10.0.0.2:17129 recorder installed last read cap reached',
      '10.0.0.3:17129 recorder installed last read answered',
    ]);
  });

  it('keeps the node that took the start installed once a read behind a load balancer names its address', () => {
    // Node A took the start; a later read served by B reached A at its address, which the merge kept.
    const w = mount(NodeCoverage, {
      props: {
        peerAcks: [{ peer: '10.0.0.2:17129', nodeId: SHARED, ack: 'INSTALLED' }],
        nodeStatuses: [
          slice({ instanceId: 'i-a', peer: '10.0.0.1:17129' }),
          slice({ instanceId: 'i-b', peer: '10.0.0.2:17129' }),
        ],
        installed: { created: 2, total: 2 },
        priorCleanup: null,
      },
      global: { plugins: [i18n] },
    });
    expect(rows(w)).toEqual([
      '10.0.0.1:17129 recorder installed last read answered',
      '10.0.0.2:17129 recorder installed last read answered',
    ]);
  });
});

describe('coverageRows', () => {
  const A = '10.0.0.1:17129';
  const B = '10.0.0.2:17129';
  const C = '10.0.0.3:17129';
  const ack = (peer: string, nodeId = SHARED) => ({ peer, nodeId, ack: 'INSTALLED' as const });
  /** Each row as `label install/collect`, the node that took the start marked `*`. */
  const show = (acks: Parameters<typeof coverageRows>[0], reads: NodeSlice[], startNodeId?: string) =>
    coverageRows(acks, reads, startNodeId).map((r) => `${r.startedHere ? '*' : ''}${r.label} ${r.install ?? '-'}/${r.collect ?? '-'}`);

  it.each([
    {
      shape: 'standalone',
      acks: [],
      reads: [slice({ instanceId: 'i-a' })],
      rows: [`*${SHARED} -/ok`],
    },
    {
      shape: 'a cluster read through the node that took the start',
      acks: [ack(B)],
      reads: [slice({ instanceId: 'i-a' }), slice({ instanceId: 'i-b', peer: B })],
      rows: [`*${SHARED} -/ok`, `${B} INSTALLED/ok`],
    },
    {
      shape: 'a load balancer sending the first read to the other node, node ids shared',
      acks: [ack(B)],
      reads: [slice({ instanceId: 'i-a', peer: A }), slice({ instanceId: 'i-b', status: 'captured' })],
      rows: [`*${A} -/ok`, `${B} INSTALLED/captured`],
    },
    {
      shape: 'the same with distinct node ids',
      acks: [ack(B, 'b')],
      reads: [slice({ nodeId: 'a', instanceId: 'i-a', peer: A }), slice({ nodeId: 'b', instanceId: 'i-b' })],
      rows: [`*${A} -/ok`, `${B} INSTALLED/ok`],
    },
    {
      shape: 'three nodes, read through a peer of the starting node',
      acks: [ack(B), ack(C)],
      reads: [slice({ instanceId: 'i-a', peer: A }), slice({ instanceId: 'i-b' }), slice({ instanceId: 'i-c', peer: C })],
      rows: [`*${A} -/ok`, `${B} INSTALLED/ok`, `${C} INSTALLED/ok`],
    },
    {
      shape: 'an acked node no read lists, beside the starting node, node ids distinct',
      acks: [ack(B, 'b')],
      reads: [slice({ nodeId: 'a', instanceId: 'i-a' })],
      rows: [`${B} INSTALLED/-`, '*a -/ok'],
    },
    {
      shape: 'a resumed session (no acks), the start named by its node id',
      acks: [],
      reads: [slice({ nodeId: 'a', instanceId: 'i-a' }), slice({ nodeId: 'b', instanceId: 'i-b', peer: B })],
      startNodeId: 'a',
      rows: [`${B} -/ok`, '*a -/ok'],
    },
  ])('$shape', ({ acks, reads, startNodeId, rows }) => {
    expect(show(acks, reads, startNodeId)).toEqual(rows);
  });
});

