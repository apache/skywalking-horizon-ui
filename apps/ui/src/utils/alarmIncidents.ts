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
 * Incident merging for the alarms surface.
 *
 * OAP emits one `AlarmMessage` per firing — a rule that re-fires
 * after its silence period creates a new row. From the operator's
 * triage perspective these N rows are ONE incident on (entity, rule),
 * not N separate alarms. The wire `id` field is
 * `<entityBase64>.<ruleNumber>` and is stable across firings of the
 * same rule on the same entity, so it's a free incident key.
 *
 * Merging rules:
 *   - Group `AlarmMessage[]` by `id`.
 *   - Sort each group by `startTime` ascending — the LAST entry is
 *     the most recent firing.
 *   - The incident's state is `firing` when the latest entry's
 *     `recoveryTime` is null, else `recovered`. The state of earlier
 *     entries doesn't matter; only the tail decides.
 *   - Latest entry's `message` / `name` / `scope` / `layerKey` /
 *     `tags` / `snapshot` represent the incident — those are what
 *     the operator sees in the row.
 *
 * Count semantics (per the spec):
 *   - Page totals + topbar badge + per-layer chips count ACTIVE
 *     incidents (state === 'firing'). A fully-recovered incident
 *     contributes nothing — the operator's "what's on fire right
 *     now?" view stays clean.
 *   - The Timeline chart keeps every individual event so the
 *     fire-then-recovered pattern is still visible; events are split
 *     by state into separate series (firing red, recovered green).
 */

import type { AlarmMessage } from '@/api/client';

export interface AlarmIncident {
  /** OAP id field — `<entityBase64>.<ruleNumber>`. Stable per
   *  (entity, rule). */
  id: string;
  /** All firings on this (entity, rule) in startTime-asc order. */
  events: AlarmMessage[];
  /** Convenience handles to the head + tail of `events`. */
  oldest: AlarmMessage;
  latest: AlarmMessage;
  /** Latest firing's recovery state — `firing` when still active,
   *  `recovered` when OAP cleared it. */
  state: 'firing' | 'recovered';
  /** Number of individual firings in this incident. */
  triggerCount: number;
  /** Number of events where `recoveryTime !== null`. */
  recoveredCount: number;
  /** layerKey from the latest event (best-effort tag the BFF adds). */
  layerKey: string | null;
}

export function mergeIncidents(events: AlarmMessage[]): AlarmIncident[] {
  if (events.length === 0) return [];
  const groups = new Map<string, AlarmMessage[]>();
  for (const e of events) {
    let arr = groups.get(e.id);
    if (!arr) {
      arr = [];
      groups.set(e.id, arr);
    }
    arr.push(e);
  }
  const out: AlarmIncident[] = [];
  for (const [id, arr] of groups) {
    arr.sort((a, b) => a.startTime - b.startTime);
    const latest = arr[arr.length - 1]!;
    const oldest = arr[0]!;
    out.push({
      id,
      events: arr,
      oldest,
      latest,
      state: latest.recoveryTime === null ? 'firing' : 'recovered',
      triggerCount: arr.length,
      recoveredCount: arr.filter((e) => e.recoveryTime !== null).length,
      layerKey: latest.layerKey,
    });
  }
  /* Stable display order — most-recent latest event first. */
  out.sort((a, b) => b.latest.startTime - a.latest.startTime);
  return out;
}

/**
 * List-flavored split of incidents.
 *
 * Use for the alarms page's row list (where every firing matters
 * to triage) — NOT for the counts (which should still call
 * `mergeIncidents`).
 *
 * Rules:
 *   - Every FIRING event (`recoveryTime === null`) becomes its own
 *     list row. A rule that re-fired four times against the same
 *     entity, all still active, shows up as four distinct rows so
 *     the operator can see each firing's timestamp + snapshot.
 *   - All RECOVERED events for the same (entity, rule) collapse
 *     into ONE merged row showing "triggered N× · recovered". They
 *     don't count toward active totals, so a single summary line is
 *     enough for the operator to know "this happened and cleared".
 *
 * Output order — newest event first, regardless of whether the row
 * is a firing event or a merged-recovered group.
 */
export function splitForList(events: AlarmMessage[]): AlarmIncident[] {
  if (events.length === 0) return [];

  const out: AlarmIncident[] = [];

  /* Each firing event is its own pseudo-incident with triggerCount=1
   * so the row reads as a single event (no `triggered N×` chip). */
  for (const e of events) {
    if (e.recoveryTime !== null) continue;
    out.push({
      id: `${e.id}::${e.startTime}`,
      events: [e],
      oldest: e,
      latest: e,
      state: 'firing',
      triggerCount: 1,
      recoveredCount: 0,
      layerKey: e.layerKey,
    });
  }

  /* Recovered events: group by OAP id and collapse into one row each.
   * The latest event in the group represents the row (freshest
   * snapshot); `triggerCount` is the recovered count so the chip
   * reads e.g. `triggered 4× · recovered`. */
  const recoveredGroups = new Map<string, AlarmMessage[]>();
  for (const e of events) {
    if (e.recoveryTime === null) continue;
    let arr = recoveredGroups.get(e.id);
    if (!arr) {
      arr = [];
      recoveredGroups.set(e.id, arr);
    }
    arr.push(e);
  }
  for (const [id, arr] of recoveredGroups) {
    arr.sort((a, b) => a.startTime - b.startTime);
    const latest = arr[arr.length - 1]!;
    out.push({
      id,
      events: arr,
      oldest: arr[0]!,
      latest,
      state: 'recovered',
      triggerCount: arr.length,
      recoveredCount: arr.length,
      layerKey: latest.layerKey,
    });
  }

  out.sort((a, b) => b.latest.startTime - a.latest.startTime);
  return out;
}
