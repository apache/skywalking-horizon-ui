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

import { onScopeDispose, toValue } from 'vue';
import type { MaybeRefOrGetter } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { useAutoRefreshStore } from '@/controls/autoRefresh';

/**
 * Subscribe a refetch callback to the global auto-refresh ticker.
 *
 * Composables (or views) call this with their query's `refetch` to pick up
 * manual refreshes and interval-driven rounds from the topbar. Registration
 * only — the store CALLS the subscriber, so there is no watcher here — and it
 * is anchored to the calling scope, so unmounting tears it down.
 *
 * **Return the promise.** The ticker counts its next interval from when the
 * ROUND FINISHES, not from when it started, and a callback that returns
 * nothing is indistinguishable from one that finished instantly — so a
 * subscriber that swallows its promise makes the countdown describe a round
 * that is still running. `void refetch()` inside the callback is the easy way
 * to get this wrong.
 *
 * **Refetch with `{ cancelRefetch: false }`.** A round must produce ONE request
 * per logical query, and the default cancels whatever is already in flight and
 * starts again — so two components sharing a query, or a key that has just
 * moved (flipping the cold stage does exactly that), issued the request twice
 * and threw the first away. Joining the fetch already out gives one request and
 * one answer, which both observers then share.
 */
export function useAutoRefreshSubscribe(
  refetch: () => Promise<unknown> | unknown,
  /**
   * The COMPONENT half of the control, beside the operator's global switch.
   *
   * A subscriber that is not ready — no service picked yet, a replay block, a
   * block that froze its own window — is skipped for the round entirely: not
   * called, and not awaited. Pass the query's OWN `enabled` ref rather than
   * re-deriving the condition, because `refetch()` bypasses `enabled` and a
   * second copy of the rule will eventually disagree with the first and fetch
   * where the query itself would not.
   */
  enabled?: MaybeRefOrGetter<boolean>,
  /**
   * The query this subscription refetches, so a capped round can CANCEL it.
   *
   * Without a key the round can only stop waiting; with one it cancels the
   * query, and a query function that took the signal it was handed aborts the
   * request itself. Optional because a subscriber that cannot be cancelled is
   * still better joined to the round than left on a timer of its own.
   */
  queryKey?: MaybeRefOrGetter<readonly unknown[] | readonly (readonly unknown[])[]>,
): void {
  const auto = useAutoRefreshStore();
  const queryClient = queryKey === undefined ? null : useQueryClient();
  // Registration ONLY. The store runs the round and awaits what it collects —
  // also watching `tickCount` here would fetch twice per round.
  onScopeDispose(
    auto.joinRound((signal: AbortSignal) => {
      if (enabled !== undefined && !toValue(enabled)) return undefined;
      if (queryClient !== null) {
        // One key, or several — a fan-out subscriber (the dashboard's compare
        // cohort, the overview's per-layer groups) is one participant holding
        // many queries, and cancelling only the first would leave the rest
        // running past the cap the round is enforcing.
        const named = toValue(queryKey!);
        const keys: readonly (readonly unknown[])[] =
          named.length > 0 && Array.isArray(named[0])
            ? (named as readonly (readonly unknown[])[])
            : [named as readonly unknown[]];
        signal.addEventListener(
          'abort',
          () => {
            for (const key of keys) void queryClient.cancelQueries({ queryKey: key, exact: true });
          },
          { once: true },
        );
      }
      return refetch();
    }),
  );
}
