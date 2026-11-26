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
 * The OAP pairing capture for the page. There are no sessions: each OAP node has one capture, shared by every reader,
 * which runs while it is read and stops a minute after the latest read. The page reads it every few seconds while it
 * runs, which keeps it running while the page is open, and now and then while it is off, to find a capture someone
 * else starts. A stop releases what it found on OAP, so every read of a running round is saved in this browser, and
 * a stop reads it once more first. A read the page no longer wants is cancelled, so it costs OAP no fan-out.
 */
import { computed, onScopeDispose, ref, shallowRef } from 'vue';
import type { PairingCaptureResponse, PairingsResponse } from '@skywalking-horizon-ui/api-client';
import { BffApiError, bff, describeApiError } from '@/api/client';
import { roundOfCaptures } from './otlpPairing';
import { usePairingRounds } from './pairingRounds';

const POLL_MS = 2000;
/** While no capture runs: how soon a capture another reader starts shows here. */
const IDLE_POLL_MS = 10_000;

/** The capture as the latest acknowledgement or read told it. */
interface Known {
  capturing: boolean;
  roundId: string;
  startTime: number;
}

/** What a node answered of its capture, in a read or an acknowledgement. */
interface NodeAnswer {
  status: string;
  state?: string;
  roundId?: string;
}

function answersOf(ack: PairingCaptureResponse): NodeAnswer[] {
  return ack.nodes.map((n) => ({ status: n.status, state: n.capture?.state, roundId: n.capture?.roundId }));
}

export function useOtlpPairing() {
  const found = shallowRef<PairingsResponse | null>(null);
  const error = ref<string | null>(null);
  const busy = ref(false);
  /** OAP answers 404: it is older than 11.2, or its trace-pairing-debugging module is off. */
  const notServed = ref(false);
  /** The read just before a stop failed: the round keeps its earlier read, which ends at this time, or none. Shown
   *  once the stop went through, until a round runs again. */
  const stopReadFailed = ref<{ savedEnd: number | null } | null>(null);
  /** The round this page saw run last: the live tab shows its saved copy once it stops. */
  const lastRoundId = ref<string>('');
  /** So the controls follow a start or a stop OAP acknowledged though the read after it failed, and the page knows
   *  the live round before its first read. */
  const known = ref<Known>({ capturing: false, roundId: '', startTime: 0 });
  const capturing = computed(() => known.value.capturing);
  const liveRoundId = computed(() => (known.value.capturing ? known.value.roundId : ''));
  const liveStart = computed(() => (known.value.capturing ? known.value.startTime : 0));
  const rounds = usePairingRounds();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: AbortController | null = null;
  /** Bumped by every start, stop and unmount, so a read still in flight from before lands nowhere and schedules
   *  nothing: a late read must not keep a capture running after the page left, or revive one just stopped. */
  let generation = 0;
  let disposed = false;

  function current(gen: number): boolean {
    return !disposed && gen === generation;
  }

  function clearTimer(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function cancelRead(): void {
    inFlight?.abort();
    inFlight = null;
  }

  /** What the page now knows. A round it held live has ended once every node answered and none runs it: a read of
   *  another round while a node still runs it, or one a node did not answer, says nothing of its end. */
  function learn(next: Known, nodes: readonly NodeAnswer[]): void {
    const before = known.value;
    if (before.capturing && before.roundId && endedIn(before.roundId, nodes)) rounds.markEnded(before.roundId);
    if (next.capturing && next.roundId) {
      lastRoundId.value = next.roundId;
      stopReadFailed.value = null;
    }
    known.value = next;
  }

  /** Whether a round is over by what the nodes of a read or an acknowledgement answered: each answered, none runs it. */
  function endedIn(roundId: string, nodes: readonly NodeAnswer[]): boolean {
    return nodes.every((n) => n.status === 'ok' && !(n.state === 'capturing' && n.roundId === roundId));
  }

  /** Read what the capture found; whether this read is still the page's latest. */
  async function read(gen: number): Promise<boolean> {
    const ac = new AbortController();
    inFlight = ac;
    try {
      const got = await bff.otlpPairing.pairings(undefined, ac.signal);
      if (!current(gen)) return false;
      found.value = got;
      error.value = null;
      notServed.value = false;
      rounds.save(got);
      learn({ capturing: got.state === 'capturing', roundId: got.roundId, startTime: got.startTime }, got.nodes);
    } catch (err) {
      if (!current(gen)) return false;
      error.value = describeApiError(err);
      notServed.value = err instanceof BffApiError && err.status === 404;
    } finally {
      if (inFlight === ac) inFlight = null;
    }
    return true;
  }

  /** Read on: often while the capture runs, as each read is the ping that keeps it running, and now and then while it
   *  is off. A read that failed is tried again; an OAP that does not serve the capture is not read again. */
  function poll(gen: number): void {
    clearTimer();
    if (!current(gen) || notServed.value) return;
    timer = setTimeout(async () => {
      if (await read(gen)) poll(gen);
    }, capturing.value ? POLL_MS : IDLE_POLL_MS);
  }

  async function act(call: () => Promise<PairingCaptureResponse>): Promise<void> {
    busy.value = true;
    clearTimer();
    cancelRead();
    const gen = ++generation;
    try {
      const ack = await call();
      if (!current(gen)) return;
      const captures = ack.nodes.map((n) => n.capture);
      const round = roundOfCaptures(captures);
      learn(
        round
          ? { capturing: true, roundId: round.roundId, startTime: round.startTime }
          : { capturing: false, roundId: '', startTime: 0 },
        answersOf(ack),
      );
      if (await read(gen)) poll(gen);
    } catch (err) {
      if (!current(gen)) return;
      // Refused, as without the write verb: the capture runs on, so the page reads on.
      const message = describeApiError(err);
      if (await read(gen)) {
        error.value = message;
        poll(gen);
      }
    } finally {
      busy.value = false;
    }
  }

  const first = generation;
  void read(first).then((latest) => {
    if (latest) poll(first);
  });
  onScopeDispose(() => {
    disposed = true;
    generation += 1;
    clearTimer();
    cancelRead();
  });

  return {
    found,
    error,
    busy,
    capturing,
    liveRoundId,
    liveStart,
    lastRoundId,
    notServed,
    stopReadFailed,
    // A refused start leaves the stop warning: it clears once a round is seen running.
    start: () => act(() => bff.otlpPairing.start()),
    stop: () =>
      act(async () => {
        // The stop releases what the capture found: read it once more, to save the round as it ended. The stop is the
        // operator's action, so its read, its save and the round's end are kept though the page leaves meanwhile.
        // The last read may be of another round than the page knew, as when the nodes moved to it: the live tab keeps
        // that one, and the stop ends each of the two that no node runs after it.
        const roundId = known.value.roundId;
        const stopping = new Set([roundId]);
        stopReadFailed.value = null;
        let failed: { savedEnd: number | null } | null = null;
        try {
          const last = await bff.otlpPairing.pairings();
          rounds.save(last, true);
          if (last.state === 'capturing' && last.roundId) {
            stopping.add(last.roundId);
            lastRoundId.value = last.roundId;
          }
        } catch {
          const held = rounds.rounds.value.find((r) => r.roundId === roundId);
          failed = { savedEnd: held ? held.endTime : null };
        }
        const ack = await bff.otlpPairing.stop();
        for (const id of stopping) if (id && endedIn(id, answersOf(ack))) rounds.markEnded(id);
        if (!disposed) stopReadFailed.value = failed;
        return ack;
      }),
  };
}
