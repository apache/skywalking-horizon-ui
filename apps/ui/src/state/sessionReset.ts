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
 * The one seam every identity change goes through. All three entry points —
 * an explicit logout, a fresh login, and the mid-session 401 that ends a
 * session server-side — call {@link resetSessionState}.
 *
 * What it guarantees: at the moment it returns, the Vue Query cache, the event
 * log, and every module-level singleton that REGISTERED with
 * {@link onSessionReset} hold nothing the previous identity read; and a read
 * that was already in flight cannot repopulate them afterwards. Removing a
 * query destroys it (which cancels its fetch), and the hand-rolled module
 * loaders re-check {@link isCurrentEpoch} before publishing their answer.
 *
 * What it does NOT cover: a component that is mounted at the instant of the
 * change keeps the values its query observer last painted — TanStack exposes
 * no API to evict a rendered value from a live observer, so those pixels
 * survive until the component unmounts (every route change to the login page
 * unmounts the page it was on) or its query refetches under the new identity.
 * Nothing behind them survives: the cache entry is gone, so the next mount
 * fetches afresh.
 *
 * Registrants register at import time: a module only has to be LOADED to be
 * covered, which is exactly when it holds state worth dropping — one that the
 * session never imported has nothing to leak. This module never imports a
 * feature, so registering cannot create an import cycle through the auth store.
 */

import { resetQueryCache } from '@/api/queryClient';
import { resetEventLog } from '@/controls/eventLog';

type SessionReset = () => void;

const resets = new Set<SessionReset>();
let epoch = 0;

/** Register a module-level cache to be dropped on every identity change. */
export function onSessionReset(fn: SessionReset): void {
  resets.add(fn);
}

/** The current identity generation. A module that publishes a fetched value
 *  into a module-level singleton captures this BEFORE awaiting and re-checks
 *  it with {@link isCurrentEpoch} before writing: the reset cannot cancel a
 *  fetch it doesn't own, but it can keep the answer from being published. */
export function sessionEpoch(): number {
  return epoch;
}

/** True while `captured` is still the live generation — false once an
 *  identity change has superseded the work that captured it. */
export function isCurrentEpoch(captured: number): boolean {
  return captured === epoch;
}

/** Drop everything the previous identity put in memory. Synchronous on
 *  purpose: callers run it in the same tick they clear the user, so no
 *  reactive effect can observe "still authenticated" with a live cache. */
export function resetSessionState(): void {
  // Bumped first: registrants below (and anything they trigger) must already
  // see the new generation, or a load superseded mid-flight would publish.
  epoch++;
  resetQueryCache();
  resetEventLog();
  for (const fn of resets) {
    try {
      fn();
    } catch (err) {
      // A throwing registrant must not skip its siblings or reject the caller:
      // logout() awaits this before routing to the login page, so a throw here
      // would strand the operator on a page whose session is already gone.
      console.error('[sessionReset] a registered reset threw:', err);
    }
  }
}
