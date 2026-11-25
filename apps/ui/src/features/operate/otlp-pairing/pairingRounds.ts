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
 * The pairing rounds this browser saved. OAP keeps nothing once a capture stops, so the page saves each round as it
 * reads it, as the live debugger saves its captures, and lists them beside the live capture. A round is one capture
 * from a start to its stop, known by the id OAP gives it. One browser tab is meant to hold a round: tabs see each
 * other's saves, removals and clears, but two tabs saving one round at once may keep either's latest read.
 */
import { ref, type Ref } from 'vue';
import type { PairingsResponse } from '@skywalking-horizon-ui/api-client';
import { storeWhatFits } from '@/utils/storedList';

export const ROUNDS_KEY = 'vs:otlp-pairing-rounds:v2';
/** Rounds kept, the newest first. */
export const ROUNDS_KEPT = 10;
/** A round saved this long ago without a word from OAP has ended: it idles out a minute after the last read. */
const ENDED_AFTER_MS = 70_000;
/** How long a round's later end time may wait in memory before it is stored. */
const END_STORED_WITHIN_MS = 30_000;

export interface PairingRound {
  roundId: string;
  /** When the round started, as the node that started it tells. */
  startTime: number;
  /** When OAP was last read for it, by OAP's clock; never before the start. */
  endTime: number;
  /** When this browser last saved it, by the browser's clock. */
  savedAt: number;
  /** The round's nodes the saved read covered: a read covering fewer, as when a node did not answer, does not
   *  replace it. */
  covered: number;
  /** This browser saw it end: stopped, or read as over. */
  ended?: boolean;
  found: PairingsResponse;
}

function readRounds(): PairingRound[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(ROUNDS_KEY) ?? '[]');
    return Array.isArray(parsed) ? (parsed as PairingRound[]) : [];
  } catch {
    return [];
  }
}

/** Store the rounds, the newest first; over the quota, what fits, a round grown too large keeping its last stored
 *  copy (`storeWhatFits`).
 *  @returns the rounds this write stored, as they are now; a round left out may still have an older copy stored */
export function writeRounds(rounds: readonly PairingRound[]): Set<string> {
  return storeWhatFits(ROUNDS_KEY, rounds, (r) => r.roundId, readRounds);
}

/** The nodes in a read's round that answered. */
export function coveredBy(found: PairingsResponse): number {
  return found.nodes.filter((n) => n.status === 'ok' && n.roundId === found.roundId).length;
}

/** What a read can change in a round: every list entry and count moves only as pairings arrive or leave. */
function countsOf(found: PairingsResponse): string {
  return JSON.stringify([found.received, found.matched, found.unmatched, found.matchedPeers.length,
    found.unmatchedPeers.length, found.unmatchedServers.length]);
}

function newestFirst(rounds: PairingRound[]): PairingRound[] {
  return rounds.sort((a, b) => b.startTime - a.startTime).slice(0, ROUNDS_KEPT);
}

/** Of two copies of one round, the one further on: a saved round only moves forward. The copy covering more of its
 *  nodes, or as many and read no earlier, keeps its read, `b` on a tie, as the later copy; the end, the save time and
 *  having ended only grow. */
function fresher(a: PairingRound, b: PairingRound): PairingRound {
  const best = b.covered > a.covered || (b.covered === a.covered && b.found.lastReadTime >= a.found.lastReadTime) ? b : a;
  return {
    ...best,
    endTime: Math.max(a.endTime, b.endTime),
    savedAt: Math.max(a.savedAt, b.savedAt),
    ...(a.ended || b.ended ? { ended: true } : {}),
  };
}

let cache: Ref<PairingRound[]> | null = null;
/** When each round's end time was last stored, by its id. */
const storedEnd = new Map<string, number>();
/** Rounds this tab holds as storage could not: too large beside the others. They stay in this tab until removed. */
const unstored = new Set<string>();

/** The rounds as this tab should hold them: each stored round, the fresher of its stored copy and this tab's, and the
 *  rounds this tab could not store. A stored round another tab removed is gone. */
