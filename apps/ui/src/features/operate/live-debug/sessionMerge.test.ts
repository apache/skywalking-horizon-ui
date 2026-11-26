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
import type { NodeSlice, SessionRecord, SessionResponse } from '@skywalking-horizon-ui/api-client';
import { mergeSessionPage, mergeWholeRead, pageHasRecords } from './sessionMerge';

const record = (captureTime: string): SessionRecord => ({ startedAtMs: 1, captureTime, dsl: '', rule: { ruleName: 'r' } });

const page = (nodes: NodeSlice[], next = '1.000009'): SessionResponse => ({
  sessionId: 's-1',
  capturedAt: 1,
  nextCapturedSince: next,
  nodes,
});

describe('mergeSessionPage', () => {
  it('takes the first page as it is', () => {
    const first = page([{ nodeId: 'n', status: 'ok', records: [record('1.000001')] }]);
    expect(mergeSessionPage(null, first)).toBe(first);
  });

  it('appends each node’s new records and takes its latest status', () => {
    const held = page([
      { nodeId: '0.0.0.0_11800', status: 'ok', records: [record('1.000001')] },
      { nodeId: '0.0.0.0_11800', peer: 'oap1:17129', status: 'ok', records: [record('1.000002')] },
    ]);
    const next = page([
      { nodeId: '0.0.0.0_11800', status: 'captured', captured: true, records: [record('1.000003')] },
      { nodeId: '0.0.0.0_11800', peer: 'oap1:17129', status: 'ok', records: [] },
    ]);

    const merged = mergeSessionPage(held, next);

    expect(merged.nodes.map((n) => n.records.map((r) => r.captureTime))).toEqual([
      ['1.000001', '1.000003'],
      ['1.000002'],
    ]);
    expect(merged.nodes[0].status).toBe('captured');
    expect(merged.nextCapturedSince).toBe('1.000009');
  });

  it('folds a page another node served, behind a load balancer, into the nodes the view holds', () => {
    // Read 1 served by oap-a: it is the peerless slice, oap-b its peer. Read 2 served by oap-b: the other way round.
    const held = page([
      { nodeId: 'same', instanceId: 'a', status: 'ok', records: [record('1.000001')] },
      { nodeId: 'same', instanceId: 'b', peer: 'oap-b:17129', status: 'ok', records: [record('1.000002')] },
    ]);
    const next = page([
      { nodeId: 'same', instanceId: 'b', status: 'captured', captured: true, records: [record('1.000004')] },
      { nodeId: 'same', instanceId: 'a', peer: 'oap-a:17129', status: 'ok', records: [record('1.000003')] },
    ]);

    const merged = mergeSessionPage(held, next);

    expect(merged.nodes.map((n) => [n.instanceId, n.peer, n.records.map((r) => r.captureTime), n.status])).toEqual([
      ['a', 'oap-a:17129', ['1.000001', '1.000003'], 'ok'],
      ['b', 'oap-b:17129', ['1.000002', '1.000004'], 'captured'],
    ]);
  });

  it('keeps a node that replaced another, as in a rolling restart, apart from the one it replaced', () => {
    const held = page([
      { instanceId: 'a', status: 'ok', records: [record('1.000001')] },
      { instanceId: 'b', peer: 'oap-b:17129', status: 'ok', records: [record('1.000002')] },
    ]);
    const next = page([
      { instanceId: 'a', status: 'ok', records: [record('1.000004')] },
      { instanceId: 'c', peer: 'oap-c:17129', status: 'ok', records: [record('1.000003')] },
    ]);

    expect(mergeSessionPage(held, next).nodes.map((n) => [n.instanceId, n.records.map((r) => r.captureTime)])).toEqual([
      ['a', ['1.000001', '1.000004']],
      ['b', ['1.000002']],
      ['c', ['1.000003']],
    ]);
  });

  it('takes a node that did not answer as the node last seen at its address', () => {
    const held = page([
      { instanceId: 'a', status: 'ok', records: [record('1.000001')] },
      { instanceId: 'b', nodeId: 'same', peer: 'oap-b:17129', status: 'ok', records: [record('1.000002')] },
    ]);
    const next = page([
      { instanceId: 'a', status: 'ok', records: [] },
      { peer: 'oap-b:17129', status: 'unreachable', detail: 'timeout', records: [] },
    ]);

    const merged = mergeSessionPage(held, next);
    expect(merged.nodes).toHaveLength(2);
    expect(merged.nodes[1]).toMatchObject({ instanceId: 'b', nodeId: 'same', status: 'unreachable' });
    expect(merged.nodes[1]!.records).toHaveLength(1);
  });

  it('names a node that did not answer the first read once it answers', () => {
    const held = page([
      { instanceId: 'a', status: 'ok', records: [record('1.000001')] },
      { peer: 'oap-b:17129', status: 'unreachable', detail: 'timeout', records: [] },
    ]);
    const next = page([
      { instanceId: 'a', status: 'ok', records: [] },
      { instanceId: 'b', peer: 'oap-b:17129', status: 'ok', records: [record('1.000002')] },
    ]);

    const merged = mergeSessionPage(held, next);
    expect(merged.nodes.map((n) => [n.instanceId, n.status, n.records.length])).toEqual([
      ['a', 'ok', 1],
      ['b', 'ok', 1],
    ]);
  });

  it('drops a node known only by its address once a node names itself there, whichever read named it first', () => {
    // Read 1, served by a: b did not answer. Read 2, served by b, which names itself without its address.
    const first = page([
      { instanceId: 'a', status: 'ok', records: [record('1.000001')] },
      { peer: 'oap-b:17129', status: 'unreachable', detail: 'timeout', records: [] },
    ]);
    const second = mergeSessionPage(first, page([
      { instanceId: 'b', status: 'ok', records: [record('1.000002')] },
      { instanceId: 'a', peer: 'oap-a:17129', status: 'ok', records: [] },
    ]));
    // Read 3, served by a again, names b with its address.
    const third = mergeSessionPage(second, page([
      { instanceId: 'a', status: 'ok', records: [] },
      { instanceId: 'b', peer: 'oap-b:17129', status: 'ok', records: [record('1.000003')] },
    ]));

    expect(third.nodes.map((n) => [n.instanceId, n.peer, n.status, n.records.length])).toEqual([
      ['a', 'oap-a:17129', 'ok', 1],
      ['b', 'oap-b:17129', 'ok', 2],
    ]);
  });

  it('keeps two nodes apart though they report the same node id', () => {
    const held = page([{ nodeId: 'same', instanceId: 'a', status: 'ok', records: [record('1.000001')] }]);
    const next = page([{ nodeId: 'same', instanceId: 'b', peer: 'oap2:17129', status: 'ok', records: [record('1.000002')] }]);
    expect(mergeSessionPage(held, next).nodes).toHaveLength(2);
  });

  it('keeps a node the page did not mention, records and all', () => {
    const held = page([{ peer: 'oap1:17129', status: 'ok', records: [record('1.000001')] }]);
    const next = page([]);
    expect(mergeSessionPage(held, next).nodes[0].records).toHaveLength(1);
  });

  it('starts over for another session', () => {
    const held = page([{ nodeId: 'n', status: 'ok', records: [record('1.000001')] }]);
    const other = { ...page([]), sessionId: 's-2' };
    expect(mergeSessionPage(held, other)).toBe(other);
  });
});

