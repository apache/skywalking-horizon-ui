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
 * Reactive lifecycle wrapper around `/api/debug/*`.
 *
 * The actual wire (see `reference_swip13_actual_wire.md`) doesn't have a
 * top-level session status — `nodes[].status` is per-node and the
 * recorder's `captured` boolean signals "session frozen". This composable
 * computes a single UI-facing state by combining: install ack, every
 * node's status, and the per-node `captured` flag.
 *
 * UI states:
 *   - idle     — never started
 *   - starting — POST /session in flight
 *   - capturing — at least one node is `status: ok` and not captured
 *   - captured  — every reachable node is captured; against an OAP that
 *                 pages its reads, the read says it is through (`complete`)
 *   - stopped   — operator hit Stop (response received, polling halted)
 *   - error     — start failed
 *
 * Polling cadence: 1 s while `capturing`, then halts on terminal.
 *
 * Reads are incremental against an OAP that pages them: each poll asks for
 * what was captured since the point the previous one returned and folds it
 * into the held session, so the view is one list that grows. A poll that
 * brought records reads again at once; polling ends when OAP says the
 * capture is read through (`complete`). An OAP that returns no point sends
 * the whole capture every time, and the held session is replaced instead.
 */

import { computed, onScopeDispose, reactive, ref, shallowRef, watch, type Ref } from 'vue';
import type {
  InstallSummary,
  PeerInstallAck,
  PriorCleanup,
  SessionResponse,
  StartSessionArgs,
} from '@skywalking-horizon-ui/api-client';
import { bff, describeApiError } from '@/api/client';
import { getClientId } from '../../../controls/clientId.js';
import { mergeSessionPage, mergeWholeRead, pageHasRecords } from './sessionMerge';

export type DebugWidgetKey = 'mal' | 'lal' | 'oal' | 'tal';

export type DebugState = 'idle' | 'starting' | 'capturing' | 'captured' | 'stopped' | 'error';

/** What a capture runs with: its start's arguments, or a resumed capture's saved settings. */
export type CaptureSettings = Omit<StartSessionArgs, 'clientId'>;

export interface UseDebugSessionResult {
  clientId: string;
  state: Ref<DebugState>;
  session: Ref<SessionResponse | null>;
  sessionId: Ref<string | null>;
  /** Set when state === 'error'. */
  error: Ref<string | null>;
  /** Per-peer install acks from the most recent start call. */
  peerAcks: Ref<PeerInstallAck[]>;
  /** Cluster-wide install rollup `{created, total}` from the most
   *  recent start call. Null while idle / starting. */
  installed: Ref<InstallSummary | null>;
  /** Cluster cleanup report from the StopByClientId broadcast that
   *  ran before the session was allocated. The local node's slice is
   *  always present; `peers[]` is one entry per known peer. */
  priorCleanup: Ref<PriorCleanup | null>;
  /** Convenience flat list of every prior session id that was
   *  terminated by the cleanup, derived from `priorCleanup`. */
  replacedPriorIds: Ref<string[]>;
  /** Unix-ms when OAP will reap the live session. Null between
   *  captures or when an entry was resumed without a known deadline. */
  retentionDeadline: Ref<number | null>;
  /** What the session runs with, set with its id: a capture is saved under these, never under the form, which is
   *  the next run's and may change while this one runs. Null when it is not known. */
  startedWith: Ref<CaptureSettings | null>;
  /** Allocate a new session. Discards any prior local state. */
  start(args: Omit<StartSessionArgs, 'clientId'>): Promise<void>;
  /** Attach to an already-allocated session id (typically because the
   *  operator returned to a tab after navigating away — the session
   *  is still live on OAP, we just need to resume polling). Skips the
   *  start API call entirely. With the capture saved so far, it reads on
   *  from the point that capture was read to, and keeps its records. */
  resume(id: string, retentionDeadline?: number | null, saved?: SessionResponse | null,
    settings?: CaptureSettings | null): void;
  /** Stop the current session. No-op when idle. */
  stop(): Promise<void>;
}

const POLL_INTERVAL_MS = 1000;
/** The next read after one that brought records: more may be waiting. */
const DRAIN_INTERVAL_MS = 50;
/** Pause polling when the tab is hidden — operator can't see captures
 *  anyway, no reason to keep load on the BFF + OAP. The first
 *  visibilitychange on resume snaps an immediate poll. */
const PAUSE_ON_HIDDEN = true;
/** Tolerate brief OAP / network blips before declaring an error.
 *  Each retry waits POLL_INTERVAL_MS × (attempt + 1) ms. */
const POLL_RETRY_BUDGET = 2;

/** Decide the UI-facing state from a polled SessionResponse. */
function deriveState(resp: SessionResponse): 'capturing' | 'captured' {
  // The wire doesn't have a top-level status; combine per-node flags.
  // If every reachable node is captured (or unreachable / not_local),
  // there's nothing more coming — treat as captured.
  const reachable = resp.nodes.filter((n) => n.status === 'ok' || n.status === 'captured');
  if (reachable.length === 0) {
    // No-one's contributing data; nothing to wait for.
    return 'captured';
  }
  const allCaptured = reachable.every((n) => n.status === 'captured' || n.captured === true);
  return allCaptured ? 'captured' : 'capturing';
}

