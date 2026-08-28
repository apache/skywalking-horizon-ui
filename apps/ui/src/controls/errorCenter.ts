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
 * Where a failure goes, and who decides.
 *
 * One store, two audiences, because a failure means different things depending
 * on what asked for it:
 *
 * - **refresh** — something the TIMER did. The operator did not ask for it and
 *   may not be looking, so it lands in a short history beside the refresh
 *   button and waits to be read. A background failure that popped a toast
 *   every cycle would paper the screen during an outage and train people to
 *   dismiss without reading.
 * - **component** — something the operator just DID: expanded a node, saved a
 *   rule. They are looking at it and expecting an answer, so it is shown at
 *   once and then gets out of the way.
 *
 * The API layer only CONSTRUCTS records; it never displays them. Reporting at
 * the fetch layer looked tempting and is wrong twice over: a query library
 * retries, so one failure would be reported several times, and a component
 * that catches an error to handle it would still have had it announced.
 */

import { computed, ref, toValue, watch } from 'vue';
import type { MaybeRefOrGetter, Ref } from 'vue';
import { defineStore } from 'pinia';
import { useAutoRefreshStore } from './autoRefresh';
import { onSessionReset } from '@/state/sessionReset';
import { BffApiError, describeApiError } from '@/api/client';
import { GraphUnavailableError } from '@/layer/graphQuery';

/** How many refresh failures are kept. A ring, not a log: an outage produces
 *  one failure per cycle, and the fifth-oldest tells nobody anything the
 *  newest does not. */
export const REFRESH_HISTORY = 5;

export interface UiErrorRecord {
  id: string;
  occurredAt: number;
  scope: 'refresh' | 'component';
  /** What set the round off, for a refresh failure. */
  trigger?: string;
  roundId?: number;
  /**
   * The screen or feature that asked — "Service map", "Alarms widget".
   *
   * A fixed literal from our own code, never OAP data, so the card translates
   * it at render time. That way a record written before a locale switch still
   * reads in the language the operator is now using.
   */
  owner: string;
  /** What it was trying to do, in the operator's words. Same rule as `owner`. */
  action: string;
  method?: string;
  /** Redacted before it ever reaches here. */
  url?: string;
  /** 0 when the request never got a reply. */
  status?: number;
  /**
   * What happened, VERBATIM from the server or the network.
   *
   * Never translated: it is the upstream's own words, and paraphrasing an
   * OAP error into another language would make it unsearchable against OAP's
   * logs. Where the sentence is OURS rather than the server's, `summaryKey`
   * carries it instead and the card translates that.
   */
  summary: string;
  /** Our own explanation, as a translatable key. Takes precedence over
   *  `summary` when present. */
  summaryKey?: string;
  detail?: string;
  responseBody?: string;
}

/** Query and fragment values that must never be displayed. */
const SECRET_PARAM = /^(token|password|passwd|secret|authorization|auth|cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|sig|signature)$/i;
/** Object keys that must never be displayed, at any depth. */
const SECRET_KEY = SECRET_PARAM;
const REDACTED = '[redacted]';
/** Response bodies are evidence, not a payload dump. */
const MAX_BODY = 2000;

/**
 * A URL with its secrets removed.
 *
 * Values go, names stay: knowing a request carried a `token` is useful, and
 * the value never is. A string that will not parse is returned as its path
 * only, because a malformed URL is not worth guessing at.
 */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw, 'http://x');
    for (const key of [...u.searchParams.keys()]) {
      if (SECRET_PARAM.test(key)) u.searchParams.set(key, REDACTED);
    }
    return `${u.pathname}${u.search}`;
  } catch {
    return raw.split('?')[0] ?? '';
  }
}

/**
 * A response body reduced to something safe to show.
 *
 * Recursive, because a secret nested three levels down is exactly as exposed
 * as one at the top. Length-capped, because a body is shown to explain a
 * failure and a megabyte of JSON explains nothing.
 */
