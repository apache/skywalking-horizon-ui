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
import type { PairingsResponse } from '@skywalking-horizon-ui/api-client';
import { ROUNDS_KEPT, ROUNDS_KEY, hasEnded, resetPairingRoundsCache, usePairingRounds, writeRounds } from './pairingRounds';

type Node = PairingsResponse['nodes'][number];
const nodesIn = (roundId: string, n: number): Node[] =>
  Array.from({ length: n }, (_, i) => ({ peer: i === 0 ? undefined : `oap-${i}:17129`, status: 'ok' as const, state: 'capturing' as const, roundId, matched: 0 }));

const round = (roundId: string, startTime: number, matched: number, covering = 1, state: PairingsResponse['state'] = 'capturing'): PairingsResponse => ({
  state,
  roundId,
  startTime,
  lastReadTime: startTime,
  idleMillis: 60_000,
  received: { caller: matched, callee: matched },
  matched,
  unmatched: {},
  matchedPeers: [],
  unmatchedPeers: [],
  unmatchedServers: [],
  nodes: nodesIn(roundId, covering),
});

/** A storage that counts writes and refuses any value longer than `limit` characters. */
function storage(limit = Infinity): Storage & { writes: number } {
  const items = new Map<string, string>();
  const s = {
    writes: 0,
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (k: string) => items.get(k) ?? null,
    key: (i: number) => [...items.keys()][i] ?? null,
    removeItem: (k: string) => void items.delete(k),
    setItem: (k: string, v: string) => {
      if (v.length > limit) throw new DOMException('quota', 'QuotaExceededError');
      s.writes += 1;
      items.set(k, v);
    },
  };
  return s;
}