/** The tabs whose session is reading a running capture. The sessions live in the tabs, which leaving the Live Debugger
 *  unmounts, so the page asks before a running capture stops being read. */
const reading = reactive(new Set<DebugWidgetKey>());

/** The tabs with a capture running, in tab order. */
export const runningCaptures = computed<DebugWidgetKey[]>(() =>
  (['mal', 'lal', 'oal', 'tal'] as const).filter((w) => reading.has(w)));

export function useDebugSession(widget: DebugWidgetKey): UseDebugSessionResult {
  const clientId = getClientId(widget);
  const state = ref<DebugState>('idle');
  // shallowRef: the session response is replaced wholesale per poll
  // and never mutated in place. Deep reactivity over a 1000-record
  // payload would walk every leaf on every poll for no benefit —
  // shallowRef notifies dependents on assignment only.
  const session = shallowRef<SessionResponse | null>(null);
  const sessionId = ref<string | null>(null);
  const error = ref<string | null>(null);
  const peerAcks = ref<PeerInstallAck[]>([]);
  const installed = ref<InstallSummary | null>(null);
  const priorCleanup = ref<PriorCleanup | null>(null);
  const retentionDeadline = ref<number | null>(null);
  const startedWith = shallowRef<CaptureSettings | null>(null);

  const replacedPriorIds = computed<string[]>(() => {
    const c = priorCleanup.value;
    if (!c) return [];
    const out: string[] = [...(c.local.stoppedSessionIds ?? [])];
    for (const p of c.peers) {
      if (p.stoppedSessionIds) out.push(...p.stoppedSessionIds);
    }
    return out;
  });

  /** The timer a read waits on; null while no read waits, a fired one included. */
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by every start, resume, stop and unmount: a read of an older generation lands nowhere. */
  let pollGeneration = 0;
  /** The generation whose read is in flight. Each read moves the read point on from the page before it, so a
   *  session reads one page at a time: a second read of the same point would fold the same records in twice. */
  let readingGeneration: number | null = null;
  /** Consecutive failures since the last successful poll. Resets on
   *  every successful response. */
  let pollFailures = 0;
  /** True when polling is on hold because `document.hidden` is true.
   *  An immediate poll fires when the tab becomes visible again. */
  let pausedForHidden = false;
  /** The point the next read starts from; null to read from the first record. */
  let readPoint: string | null = null;
  /** The saved copy a resume started from, to show should OAP no longer have the capture. */
  let resumedFrom: SessionResponse | null = null;

  function clearTimer(): void {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function schedulePoll(delay: number = POLL_INTERVAL_MS): void {
    clearTimer();
    if (PAUSE_ON_HIDDEN && typeof document !== 'undefined' && document.hidden) {
      pausedForHidden = true;
      return;
    }
    const gen = pollGeneration;
    pollTimer = setTimeout(() => {
      // Fired: the read it starts is in flight, no timer is waiting. Hiding the tab now must not take this read for
      // a parked one, or coming back would start a second read of the same page.
      pollTimer = null;
      void poll(gen);
    }, delay);
  }

  /** Read the next page. Whatever asks for it — the timer, a start, a resume, the tab coming back — a session
   *  never has two reads in flight. */
  async function poll(gen: number): Promise<void> {
    if (gen !== pollGeneration || readingGeneration === gen) return;
    const id = sessionId.value;
    if (!id) return;
    readingGeneration = gen;
    try {
      const got = await bff.liveDebug.session(id, readPoint ? { capturedSince: readPoint } : {});
      if (gen !== pollGeneration) return;
      pollFailures = 0;
      if (got === null) {
        // A resume without a read point holds nothing of its own yet (an OAP before 11.2 is read whole): the saved
        // copy is what there is of a capture OAP no longer has, stopped or past its retention.
        if (session.value === null && resumedFrom !== null) session.value = resumedFrom;
        // Session went past retention; freeze whatever we last saw and
        // surface as captured (we kept the last poll's records).
        state.value = 'captured';
        clearTimer();
        return;
      }
      if (got.nextCapturedSince === undefined) {
        // A whole read: what is held, or on a resume the saved copy, keeps what a node that did not answer captured.
        session.value = mergeWholeRead(session.value ?? resumedFrom, got);
        const next = deriveState(got);
        state.value = next;
        if (next === 'capturing') schedulePoll();
        else clearTimer();
        return;
      }
      session.value = mergeSessionPage(session.value, got);
      if (got.nextCapturedSince) readPoint = got.nextCapturedSince;
      if (got.complete === true) {
        state.value = 'captured';
        clearTimer();
        return;
      }
      // A node still captures, did not answer, or holds records the next read brings.
      state.value = 'capturing';
      schedulePoll(pageHasRecords(got) ? DRAIN_INTERVAL_MS : POLL_INTERVAL_MS);
    } catch (err) {
      if (gen !== pollGeneration) return;
      pollFailures += 1;
      if (pollFailures <= POLL_RETRY_BUDGET) {
        // Exponential-ish backoff while the blip clears. Don't surface
        // the error in the UI — operator sees uninterrupted capturing.
        schedulePoll(POLL_INTERVAL_MS * (pollFailures + 1));
        return;
      }
      error.value = describeApiError(err);
      state.value = 'error';
      clearTimer();
    } finally {
      if (readingGeneration === gen) readingGeneration = null;
    }
  }

  async function start(args: Omit<StartSessionArgs, 'clientId'>): Promise<void> {
    // As submitted: the caller's object may change while OAP answers.
    const settings: CaptureSettings = { ...args };
    pollGeneration += 1;
    clearTimer();
    pollFailures = 0;
    pausedForHidden = false;
    state.value = 'starting';
    error.value = null;
    session.value = null;
    readPoint = null;
    resumedFrom = null;
    sessionId.value = null;
    startedWith.value = null;
    peerAcks.value = [];
    installed.value = null;
    priorCleanup.value = null;

    try {
      const r = await bff.liveDebug.start({ clientId, ...settings });
      // Before the id, so whatever the id wakes reads the settings that go with it.
      startedWith.value = settings;
      sessionId.value = r.sessionId;
      peerAcks.value = r.peers ?? [];
      installed.value = r.installed ?? null;
      priorCleanup.value = r.priorCleanup ?? null;
      retentionDeadline.value = r.retentionDeadline ?? null;
      state.value = 'capturing';
      // First poll immediately so the operator sees something fast.
      void poll(pollGeneration);
    } catch (err) {
      error.value = describeApiError(err);
      state.value = 'error';
    }
  }

  /** Attach to an existing live session without re-allocating one on
   *  OAP. Used when reopening a tab that was previously running a
   *  capture — the session id was persisted in the history store with
   *  its retention deadline, and we just need to resume polling. The
   *  first poll fires immediately so the operator sees the latest
   *  records without waiting a full tick. */
  function resume(id: string, deadline: number | null = null, saved: SessionResponse | null = null,
    settings: CaptureSettings | null = null): void {
    pollGeneration += 1;
    clearTimer();
    pollFailures = 0;
    pausedForHidden = false;
    state.value = 'capturing';
    error.value = null;
    // A saved capture and the point it was read to go together: everything before the point is in it, so reading
    // on from there misses nothing, also from a node that does not answer now. A capture saved without a point,
    // from an OAP before paged reads, is read again whole, and shown as saved should OAP no longer have it.
    const point = saved?.sessionId === id ? saved.nextCapturedSince : undefined;
    resumedFrom = saved?.sessionId === id ? saved : null;
    session.value = point ? saved : null;
    readPoint = point || null;
    startedWith.value = settings;
    sessionId.value = id;
    peerAcks.value = [];
    installed.value = null;
    priorCleanup.value = null;
    retentionDeadline.value = deadline;
    void poll(pollGeneration);
  }

  async function stop(): Promise<void> {
    pollGeneration += 1;
    clearTimer();
    const id = sessionId.value;
    if (!id) {
      state.value = 'idle';
      return;
    }
    try {
      await bff.liveDebug.stop(id);
      state.value = 'stopped';
      // Refresh once so the post-stop "not_local" status surfaces in
      // the UI.
      try {
        const after = await bff.liveDebug.session(id, readPoint ? { capturedSince: readPoint } : {});
        if (after !== null) {
          session.value = after.nextCapturedSince === undefined
            ? mergeWholeRead(session.value, after)
            : mergeSessionPage(session.value, after);
        }
      } catch {
        // ignore — stop already succeeded.
      }
    } catch (err) {
      error.value = describeApiError(err);
      state.value = 'error';
    }
  }

  function onVisibilityChange(): void {
    if (typeof document === 'undefined') return;
    if (document.hidden) {
      // Going hidden: a read waiting on its timer parks until we come back.
      // A read in flight parks itself when it reschedules (`schedulePoll`).
      if (pollTimer !== null) {
        clearTimer();
        pausedForHidden = true;
      }
    } else if (pausedForHidden && state.value === 'capturing') {
      // Resume: snap an immediate poll so the operator sees fresh
      // data on tab focus.
      pausedForHidden = false;
      void poll(pollGeneration);
    }
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  watch(state, (now) => {
    if (now === 'starting' || now === 'capturing') reading.add(widget);
    else reading.delete(widget);
  }, { immediate: true });

  onScopeDispose(() => {
    reading.delete(widget);
    pollGeneration += 1;
    clearTimer();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  });

  return {
    clientId,
    state,
    session,
    sessionId: computed(() => sessionId.value) as Ref<string | null>,
    error,
    peerAcks,
    installed,
    priorCleanup,
    replacedPriorIds,
    retentionDeadline,
    startedWith,
    start,
    resume,
    stop,
  };
}
