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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import type { NodeSlice, SessionResponse } from '@skywalking-horizon-ui/api-client';

const session = vi.fn();
const startCall = vi.fn();
vi.mock('@/api/client', () => ({
  bff: { liveDebug: { session: (...args: unknown[]) => session(...args), start: (...args: unknown[]) => startCall(...args) } },
  describeApiError: (err: unknown) => String(err),
}));

const { useDebugSession, runningCaptures } = await import('./useDebugSession');

const node = (status: NodeSlice['status'], records: number): NodeSlice => ({
  nodeId: 'n',
  status,
  captured: status === 'captured',
  records: Array.from({ length: records }, (_, i) => ({ startedAtMs: 1, captureTime: `1.00000${i}`, dsl: '', rule: { ruleName: 'r' } })),
});
const page = (status: NodeSlice['status'], records: number, complete = false): SessionResponse => ({
  sessionId: 's-1',
  capturedAt: 1,
  nextCapturedSince: '9.000000',
  complete,
  nodes: [node(status, records)],
});

describe('useDebugSession reading a finished capture', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    session.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('reads until OAP says the capture is read through, however long its nodes take', async () => {
    // Every node reached its cap, but a node whose clock runs behind held a record back for a few reads.
    session
      .mockResolvedValueOnce(page('captured', 2))
      .mockResolvedValueOnce(page('captured', 0))
      .mockResolvedValueOnce(page('captured', 0))
      .mockResolvedValueOnce(page('captured', 1, true));
    const scope = effectScope();
    const dbg = scope.run(() => useDebugSession('tal'))!;

    dbg.resume('s-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(dbg.state.value, 'every node is done, but the read is not through').toBe('capturing');

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1500);
    expect(dbg.state.value, 'two empty reads prove nothing').toBe('capturing');

    await vi.advanceTimersByTimeAsync(1500);
    expect(dbg.state.value).toBe('captured');
    expect(dbg.session.value?.nodes[0]!.records, 'the record held back is in').toHaveLength(3);
    expect(session).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(5000);
    expect(session, 'read through: no more reads').toHaveBeenCalledTimes(4);
    scope.stop();
  });
});

describe('useDebugSession resuming a saved capture', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    session.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('reads on from the point the capture was saved at, keeping what a node that does not answer now captured', async () => {
    const rec = (t: string) => ({ startedAtMs: 1, captureTime: t, dsl: '', rule: { ruleName: 'r' } });
    const saved: SessionResponse = {
      sessionId: 's-1',
      capturedAt: 1,
      nextCapturedSince: '5.000000',
      nodes: [
        { instanceId: 'a', status: 'ok', records: [rec('1.000001')] },
        { instanceId: 'b', peer: 'oap-b:17129', status: 'ok', records: [rec('2.000001')] },
      ],
    };
    session.mockResolvedValueOnce({
      sessionId: 's-1',
      capturedAt: 2,
      nextCapturedSince: '6.000000',
      nodes: [
        { instanceId: 'a', status: 'ok', records: [rec('5.500000')] },
        { peer: 'oap-b:17129', status: 'unreachable', records: [] },
      ],
    } satisfies SessionResponse);
    const scope = effectScope();
    const dbg = scope.run(() => useDebugSession('tal'))!;

    dbg.resume('s-1', null, saved);
    await vi.advanceTimersByTimeAsync(0);

    expect(session).toHaveBeenCalledWith('s-1', { capturedSince: '5.000000' });
    expect(dbg.session.value?.nodes.map((n) => [n.instanceId, n.status, n.records.length])).toEqual([
      ['a', 'ok', 2],
      ['b', 'unreachable', 1],
    ]);
    scope.stop();
  });
});

describe('useDebugSession on a tab hidden and shown again', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    session.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('reads again when the tab comes back, though it hid while a read waited on its timer', async () => {
    session.mockResolvedValue(page('ok', 0));
    const scope = effectScope();
    const dbg = scope.run(() => useDebugSession('tal'))!;
    dbg.resume('s-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(dbg.state.value).toBe('capturing');
    expect(session).toHaveBeenCalledTimes(1);

    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(session, 'no read while the tab is hidden').toHaveBeenCalledTimes(1);

    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(session, 'the capture reads on').toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(session.mock.calls.length, 'and keeps polling').toBeGreaterThan(2);
    hidden.mockRestore();
    scope.stop();
  });
});