function mergeStored(mine: readonly PairingRound[]): PairingRound[] {
  const byId = new Map(mine.map((r) => [r.roundId, r]));
  const stored = readRounds();
  const storedIds = new Set(stored.map((r) => r.roundId));
  return [
    ...stored.map((r) => {
      const own = byId.get(r.roundId);
      return own ? fresher(r, own) : r;
    }),
    ...mine.filter((r) => unstored.has(r.roundId) && !storedIds.has(r.roundId)),
  ];
}

if (typeof window !== 'undefined') {
  // Another tab saved, removed or cleared rounds: take what it stored, never behind what this tab holds.
  window.addEventListener('storage', (event) => {
    if (event.key !== ROUNDS_KEY || cache === null) return;
    cache.value = newestFirst(mergeStored(cache.value));
  });
}

/** Whether a round has surely ended: this browser saw it end, or it has gone unsaved past its idle expiry. */
export function hasEnded(round: PairingRound, now = Date.now()): boolean {
  return round.ended === true || now - round.savedAt > ENDED_AFTER_MS;
}

export function usePairingRounds() {
  if (cache === null) cache = ref(readRounds());
  const rounds = cache;

  /** Apply a change to the rounds as this tab should hold them, so a removal another tab made stays and no copy moves
   *  back, then store and keep the result. */
  function commit(change: (rounds: PairingRound[]) => PairingRound[]): void {
    const all = newestFirst(change(mergeStored(rounds.value)));
    const written = writeRounds(all);
    unstored.clear();
    for (const r of all) if (!written.has(r.roundId)) unstored.add(r.roundId);
    rounds.value = all;
  }

  /** Save a read of a running round. A read covering fewer of the round's nodes than the one saved, or read before
   *  it, as one that arrives late, keeps what was saved and moves only the end. A round seen ending stays ended: a
   *  read OAP served later still fills it in. It is stored when it changed, when its end has waited long enough, or
   *  `always`, as for the last read before a stop. */
  function save(found: PairingsResponse, always = false): void {
    if (found.state !== 'capturing' || !found.roundId) return;
    const held = rounds.value.find((r) => r.roundId === found.roundId);
    const covered = coveredBy(found);
    const fuller = held === undefined || (covered >= held.covered && found.lastReadTime >= held.found.lastReadTime);
    const endTime = Math.max(held?.endTime ?? 0, found.lastReadTime, found.startTime);
    const round: PairingRound = {
      roundId: found.roundId,
      startTime: found.startTime,
      endTime,
      savedAt: Date.now(),
      covered: fuller ? covered : held!.covered,
      found: fuller ? found : held!.found,
      ...(held?.ended ? { ended: true } : {}),
    };
    const changed =
      held === undefined || (fuller && (covered !== held.covered || countsOf(held.found) !== countsOf(found)));
    const due = endTime - (storedEnd.get(found.roundId) ?? 0) >= END_STORED_WITHIN_MS;
    if (!changed && !due && !always) {
      rounds.value = rounds.value.map((r) => (r.roundId === found.roundId ? round : r));
      return;
    }
    commit((all) => {
      const there = all.find((r) => r.roundId === found.roundId);
      return [there ? fresher(there, round) : round, ...all.filter((r) => r.roundId !== found.roundId)];
    });
    storedEnd.set(found.roundId, endTime);
  }

  /** Mark a round this browser saw end: stopped, or read as over. The round keeps the best read this tab holds,
   *  never one stored earlier. */
  function markEnded(roundId: string): void {
    const held = rounds.value.find((r) => r.roundId === roundId);
    if (!held || held.ended) return;
    commit((all) => all.map((r) => (r.roundId === roundId ? { ...r, ended: true } : r)));
    storedEnd.set(roundId, held.endTime);
  }

  function remove(roundId: string): void {
    commit((all) => all.filter((r) => r.roundId !== roundId));
  }

  /** Delete every saved round that has ended; one still running, here or in another tab, or that a node is still
   *  reported running, stays. */
  function clear(now = Date.now(), running: ReadonlySet<string> = new Set()): void {
    commit((all) => all.filter((r) => running.has(r.roundId) || !hasEnded(r, now)));
  }

  return { rounds, save, markEnded, remove, clear };
}

/** For tests: forget the rounds read from storage, as a reload does. */
export function resetPairingRoundsCache(): void {
  cache = null;
  storedEnd.clear();
  unstored.clear();
}
