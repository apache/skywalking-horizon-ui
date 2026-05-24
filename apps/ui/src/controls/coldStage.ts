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
 * "Query cold stage" — a process-wide toggle that switches every
 * OAP read from hot+warm to BanyanDB's cold stage.
 *
 * IMPORTANT — read this before editing: OAP's `Duration.coldStage: true`
 * REPLACES the hot+warm read, it does not union with it (see the
 * comment on `Duration.coldStage` in OAP's common.graphqls, and the
 * BanyanDBTTLStatusQuery source). For the demo OAP with hot+warm=8d /
 * cold=30d, "ON" returns data only when the queried window falls
 * within roughly 8–38 days ago; turning it on while looking at a
 * recent dashboard makes every widget go empty. The UI surfaces this
 * trap loudly in the topbar tooltip + the TTL page; the toggle itself
 * is intentionally manual (operator discipline) rather than auto-
 * routed by time range — the latter would double wire traffic on
 * windows that span the boundary.
 *
 * Wire path: the flag travels with every BFF request via the
 * `X-Horizon-Cold-Stage` header (see {@link COLD_STAGE_HEADER}). The
 * BFF maps the header onto `req.coldStage` and splices
 * `coldStage: true` into every OAP `Duration` it constructs. OAP
 * silently ignores the field for non-BanyanDB storage, so the chrome
 * is safe to send always — the topbar hides the affordance when
 * `backend !== 'banyandb'` so other-backend operators aren't offered
 * a no-op switch.
 *
 * The setting is sticky per browser (localStorage) so an operator
 * deep in a cold investigation doesn't lose context on reload.
 * Flipping the toggle invalidates every cached query so subscribers
 * refetch with the new header instead of serving the previous stage's
 * data.
 */

import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import type { QueryClient } from '@tanstack/vue-query';

export const COLD_STAGE_HEADER = 'X-Horizon-Cold-Stage';

const STORAGE_KEY = 'horizon:coldStage:v1';

function detectInitial(): boolean {
  if (typeof localStorage !== 'undefined') {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === '1') return true;
  }
  return false;
}

export const useColdStageStore = defineStore('cold-stage', () => {
  const enabled = ref<boolean>(detectInitial());

  // Persist on every change so the next page-load picks up where we
  // left off. localStorage may be unavailable (private mode) — fall
  // back to in-memory and let it reset on reload.
  watch(enabled, (on) => {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
    } catch {
      /* private mode / quota — degrade silently */
    }
  });

  /** Flip the flag. When `client` is passed (which the topbar does on
   *  every toggle), every cached query is invalidated so subscribers
   *  refetch with the new header — otherwise the cache would serve the
   *  previous warm-only payload until the next time-range change. */
  function toggle(client?: QueryClient): void {
    enabled.value = !enabled.value;
    client?.invalidateQueries();
  }
  function set(on: boolean, client?: QueryClient): void {
    if (enabled.value === on) return;
    enabled.value = on;
    client?.invalidateQueries();
  }

  return { enabled, toggle, set };
});

/** Synchronous snapshot for the API client's fetch interceptor —
 *  called per request and must not depend on a Vue component context.
 *  Reads localStorage directly so the value is fresh even when the
 *  Pinia store hasn't been instantiated yet (early bootstrap). */
export function readColdStageHeader(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}
