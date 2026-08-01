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
 * session server-side — call {@link resetSessionState}, so nothing one
 * operator's session read can be served to the next one in the same tab.
 *
 * The Vue Query cache and the event log are cleared here unconditionally.
 * Feature modules that keep server data in a module-level singleton register
 * with {@link onSessionReset} at import time: a module only has to be LOADED
 * to be covered, which is exactly when it holds state worth dropping, and this
 * module never imports a feature — so registering cannot create an import
 * cycle through the auth store.
 */

import { resetQueryCache } from '@/api/queryClient';
import { resetEventLog } from '@/controls/eventLog';

type SessionReset = () => void;

const resets = new Set<SessionReset>();

/** Register a module-level cache to be dropped on every identity change. */
export function onSessionReset(fn: SessionReset): void {
  resets.add(fn);
}

/** Drop everything the previous identity put in memory. Synchronous on
 *  purpose: callers run it in the same tick they clear the user, so no
 *  reactive effect can observe "still authenticated" with a live cache. */
export function resetSessionState(): void {
  resetQueryCache();
  resetEventLog();
  for (const fn of resets) fn();
}