describe('pageHasRecords', () => {
  it('tells a page that brought records from an empty one', () => {
    expect(pageHasRecords(page([{ nodeId: 'n', status: 'ok', records: [record('1.000001')] }]))).toBe(true);
    expect(pageHasRecords(page([{ nodeId: 'n', status: 'ok', records: [] }]))).toBe(false);
  });

  it('drops the placeholder of a node a read could not reach, once that node serves a read and names itself', () => {
    const held: SessionResponse = {
      sessionId: 's',
      capturedAt: 1,
      nodes: [
        { instanceId: 'a', status: 'ok', records: [] },
        { peer: 'oap-b:17129', status: 'unreachable', records: [] },
      ],
    };
    const page: SessionResponse = {
      sessionId: 's',
      capturedAt: 2,
      nodes: [
        { instanceId: 'b', status: 'captured', records: [] },
        { instanceId: 'a', peer: 'oap-a:17129', status: 'ok', records: [] },
      ],
    };
    const merged = mergeSessionPage(held, page);
    expect(merged.nodes.map((n) => [n.instanceId ?? null, n.peer ?? null, n.status])).toEqual([
      ['a', 'oap-a:17129', 'ok'],
      ['b', null, 'captured'],
    ]);
  });
});

describe('mergeWholeRead', () => {
  // As OAP 11.1 answers: the whole capture, the serving node by its node id, each peer by its address.
  const whole = (nodes: NodeSlice[]): SessionResponse => ({ sessionId: 's', capturedAt: 1, nodes });
  const records = (n: number) => Array.from({ length: n }, (_, i) => record(`1.00000${i}`));
  const local = (n: number): NodeSlice => ({ nodeId: '0.0.0.0_11800', status: 'ok', records: records(n) });
  const peer = (n: number, status: NodeSlice['status'] = 'ok'): NodeSlice => ({ peer: '10.0.0.6:11800', status, records: records(n) });

  it('replaces each node that answered with what it brought, as a whole', () => {
    const merged = mergeWholeRead(whole([local(2), peer(1)]), whole([local(3), peer(4)]));
    expect(merged.nodes.map((n) => n.records.length)).toEqual([3, 4]);
  });

  it('keeps what a node that came back empty captured, as a peer that timed out', () => {
    const merged = mergeWholeRead(whole([local(1), peer(2)]), whole([local(3), peer(0, 'unreachable')]));
    expect(merged.nodes.map((n) => n.records.length), 'the peer keeps its two').toEqual([3, 2]);
    expect(merged.nodes[1]!.status, 'and reads as it answered now').toBe('unreachable');
  });

  it('takes the node serving the read as it is, empty or not: behind a load balancer its node id may be another node\u2019s', () => {
    const merged = mergeWholeRead(whole([local(3), peer(1)]), whole([local(0), peer(1)]));
    expect(merged.nodes[0]!.records, 'not the records another node held under the shared id').toHaveLength(0);
  });

  it('drops a node the read does not list, and takes the read as it is for another capture', () => {
    expect(mergeWholeRead(whole([local(1), peer(2)]), whole([local(3)])).nodes).toHaveLength(1);
    expect(mergeWholeRead({ ...whole([peer(2)]), sessionId: 'other' }, whole([peer(0)])).nodes[0]!.records).toHaveLength(0);
  });
});
