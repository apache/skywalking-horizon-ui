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
 *   - Only `scope === 'Service'` alarms count: OAP returns `alarm.name`
 *     equal to the service entity name there, matching the cube's
 *     `SceneServiceNode.name`. ServiceRelation / Endpoint / Process
 *     scopes don't map to a single cube and are ignored — they'd flag
 *     the wrong service.
 *   - Matched on a composite `(layer, name)` key (see `alarmKey`), so a
 *     same-named service is reddened only in its own tier; alarms with
 *     no resolved layer fall back to a name-only set.
 *   - Only currently-FIRING alarms (recoveryTime === null) redden a
 *     cube — red means "alarming now", which matches the alarms page's
 *     ACTIVE incident count. A recovered-within-window alarm is no
 *     longer a live problem, so it is NOT reddened (including it made
 *     the map show more red cubes than the page's active count).
 *   - Polled every 1 min (POLL_INTERVAL_MS). Fast enough that a new
 *     firing alarm shows up within a refresh; slow enough that the cost
 *     is negligible.
 */

import { onMounted, onUnmounted, readonly, ref, shallowRef } from 'vue';
import { bff } from '../../../api/client';

const TWENTY_MIN_MS = 20 * 60_000;
const POLL_INTERVAL_MS = 60_000;
const FETCH_PAGE_SIZE = 500;

/** Composite `LAYER\u0000serviceName` keys for alarms that carry a resolved
 *  layer — the precise match (the same service name can exist in several
 *  layers; keying on name alone would redden all of them). */
const alarmedKeys = shallowRef<Set<string>>(new Set());
/** Service names from alarms with NO resolved layer — a name-only
 *  fallback so those alarms still light their cube(s). */
const alarmedNamesNoLayer = shallowRef<Set<string>>(new Set());
const lastUpdatedAt = ref<number | null>(null);

/** Build the composite key the scene matches a cube against. The layer
 *  and name are joined by U+0000, written as a `\u0000` ESCAPE in the
 *  template below — never a raw NUL byte, which would make this a binary
 *  file (unreviewable git diffs, tooling/editor mangling). NUL can appear
 *  in neither an OAP layer key nor a service name, so the join is
 *  collision-proof; both producer and the lone consumer call this, so the
 *  key stays in-memory and is never serialized. */
export function alarmKey(layerKey: string, serviceName: string): string {
  return `${layerKey.toUpperCase()}\u0000${serviceName}`;
}
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
      const keys = new Set<string>();
      const namesNoLayer = new Set<string>();
      for (const m of r.msgs) {
        // Only single-service alarms — relation/instance/endpoint
        // alarms would otherwise spuriously redden every cube that
        // shares a name fragment. ServiceInstance / Process are
        // intentionally skipped: their entity name carries an instance
        // suffix that doesn't match `service.name` on the cube.
        if (m.scope !== 'Service') continue;
        if (typeof m.name !== 'string' || m.name.length === 0) continue;
        // Firing only — a recovered alarm (recoveryTime set) is no longer
        // an active problem. Reddening recovered-within-window alarms made
        // the map show more red cubes than the alarms page's ACTIVE count.
        if (m.recoveryTime !== null) continue;
        // Precise: key on (layer, name) so an alarm reddens only the
        // matching service in the matching tier, not every same-named
        // cube across layers. Alarms with no resolved layer fall back
        // to name-only matching.
        if (m.layerKey) keys.add(alarmKey(m.layerKey, m.name));
        else namesNoLayer.add(m.name);
      }
      alarmedKeys.value = keys;
      alarmedNamesNoLayer.value = namesNoLayer;
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
    alarmedKeys: readonly(alarmedKeys),
    alarmedNamesNoLayer: readonly(alarmedNamesNoLayer),
    lastUpdatedAt: readonly(lastUpdatedAt),
    error: readonly(error),
    /** Force-refresh outside the timer (e.g. on visibility change). */
    refresh,
  };
}