describe('usePairingRounds', () => {
  let store: ReturnType<typeof storage>;
  beforeEach(() => {
    store = storage();
    vi.stubGlobal('localStorage', store);
    resetPairingRoundsCache();
  });
  afterEach(() => vi.unstubAllGlobals());

  const stored = (): string[] => (JSON.parse(store.getItem(ROUNDS_KEY) ?? '[]') as { roundId: string }[]).map((r) => r.roundId);
  const at = (roundId: string, startTime: number, matched: number, lastReadTime: number, covering = 1) =>
    ({ ...round(roundId, startTime, matched, covering), lastReadTime });

  it('saves each running round under its id, the newest first, ending at OAP\'s latest read and never before its start', () => {
    const { rounds, save } = usePairingRounds();
    save(at('a', 100, 1, 150));
    save(at('b', 200, 1, 250));
    save(at('a', 100, 3, 160));
    save(at('c', 300, 1, 290));
    expect(rounds.value.map((r) => [r.roundId, r.found.matched, r.endTime])).toEqual([['c', 1, 300], ['b', 1, 250], ['a', 3, 160]]);
    expect(stored()).toEqual(['c', 'b', 'a']);
  });

  it('stores a round again when it changed, its end has waited long enough, or it is the last read before a stop', () => {
    const { rounds, save } = usePairingRounds();
    save(at('a', 100, 1, 1_000));
    const writes = store.writes;
    save(at('a', 100, 1, 2_000));
    expect(store.writes, 'the same counts, an end just after: nothing to store').toBe(writes);
    expect(rounds.value[0]!.endTime).toBe(2_000);
    save(at('a', 100, 1, 40_000));
    expect(store.writes, 'the end waited over half a minute').toBe(writes + 1);
    save(at('a', 100, 1, 40_500), true);
    expect(store.writes).toBe(writes + 2);
  });

  it('keeps what it saved when a read covers fewer of the round\'s nodes, though that read counts more', () => {
    const { rounds, save } = usePairingRounds();
    save(at('a', 100, 5, 1_000, 2));
    save(at('a', 100, 6, 2_000, 1), true);
    expect(rounds.value[0]!.found.matched, 'a node did not answer: its rows stay').toBe(5);
    expect(rounds.value[0]!.endTime).toBe(2_000);
    save(at('a', 100, 9, 3_000, 2));
    expect(rounds.value[0]!.found.matched, 'both nodes again').toBe(9);
  });

  it('saves nothing of a capture that is off, as OAP holds nothing then', () => {
    const { rounds, save } = usePairingRounds();
    save(round('', 0, 0, 0, 'off'));
    expect(rounds.value).toEqual([]);
  });

  it('keeps a removal another tab made, and a clear deletes only the rounds that ended', () => {
    const { rounds, save, markEnded, clear } = usePairingRounds();
    save(at('a', 100, 1, 101));
    save(at('b', 200, 1, 201));
    save(at('c', 300, 1, 301));
    // Another tab removed round a.
    store.setItem(ROUNDS_KEY, JSON.stringify(JSON.parse(store.getItem(ROUNDS_KEY)!).filter((r: { roundId: string }) => r.roundId !== 'a')));
    save(at('d', 400, 1, 401));
    expect(stored()).toEqual(['d', 'c', 'b']);

    markEnded('b');
    clear();
    expect(rounds.value.map((r) => r.roundId), 'c and d may still run, here or in another tab').toEqual(['d', 'c']);
    expect(hasEnded(rounds.value[0]!, Date.now() + 71_000), 'unsaved past its idle expiry').toBe(true);
    clear(Date.now() + 71_000);
    expect(stored()).toEqual([]);
  });

  it('keeps the latest rounds only, and a removal persists past a reload', () => {
    const { rounds, save, remove } = usePairingRounds();
    for (let i = 1; i <= ROUNDS_KEPT + 2; i++) save(at(`r${i}`, i * 100, i, i * 100 + 1));
    expect(rounds.value).toHaveLength(ROUNDS_KEPT);
    expect(rounds.value[0]!.roundId).toBe(`r${ROUNDS_KEPT + 2}`);
    remove(`r${ROUNDS_KEPT + 2}`);

    resetPairingRoundsCache();
    expect(usePairingRounds().rounds.value).toHaveLength(ROUNDS_KEPT - 1);
  });

  it('stores the rounds that fit when one is too large, wherever it is', () => {
    vi.stubGlobal('localStorage', (store = storage(2_500)));
    const big = { ...round('b', 200, 2), matchedPeers: Array.from({ length: 20 }, (_, i) => ({ peer: `p${i}`, server: 's', callers: [], count: 1, outcomes: {}, firstTime: 1, lastTime: 1 })) };
    const entry = (found: PairingsResponse) => ({ roundId: found.roundId, startTime: found.startTime, endTime: found.startTime + 1, savedAt: 1, covered: 1, found });
    writeRounds([entry(round('c', 300, 3)), entry(big), entry(round('a', 100, 1))]);
    expect(stored()).toEqual(['c', 'a']);
  });

  it('keeps a round’s last stored copy when it grows too large to store', () => {
    vi.stubGlobal('localStorage', (store = storage(2_500)));
    const entry = (found: PairingsResponse) => ({ roundId: found.roundId, startTime: found.startTime, endTime: found.startTime + 1, savedAt: 1, covered: 1, found });
    writeRounds([entry(round('g', 200, 2)), entry(round('a', 100, 1))]);
    const before = store.getItem(ROUNDS_KEY)!;
    // Too large to store even alone.
    const grown = { ...round('g', 200, 2), matchedPeers: Array.from({ length: 40 }, (_, i) => ({ peer: `p${i}`, server: 's', callers: [], count: 1, outcomes: {}, firstTime: 1, lastTime: 1 })) };
    writeRounds([entry(grown), entry(round('a', 100, 1))]);
    expect(stored()).toEqual(['g', 'a']);
    expect(store.getItem(ROUNDS_KEY), 'the copy that fit').toBe(before);
  });

  it('ends a round on the best read it holds, and stores a read that only covers more nodes', () => {
    const { rounds, save, markEnded } = usePairingRounds();
    save(at('a', 100, 5, 1_000, 1));
    const covering = at('a', 100, 5, 2_000, 2);
    save(covering);
    expect(JSON.parse(store.getItem(ROUNDS_KEY)!)[0].covered, 'a node joined: stored though no count moved').toBe(2);
    save(at('a', 100, 5, 9_000, 2));
    markEnded('a');
    expect(rounds.value[0]!.endTime, 'the end this tab held, not the one stored earlier').toBe(9_000);
    expect(JSON.parse(store.getItem(ROUNDS_KEY)!)[0]).toMatchObject({ endTime: 9_000, ended: true, covered: 2 });
  });

  it('keeps a round too large to store in this tab when another round is removed', () => {
    vi.stubGlobal('localStorage', (store = storage(2_500)));
    resetPairingRoundsCache();
    const { rounds, save, remove } = usePairingRounds();
    save(at('small', 100, 1, 101));
    const big = { ...at('big', 200, 2, 201), matchedPeers: Array.from({ length: 60 }, (_, i) => ({ peer: `p${i}`, server: 's', callers: [], count: 1, outcomes: {}, firstTime: 1, lastTime: 1 })) };
    save(big);
    expect(rounds.value.map((r) => r.roundId), 'too large to store, held in this tab').toEqual(['big', 'small']);
    expect(stored()).toEqual(['small']);
    remove('small');
    expect(rounds.value.map((r) => r.roundId), 'only this tab holds it, and it was not removed').toEqual(['big']);
  });

  it('never moves a saved round back: a later end held here outlives another round\'s save, and a stale stored copy', () => {
    const { rounds, save } = usePairingRounds();
    save(at('a', 100, 5, 1_000));
    save(at('a', 100, 5, 9_000));
    expect(JSON.parse(store.getItem(ROUNDS_KEY)!)[0].endTime, 'the later end waits in this tab').toBe(1_000);
    save(at('b', 200, 1, 2_000));
    expect(rounds.value.find((r) => r.roundId === 'a')!.endTime, 'not rolled back to the stored end').toBe(9_000);

    // The stored copy falls behind, as when the fuller read did not fit: the next save keeps this tab's.
    save(at('a', 100, 75, 20_000));
    store.setItem(ROUNDS_KEY, JSON.stringify(JSON.parse(store.getItem(ROUNDS_KEY)!).map((r: { roundId: string; found: PairingsResponse }) =>
      (r.roundId === 'a' ? { ...r, found: { ...r.found, matched: 1, lastReadTime: 1_000 } } : r))));
    save(at('c', 300, 1, 3_000));
    expect(rounds.value.find((r) => r.roundId === 'a')!.found.matched).toBe(75);
  });

  it('takes no read that arrives late; once the round ended, a read OAP served later still fills it in', () => {
    const { rounds, save, markEnded } = usePairingRounds();
    save(at('a', 100, 75, 9_000, 2));
    save(at('a', 100, 2, 4_000, 2));
    expect(rounds.value[0]!.found.matched, 'a read from before the saved one').toBe(75);
    markEnded('a');
    save(at('a', 100, 2, 5_000, 2));
    expect(rounds.value[0]!.found.matched, 'still none from before').toBe(75);
    save(at('a', 100, 80, 12_000, 2));
    expect(rounds.value[0]!.found.matched).toBe(80);
    expect(rounds.value[0]!.ended, 'and it stays ended, in this tab and stored').toBe(true);
    expect(JSON.parse(store.getItem(ROUNDS_KEY)!)[0].ended).toBe(true);
  });

  it('keeps on a clear a round this tab still reads, and one a node is reported running', () => {
    const { rounds, save, clear } = usePairingRounds();
    const t0 = Date.now();
    save(at('kept', 100, 1, 1_000));
    save(at('elsewhere', 200, 1, 2_000));
    vi.setSystemTime(t0 + 80_000);
    save(at('kept', 100, 1, 1_000));
    clear(t0 + 80_000, new Set(['elsewhere']));
    expect(rounds.value.map((r) => r.roundId).sort()).toEqual(['elsewhere', 'kept']);
    clear(t0 + 80_000);
    expect(rounds.value.map((r) => r.roundId)).toEqual(['kept']);
  });
});