export function redactBody(body: unknown): string {
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 6) return '…';
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => walk(x, depth + 1));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = SECRET_KEY.test(k) ? REDACTED : walk(val, depth + 1);
      }
      return out;
    }
    return v;
  };
  let text: string;
  try {
    text = typeof body === 'string' ? body : JSON.stringify(walk(body, 0), null, 2);
  } catch {
    text = String(body);
  }
  if (typeof body === 'string') {
    // A string body may still be JSON — redact it if it parses, otherwise show
    // it as-is rather than guessing at its shape.
    try {
      text = JSON.stringify(walk(JSON.parse(body), 0), null, 2);
    } catch {
      /* not JSON; the raw text stands */
    }
  }
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}\n… (truncated)` : text;
}

let nextId = 0;

/** Triggers the operator is responsible for, and therefore watching. */
const OPERATOR_TRIGGERS = new Set(['manual', 'time-change', 'cold-stage']);

export const useErrorCenterStore = defineStore('error-center', () => {
  /** Newest first. Capped at `REFRESH_HISTORY`. */
  const refreshHistory = ref<UiErrorRecord[]>([]);
  /** Records not yet looked at — what the badge counts. */
  const unreadCount = ref(0);
  /** Currently on screen as a toast, newest last. */
  const toasts = ref<UiErrorRecord[]>([]);

  function record(input: Omit<UiErrorRecord, 'id' | 'occurredAt'>): UiErrorRecord | null {
    // One EVENT, one record. A query with two observers — two screens sharing a
    // roster, a widget mounted twice — reports the same transport failure from
    // each of them, and the history then shows one outage as several. The round
    // is what makes them the same event: same round, same owner, same action,
    // same words.
    if (input.scope === 'refresh' && input.roundId !== undefined) {
      const already = refreshHistory.value.some(
        (r) =>
          r.roundId === input.roundId &&
          r.owner === input.owner &&
          r.action === input.action &&
          r.summary === input.summary,
      );
      if (already) return null;
    }
    nextId += 1;
    const rec: UiErrorRecord = { ...input, id: `e${nextId}`, occurredAt: Date.now() };
    if (rec.scope === 'refresh') {
      refreshHistory.value = [rec, ...refreshHistory.value].slice(0, REFRESH_HISTORY);
      unreadCount.value = Math.min(unreadCount.value + 1, REFRESH_HISTORY);
    } else {
      toasts.value = [...toasts.value, rec];
    }
    return rec;
  }

  /** Opening the history marks it read. The records STAY — read is not the
   *  same as gone, and an operator who opens the panel twice should see the
   *  same five. */
  function markRead(): void {
    unreadCount.value = 0;
  }
  function clearRefreshHistory(): void {
    refreshHistory.value = [];
    unreadCount.value = 0;
  }
  /**
   * Say once, on screen, that a round the operator asked for did not work.
   *
   * Deliberately NOT one toast per failed participant: an outage fails every
   * screen on the page, and the operator pressed one button. The detail is in
   * the history, which this points at.
   */
  let announcedRound: number | null = null;
  function announceRound(roundId: number): void {
    if (announcedRound === roundId) return;
    announcedRound = roundId;
    nextId += 1;
    toasts.value = [
      ...toasts.value,
      {
        id: `e${nextId}`,
        occurredAt: Date.now(),
        scope: 'component',
        owner: 'Refresh',
        action: 'refreshing the page',
        // One translated sentence rather than a summary plus a `detail`: the
        // card renders `detail` verbatim, which is right for a server's words
        // and wrong for ours — ours would have shown in English everywhere.
        summary: 'Some of the page could not be refreshed — see the failures beside the refresh button.',
        summaryKey: 'Some of the page could not be refreshed — see the failures beside the refresh button.',
      },
    ];
  }

  function dismissToast(id: string): void {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }
  /** Signing out must not leave one person's failures on another's screen — a
   *  record names what was read and what the server said about it. Nothing is
   *  persisted, so clearing memory is the whole of it. */
  function reset(): void {
    refreshHistory.value = [];
    toasts.value = [];
    unreadCount.value = 0;
  }

  return {
    refreshHistory,
    unreadCount,
    toasts,
    hasUnread: computed(() => unreadCount.value > 0),
    record,
    announceRound,
    markRead,
    clearRefreshHistory,
    dismissToast,
    reset,
  };
});

/**
 * Turn whatever a failure arrived as into a record.
 *
 * Three shapes reach here and each knows a different amount: an `ApiError`
 * carries the request and the server's answer, a plain `Error` carries a
 * message, and anything else carries nothing worth trusting. The last case is
 * why the summary is never `String(err)` alone — an object stringifies to
 * "[object Object]", which tells an operator the request failed and nothing
 * else.
 */
export function describeFailure(
  err: unknown,
  owner: string,
  action: string,
  scope: 'refresh' | 'component',
): Omit<UiErrorRecord, 'id' | 'occurredAt'> {
  const base = { scope, owner, action };
  if (err instanceof BffApiError) {
    return {
      ...base,
      method: err.method,
      url: err.path ? redactUrl(err.path) : undefined,
      status: err.status,
      summary: describeApiError(err),
      responseBody:
        err.body === undefined || err.body === null ? undefined : redactBody(err.body),
    };
  }
  if (err instanceof GraphUnavailableError) {
    // Our sentence, not the server's — the BFF answered 200 and said it could
    // not reach OAP, so there is no upstream message to quote.
    return { ...base, summary: err.message, summaryKey: 'OAP could not be reached, so the graph was left as it was.' };
  }
  if (err instanceof Error) return { ...base, summary: err.message, detail: err.name };
  return { ...base, summary: 'The request failed.', summaryKey: 'The request failed.' };
}

/**
 * Report a query's failures to the refresh history — but ONLY the timer's.
 *
 * The distinction is the whole point. A failure while a round is out is the
 * refresh's: nobody asked for it, nobody is necessarily watching, so it waits
 * in the history. A failure outside a round is a screen loading for the first
 * time, and the screen SAYS SO where the graph would have been — announcing it
 * again in a history the operator has to open would be the same news twice.
 *
 * Deduplicated by message, because a backend that is down fails identically
 * every cycle and five copies of one sentence is not five pieces of
 * information.
 */
export function useRefreshErrorReport(opts: {
  owner: MaybeRefOrGetter<string>;
  action: MaybeRefOrGetter<string>;
  error: Ref<Error | null> | { value: Error | null };
}): void {
  const center = useErrorCenterStore();
  const auto = useAutoRefreshStore();
  let lastReported: string | null = null;
  watch(
    () => opts.error.value,
    (err) => {
      if (!err) {
        // Recovered. The next failure is news again even if it reads the same.
        lastReported = null;
        return;
      }
      // A cancellation is something the app DID — a capped round, a navigation.
      // Reporting it would put our own decision in the operator's outage list.
      if (isCancellation(err)) return;
      // A DISABLED layer is not an outage either. An administrator removed the
      // page; the screen says it is unavailable and the sidebar drops it on the
      // next menu read. Filing it here would blame OAP for an administrative
      // decision, and send whoever reads the history to check a healthy server.
      if (err instanceof GraphUnavailableError && err.response.blocked === 'layer-disabled') return;
      const round = auto.currentRound;
      if (!round) return;
      const operatorAsked = OPERATOR_TRIGGERS.has(round.trigger);
      // Repeat suppression is for the TIMER: an outage fails identically every
      // cycle, and five copies of one sentence is not five pieces of
      // information. It must not silence an operator's own retry — pressing
      // Refresh during the same outage and being shown nothing is exactly the
      // contradiction the toast exists to remove.
      if (err.message === lastReported && !operatorAsked) return;
      const repeat = err.message === lastReported;
      lastReported = err.message;
      if (repeat) {
        // Already in the history from the round that first saw it; the
        // operator still gets their answer.
        center.announceRound(round.roundId);
        return;
      }
      const written = center.record({
        ...describeFailure(err, toValue(opts.owner), toValue(opts.action), 'refresh'),
        trigger: round.trigger,
        roundId: round.roundId,
      });
      // A round the OPERATOR set off gets an answer where they are looking, as
      // well as its entry in the history. Clicking Refresh against a dead
      // backend and being shown nothing is the contradiction this removes —
      // they asked, so they are watching. Once per round, though: a page whose
      // every widget failed would otherwise bury the screen in toasts saying
      // the same thing.
      if (written && operatorAsked) center.announceRound(round.roundId);
    },
    // SYNC so the round it belongs to is still the current one. The query
    // settles its error inside the round and the round clears itself a
    // microtask later; a deferred watcher would land somewhere between the
    // two, and which side depends on how Vue's scheduler interleaves with the
    // round's own continuation. Attribution should not rest on that ordering —
    // a failure that lands on the wrong side is silently dropped, and nothing
    // on screen would say so.
    { flush: 'sync' },
  );
}

/**
 * Report a failure the operator caused. Shown at once, as a toast.
 *
 * Called from the action's own catch — never from the fetch layer, which
 * cannot tell an operator's click from a background read and would announce
 * both.
 */
export function reportActionFailure(err: unknown, owner: string, action: string): void {
  if (isCancellation(err)) return;
  useErrorCenterStore().record(describeFailure(err, owner, action, 'component'));
}

/** WE stopped it, so it is not news. */
export function isCancellation(err: unknown): boolean {
  if (err instanceof BffApiError) return err.cancelled === true;
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * A round that gave up at its cap says so.
 *
 * Otherwise the cap is silent: the page keeps whatever landed before it, the
 * countdown starts again, and nothing anywhere says a refresh was abandoned —
 * so an operator reading a minute-old figure has no way to know it is one.
 *
 * Wired here rather than in the store because the store must not import this
 * module: it is imported BY the time store, and reaching back would close a
 * cycle at module-evaluation time.
 */
export function reportCappedRounds(): void {
  const center = useErrorCenterStore();
  useAutoRefreshStore().onRoundCapped((round) => {
    center.record({
      scope: 'refresh',
      owner: 'Refresh',
      action: 'refreshing the page',
      summary: 'The refresh took too long and was given up on.',
      summaryKey: 'The refresh took too long and was given up on.',
      trigger: round.trigger,
      roundId: round.roundId,
    });
    // If they asked for it, say so where they are looking — a refresh the
    // operator pressed that quietly gave up is the same silence the history
    // exists to break.
    if (OPERATOR_TRIGGERS.has(round.trigger)) center.announceRound(round.roundId);
  });
}

/**
 * Signing out clears the failures.
 *
 * Registered once at module level, and it looks the store up at reset time
 * rather than closing over an instance — the registry never unregisters, so a
 * listener added per store instance would keep clearing whichever instance
 * happened to be created first.
 */
onSessionReset(() => {
  useErrorCenterStore().reset();
});
