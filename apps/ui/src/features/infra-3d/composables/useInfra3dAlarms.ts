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
 * Past-20-minute alarm overlay for the 3D infra map. Polls
 * `/api/alarms?startTime=now-20m&endTime=now` on a short interval and
 * exposes the set of currently-alarmed service names — the scene reads
 * this set to flip affected cubes to the alarm-red material.
 *
 *   - 20m rolling window matches the alarm-page topbar default; the
 *     operator's mental model is "anything fresh enough to still be a
 *     concern."
 *   - We key on `service.name`. OAP returns `alarm.name` equal to the
 *     entity name when `scope === 'Service'`, which matches the
 *     `SceneServiceNode.name` field rendered on the cube. ServiceRelation
 *     / Endpoint / Process scopes don't map to a single cube and are
 *     ignored — they'd flag the wrong service.
 *   - We include both firing alarms (recoveryTime === null) and
 *     recently-recovered alarms (any alarm whose event lands in the
 *     window). Operators want to see "this service had trouble in the
 *     last 20m" even if it's currently fine — the red is a recency
 *     signal, not a live state.
 *   - Polled at 30s. Fast enough that a new firing alarm shows up
 *     within a refresh; slow enough that the cost is negligible.
 */

import { onMounted, onUnmounted, readonly, ref, shallowRef } from 'vue';
import { bff } from '../../../api/client';

const TWENTY_MIN_MS = 20 * 60_000;
const POLL_INTERVAL_MS = 60_000;
const FETCH_PAGE_SIZE = 500;

const alarmedServiceNames = shallowRef<Set<string>>(new Set());
const lastUpdatedAt = ref<number | null>(null);
const error = ref<string | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;
let refcount = 0;

async function refresh(): Promise<void> {
  if (inflight) return inflight;
  const now = Date.now();
  inflight = (async () => {
    try {
      const r = await bff.alarms.list({
        startTime: now - TWENTY_MIN_MS,
        endTime: now,
        pageSize: FETCH_PAGE_SIZE,
        pageNum: 1,
      });
      const next = new Set<string>();
      for (const m of r.msgs) {
        // Only single-service alarms — relation/instance/endpoint
        // alarms would otherwise spuriously redden every cube that
        // shares a name fragment. ServiceInstance / Process are
        // intentionally skipped: their entity name carries an instance
        // suffix that doesn't match `service.name` on the cube.
        if (m.scope !== 'Service') continue;
        if (typeof m.name === 'string' && m.name.length > 0) next.add(m.name);
      }
      alarmedServiceNames.value = next;
      lastUpdatedAt.value = Date.now();
      error.value = null;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function useInfra3dAlarms() {
  onMounted(() => {
    refcount++;
    if (refcount === 1) {
      // First subscriber kicks the timer + does an immediate fetch.
      void refresh();
      timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    }
  });
  onUnmounted(() => {
    refcount = Math.max(0, refcount - 1);
    if (refcount === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  });
  return {
    alarmedServiceNames: readonly(alarmedServiceNames),
    lastUpdatedAt: readonly(lastUpdatedAt),
    error: readonly(error),
    /** Force-refresh outside the timer (e.g. on visibility change). */
    refresh,
  };
}