describe('useDebugSession on a tab hidden while a read is in flight', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    session.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('starts no second read of the same page when the tab comes back', async () => {
    session.mockResolvedValueOnce(page('ok', 1));
    const scope = effectScope();
    const dbg = scope.run(() => useDebugSession('tal'))!;
    dbg.resume('s-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(session).toHaveBeenCalledTimes(1);

    // The next read fires and waits on OAP.
    let answer: (value: SessionResponse) => void = () => undefined;
    session.mockImplementationOnce(() => new Promise<SessionResponse>((resolve) => (answer = resolve)));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(session).toHaveBeenCalledTimes(2);

    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(session, 'the read in flight is the only one').toHaveBeenCalledTimes(2);

    session.mockResolvedValue(page('ok', 0));
    answer(page('ok', 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(dbg.session.value?.nodes[0]!.records, 'each page once').toHaveLength(2);
    hidden.mockRestore();
    scope.stop();
  });
});

describe('useDebugSession keeping what a capture runs with', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    session.mockReset();
    session.mockResolvedValue(page('ok', 0));
    startCall.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('keeps a start’s arguments with its id, and a resumed capture’s settings, the form left out of both', async () => {
    const scope = effectScope();
    const dbg = scope.run(() => useDebugSession('mal'))!;
    startCall.mockResolvedValueOnce({ sessionId: 's-1' });
    const args = { catalog: 'otel-rules' as const, name: 'vm', ruleName: 'alpha', recordCap: 10 };
    const started = dbg.start(args);
    args.ruleName = 'beta';
    await started;
    expect(dbg.sessionId.value).toBe('s-1');
    expect(dbg.startedWith.value?.ruleName, 'what was submitted').toBe('alpha');

    dbg.resume('s-2', null, null, { catalog: 'otel-rules', name: 'vm', ruleName: 'gamma' });
    expect(dbg.startedWith.value?.ruleName).toBe('gamma');
    dbg.resume('s-3');
    expect(dbg.startedWith.value, 'not known for a capture resumed without its settings').toBeNull();

    startCall.mockRejectedValueOnce(new Error('down'));
    await dbg.start(args);
    expect(dbg.startedWith.value, 'a start that failed runs nothing').toBeNull();
    scope.stop();
  });
});

describe('runningCaptures', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    session.mockReset();
    session.mockResolvedValue(page('ok', 0));
    startCall.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('lists a tab while its capture runs, until it is captured or the tab goes', async () => {
    const scope = effectScope();
    const mal = scope.run(() => useDebugSession('mal'))!;
    const tal = scope.run(() => useDebugSession('tal'))!;
    expect(runningCaptures.value).toEqual([]);
    startCall.mockResolvedValueOnce({ sessionId: 's-1' });
    await tal.start({ catalog: 'tal', name: 'f', ruleName: 'r' });
    mal.resume('s-2');
    await vi.advanceTimersByTimeAsync(0);
    expect(runningCaptures.value, 'in tab order').toEqual(['mal', 'tal']);

    session.mockImplementation(async (id: string) =>
      id === 's-2' ? { ...page('captured', 0, true), sessionId: 's-2' } : page('ok', 0));
    await vi.advanceTimersByTimeAsync(2000);
    expect(mal.state.value).toBe('captured');
    expect(runningCaptures.value, 'a captured one reads no more').toEqual(['tal']);
    scope.stop();
    expect(runningCaptures.value, 'nor one whose tab is gone').toEqual([]);
  });
});

describe('useDebugSession resuming a capture saved from an OAP before paged reads', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    session.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  // As OAP 11.1 answers: the whole capture, with no point to read on from.
  const whole = (records: number): SessionResponse => ({ sessionId: 's-1', capturedAt: 1, nodes: [node('captured', records)] });

  it('reads it again whole while OAP has it, and shows the saved copy once OAP no longer has it', async () => {
    const scope = effectScope();
    const dbg = scope.run(() => useDebugSession('oal'))!;

    session.mockResolvedValueOnce(whole(3));
    dbg.resume('s-1', null, whole(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(dbg.session.value?.nodes[0]!.records, 'OAP\u2019s whole capture').toHaveLength(3);

    // Stopped, or past its retention: OAP answers 404.
    session.mockResolvedValue(null);
    dbg.resume('s-1', null, whole(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(dbg.state.value).toBe('captured');
    expect(dbg.session.value?.nodes[0]!.records, 'what Capture history saved').toHaveLength(2);
    scope.stop();
  });

  it('keeps what a node that did not answer the read captured, from the saved copy on a resume', async () => {
    const scope = effectScope();
    const dbg = scope.run(() => useDebugSession('oal'))!;
    const records = (n: number) => node('captured', n).records;
    const saved: SessionResponse = { sessionId: 's-1', capturedAt: 1, nodes: [
      { nodeId: '0.0.0.0_11800', status: 'ok', records: [] },
      { peer: '10.0.0.6:11800', nodeId: '0.0.0.0_11800', status: 'captured', captured: true, records: records(2) },
    ] };
    // The peer times out: OAP 11.1 answers it as an empty slice.
    session.mockResolvedValueOnce({ sessionId: 's-1', capturedAt: 2, nodes: [
      { nodeId: '0.0.0.0_11800', status: 'captured', captured: true, records: records(3) },
      { peer: '10.0.0.6:11800', status: 'unreachable', records: [] },
    ] });
    dbg.resume('s-1', null, saved);
    await vi.advanceTimersByTimeAsync(0);
    expect(dbg.session.value?.nodes.map((n) => n.records.length), 'the peer keeps the two saved').toEqual([3, 2]);
    scope.stop();
  });
});
