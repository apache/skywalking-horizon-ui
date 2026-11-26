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
import type { PairingsResponse } from '@skywalking-horizon-ui/api-client';

const pairings = vi.fn();
const start = vi.fn();
const stop = vi.fn();
vi.mock('@/api/client', () => ({
  bff: {
    otlpPairing: {
      pairings: (...args: unknown[]) => pairings(...args),
      start: (...args: unknown[]) => start(...args),
      stop: (...args: unknown[]) => stop(...args),
    },
  },
  describeApiError: (err: unknown) => String(err),
  BffApiError: class BffApiError extends Error {
    constructor(readonly status: number) {
      super(`HTTP ${status}`);
    }
  },
}));

const { useOtlpPairing } = await import('./useOtlpPairing');
const { resetPairingRoundsCache, usePairingRounds } = await import('./pairingRounds');

const capturing = {
  state: 'capturing',
  roundId: 'r1',
  startTime: 1,
  lastReadTime: 1,
  idleMillis: 60_000,
  received: {},
  matched: 0,
  unmatched: {},
  matchedPeers: [],
  unmatchedPeers: [],
  unmatchedServers: [],
  nodes: [{ status: 'ok', state: 'capturing', roundId: 'r1' }],
} as PairingsResponse;

describe('useOtlpPairing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pairings.mockReset();
    start.mockReset();
    stop.mockReset();
    localStorage.clear();
    resetPairingRoundsCache();
  });
  afterEach(() => vi.useRealTimers());

  it('reads every two seconds while the capture runs, and never again once the page is gone', async () => {
    pairings.mockResolvedValue(capturing);
    const scope = effectScope();
    scope.run(() => useOtlpPairing());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(pairings).toHaveBeenCalledTimes(2);

    // The page leaves while a read is in flight; it must not start reading again when that read lands.
    let land: (value: PairingsResponse) => void = () => undefined;
    pairings.mockImplementationOnce(() => new Promise<PairingsResponse>((resolve) => (land = resolve)));
    await vi.advanceTimersByTimeAsync(2000);
    expect(pairings).toHaveBeenCalledTimes(3);
    scope.stop();
    land(capturing);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pairings, 'no read after the page left, so the capture can idle out').toHaveBeenCalledTimes(3);
  });

  it('reads on after a start OAP acknowledged, though the read right after it failed', async () => {
    pairings.mockResolvedValueOnce({ ...capturing, state: 'off', roundId: '', nodes: [] } as PairingsResponse);
    const scope = effectScope();
    const pairing = scope.run(() => useOtlpPairing())!;
    await vi.advanceTimersByTimeAsync(0);

    start.mockResolvedValueOnce({ nodes: [{ status: 'ok', capture: { state: 'capturing', roundId: 'r1', startTime: 1 } }] });
    pairings.mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(capturing);
    await pairing.start();
    expect(pairing.error.value).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    expect(pairing.found.value?.state, 'the next read pings the capture it started').toBe('capturing');
    await vi.advanceTimersByTimeAsync(2000);
    expect(pairings).toHaveBeenCalledTimes(4);
    scope.stop();
  });

  it('reads the capture once more before a stop, as the stop releases it, and keeps that read as the round', async () => {
    const at = (matched: number) => ({ ...capturing, roundId: 'r1', startTime: 100, lastReadTime: 100, matched,
      received: { caller: matched }, unmatched: {}, matchedPeers: [], unmatchedPeers: [], unmatchedServers: [],
      nodes: [{ status: 'ok', state: 'capturing', roundId: 'r1' }] }) as PairingsResponse;
    pairings.mockResolvedValueOnce(at(1));
    const scope = effectScope();
    const pairing = scope.run(() => useOtlpPairing())!;
    await vi.advanceTimersByTimeAsync(0);
    expect(usePairingRounds().rounds.value.map((r) => r.found.matched)).toEqual([1]);

    pairings.mockResolvedValueOnce(at(4)).mockResolvedValue({ ...at(0), state: 'off', roundId: '', startTime: 0 });
    stop.mockResolvedValueOnce({ nodes: [{ status: 'ok', capture: { state: 'off' } }] });
    await pairing.stop();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(usePairingRounds().rounds.value.map((r) => [r.roundId, r.found.matched, r.ended])).toEqual([['r1', 4, true]]);
    expect(pairing.found.value?.state).toBe('off');
    expect(pairing.stopReadFailed.value).toBeNull();
    scope.stop();
  });

  it('reads now and then while no capture runs, so a capture another reader starts shows up, and stops on a 404', async () => {
    const { BffApiError } = (await import('@/api/client')) as unknown as { BffApiError: new (status: number) => Error };
    pairings.mockResolvedValueOnce({ ...capturing, state: 'off', roundId: '', nodes: [] } as PairingsResponse).mockResolvedValueOnce(capturing);
    const scope = effectScope();
    const pairing = scope.run(() => useOtlpPairing())!;
    await vi.advanceTimersByTimeAsync(0);
    expect(pairing.capturing.value).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pairing.capturing.value, 'another reader started it').toBe(true);
    scope.stop();

    pairings.mockReset();
    pairings.mockRejectedValue(new BffApiError(404));
    const old = effectScope();
    const notServed = old.run(() => useOtlpPairing())!;
    await vi.advanceTimersByTimeAsync(0);
    expect(notServed.notServed.value).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pairings, 'an OAP that does not serve it is not read again').toHaveBeenCalledTimes(1);
    old.stop();
  });

  it('says so when the read before a stop failed, and the round keeps its earlier read', async () => {
    const live = { ...capturing, roundId: 'r1', startTime: 100, lastReadTime: 500, matched: 2, received: { caller: 2 },
      unmatched: {}, matchedPeers: [], unmatchedPeers: [], unmatchedServers: [],
      nodes: [{ status: 'ok', state: 'capturing', roundId: 'r1' }] } as PairingsResponse;
    pairings.mockResolvedValueOnce(live);
    const scope = effectScope();
    const pairing = scope.run(() => useOtlpPairing())!;
    await vi.advanceTimersByTimeAsync(0);

    pairings.mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({ ...live, state: 'off', roundId: '', startTime: 0 });
    stop.mockResolvedValueOnce({ nodes: [{ status: 'ok', capture: { state: 'off' } }] });
    await pairing.stop();
    expect(pairing.stopReadFailed.value).toEqual({ savedEnd: 500 });
    expect(usePairingRounds().rounds.value.map((r) => r.found.matched)).toEqual([2]);
    scope.stop();
  });

  it('cancels the read in flight when the page leaves', async () => {
    let signal: AbortSignal | undefined;
    pairings.mockImplementationOnce((_limit: unknown, s?: AbortSignal) => {
      signal = s;
      return new Promise(() => undefined);
    });
    const scope = effectScope();
    scope.run(() => useOtlpPairing());
    await vi.advanceTimersByTimeAsync(0);
    expect(signal?.aborted).toBe(false);
    scope.stop();
    expect(signal?.aborted, 'an abandoned read costs OAP nothing more').toBe(true);
  });

  it('takes the round an acknowledgement names as OAP would, and ends no round a node still runs', async () => {
    const r1 = { ...capturing, roundId: 'r1', startTime: 1_000, nodes: [{ status: 'ok', state: 'capturing', roundId: 'r1' }] } as PairingsResponse;
    pairings.mockResolvedValueOnce(r1);
    const scope = effectScope();
    const pairing = scope.run(() => useOtlpPairing())!;
    await vi.advanceTimersByTimeAsync(0);
    expect(pairing.liveRoundId.value).toBe('r1');

    // A restarted node started r2; the two others keep r1.
    start.mockResolvedValueOnce({ nodes: [
      { status: 'ok', capture: { state: 'capturing', roundId: 'r2', startTime: 2_000 } },
      { status: 'ok', capture: { state: 'capturing', roundId: 'r1', startTime: 1_000 } },
      { status: 'ok', capture: { state: 'capturing', roundId: 'r1', startTime: 1_000 } },
    ] });
    pairings.mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(r1);
    await pairing.start();
    expect(pairing.liveRoundId.value, 'the round most nodes run').toBe('r1');
    expect(usePairingRounds().rounds.value.find((r) => r.roundId === 'r1')?.ended).toBeFalsy();
    scope.stop();
  });

  it('keeps the stop\'s save and the round\'s end though the page left while it stopped', async () => {
    const r1 = { ...capturing, roundId: 'r1', startTime: 1_000, matched: 1, received: { caller: 1 } } as PairingsResponse;
    pairings.mockResolvedValueOnce(r1);
    const scope = effectScope();
    const pairing = scope.run(() => useOtlpPairing())!;
    await vi.advanceTimersByTimeAsync(0);

    let land: (value: PairingsResponse) => void = () => undefined;
    pairings.mockImplementationOnce(() => new Promise<PairingsResponse>((resolve) => (land = resolve)));
    stop.mockResolvedValueOnce({ nodes: [{ status: 'ok', capture: { state: 'off', roundId: '' } }] });
    const stopping = pairing.stop();
    scope.stop();
    land({ ...r1, matched: 3, received: { caller: 3 } });
    await stopping;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(usePairingRounds().rounds.value.map((r) => [r.roundId, r.found.matched, r.ended])).toEqual([['r1', 3, true]]);
  });

  it('ends on a stop the round its last read found, though the page knew another, and keeps that one on screen', async () => {
    const r1 = { ...capturing, roundId: 'r1', startTime: 1_000, lastReadTime: 2_000 } as PairingsResponse;
    pairings.mockResolvedValueOnce(r1);
    const scope = effectScope();
    const pairing = scope.run(() => useOtlpPairing())!;
    await vi.advanceTimersByTimeAsync(0);
    const s2 = { ...capturing, roundId: 's2', startTime: 1_500, lastReadTime: 3_000, matched: 4,
      nodes: [{ status: 'ok', state: 'capturing', roundId: 's2' }, { status: 'ok', state: 'capturing', roundId: 's2' }] } as PairingsResponse;
    pairings.mockResolvedValueOnce(s2).mockResolvedValue({ ...capturing, state: 'off', roundId: '', nodes: [] } as PairingsResponse);
    stop.mockResolvedValueOnce({ nodes: [{ status: 'ok', capture: { state: 'off', roundId: '' } }] });
    await pairing.stop();
    const ended = Object.fromEntries(usePairingRounds().rounds.value.map((r) => [r.roundId, r.ended === true]));
    expect(ended).toEqual({ r1: true, s2: true });
    expect(pairing.lastRoundId.value).toBe('s2');
    scope.stop();
  });

  it('keeps the stop warning through a start OAP refused', async () => {
    pairings.mockResolvedValueOnce(capturing);
    const scope = effectScope();
    const pairing = scope.run(() => useOtlpPairing())!;
    await vi.advanceTimersByTimeAsync(0);
    pairings.mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({ ...capturing, state: 'off', roundId: '', nodes: [] } as PairingsResponse);
    stop.mockResolvedValueOnce({ nodes: [{ status: 'ok', capture: { state: 'off', roundId: '' } }] });
    await pairing.stop();
    expect(pairing.stopReadFailed.value).not.toBeNull();
    start.mockRejectedValueOnce(new Error('403'));
    await pairing.start();
    expect(pairing.stopReadFailed.value, 'nothing ran since').not.toBeNull();
    scope.stop();
  });

  it('ends no round on a read its holder did not answer, so a clear keeps it', async () => {
    const r1 = { ...capturing, roundId: 'r1', startTime: 1_000, lastReadTime: 2_000, matched: 75,
      nodes: [{ status: 'ok', state: 'off', roundId: '' }, { peer: 'b', status: 'ok', state: 'capturing', roundId: 'r1' }] } as PairingsResponse;
    pairings.mockResolvedValueOnce(r1);
    const scope = effectScope();
    scope.run(() => useOtlpPairing());
    await vi.advanceTimersByTimeAsync(0);
    pairings.mockResolvedValueOnce({ ...capturing, state: 'off', roundId: '',
      nodes: [{ status: 'ok', state: 'off', roundId: '' }, { peer: 'b', status: 'unreachable' }] } as PairingsResponse);
    await vi.advanceTimersByTimeAsync(2_000);
    const store = usePairingRounds();
    expect(store.rounds.value[0]!.ended, 'b may still run it').toBeFalsy();
    store.clear();
    expect(store.rounds.value.map((r) => r.roundId)).toEqual(['r1']);
    scope.stop();
  });
});
