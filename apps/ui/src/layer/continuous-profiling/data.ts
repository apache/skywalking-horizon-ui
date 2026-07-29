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

import type {
  ContinuousProfilingMonitorType,
  ContinuousProfilingPolicyItem,
  ContinuousProfilingPolicyTarget,
  ContinuousProfilingTargetType,
} from '@skywalking-horizon-ui/api-client';

/** The three eBPF profiling flavours a policy can arm. */
export const TARGET_TYPES: ContinuousProfilingTargetType[] = ['ON_CPU', 'OFF_CPU', 'NETWORK'];

export const MONITOR_TYPES: ContinuousProfilingMonitorType[] = [
  'PROCESS_CPU',
  'PROCESS_THREAD_COUNT',
  'SYSTEM_LOAD',
  'HTTP_ERROR_RATE',
  'HTTP_AVG_RESPONSE_TIME',
];

/**
 * Unit and range per monitor type, so the threshold field can state both.
 *
 * EVERY threshold is a whole number, which Rover's source contradicts: it
 * ParseFloats three of the five. The value never reaches Rover —
 * `ContinuousProfilingMutationService.validatePolicyItem` Integer.parseInts all
 * five at save time. The bounds here are that validator's.
 */
export interface ThresholdSpec {
  unit: string;
  /** OAP's upper bound, or `null` where it only requires > 0. */
  max: number | null;
  example: string;
  /** What the number measures, for the option row in the type selector. */
  measures: string;
}

export const THRESHOLD_SPEC: Record<ContinuousProfilingMonitorType, ThresholdSpec> = {
  PROCESS_CPU: { unit: '%', max: 100, example: '75', measures: 'process CPU, whole percent' },
  PROCESS_THREAD_COUNT: { unit: 'threads', max: null, example: '200', measures: 'thread count, whole number' },
  SYSTEM_LOAD: { unit: 'load', max: null, example: '4', measures: 'host load average' },
  HTTP_ERROR_RATE: { unit: '%', max: 100, example: '5', measures: 'HTTP error rate, whole percent' },
  HTTP_AVG_RESPONSE_TIME: { unit: 'ms', max: null, example: '500', measures: 'HTTP avg response time, ms' },
};

/** Why OAP would refuse this threshold, or `null` when it would take it.
 *  Returns a translation key, not a sentence. */
export function thresholdError(
  type: ContinuousProfilingMonitorType,
  raw: string,
): { key: string; params?: Record<string, number> } | null {
  const spec = THRESHOLD_SPEC[type];
  const text = raw.trim();
  if (!text) return { key: 'A threshold is required.' };
  if (!/^\d+$/.test(text)) return { key: 'Whole numbers only — OAP rejects anything else.' };
  const n = Number(text);
  if (n <= 0) return { key: 'Must be greater than 0.' };
  if (spec.max !== null && n > spec.max) return { key: 'Must be 1–{max}.', params: { max: spec.max } };
  return null;
}

/** Only the HTTP monitors sample by URI; the process/system ones have no URI
 *  dimension, so the filter fields stay hidden for them. */
export function supportsUriFilter(type: ContinuousProfilingMonitorType): boolean {
  return type === 'HTTP_ERROR_RATE' || type === 'HTTP_AVG_RESPONSE_TIME';
}

/** OAP refuses two items of the same monitor type in one target, so a new row
 *  takes the first type the target is not using. */
export function newCheckItem(taken: ContinuousProfilingMonitorType[] = []): ContinuousProfilingPolicyItem {
  const free = MONITOR_TYPES.find((m) => !taken.includes(m)) ?? 'PROCESS_CPU';
  return { type: free, threshold: '', period: 60, count: 3 };
}

/** Roster search: a process name finds the instance holding it, because an
 *  operator chasing "envoy" knows the process, not the pod. */
export function matchRoster<T extends { name: string; processes: Array<{ name: string }> }>(
  rows: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter(
    (i) => i.name.toLowerCase().includes(q) || i.processes.some((p) => p.name.toLowerCase().includes(q)),
  );
}

/** One page, with the page number CLAMPED to what the (possibly narrowed) set
 *  still has — a search that shrinks the result must never strand the view on
 *  an empty page. `from`/`to` are 1-based and inclusive, for display. */
export function pageOf<T>(
  items: readonly T[],
  page: number,
  size: number,
): { rows: T[]; page: number; pages: number; from: number; to: number } {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const rows = items.slice((p - 1) * size, p * size);
  const from = items.length ? (p - 1) * size + 1 : 0;
  return { rows, page: p, pages, from, to: from + rows.length - 1 };
}

/** Which service the tab should land on when nothing is selected: the first one
 *  that already has rules, else the first of the layer. A service the summary
 *  could not answer for (`null`) counts as un-armed — landing on it would show
 *  an empty editor while an armed service was right there. */
export function pickDefaultService<T extends { id: string }>(
  services: readonly T[],
  summary: ReadonlyMap<string, ContinuousProfilingTargetType[] | null>,
): T | null {
  if (!services.length) return null;
  return services.find((s) => (summary.get(s.id) ?? []).length > 0) ?? services[0];
}

/** Everything OAP would refuse about a draft, so Apply can be disabled BEFORE
 *  the round trip — OAP answers with one string for the first bad item, which
 *  makes the operator bisect their own rules.
 *
 *  `target` / `measurement` are OAP enum values and are rendered verbatim, so
 *  the message key never has to interpolate another key. */
export interface PolicyError {
  target: ContinuousProfilingTargetType;
  measurement?: ContinuousProfilingMonitorType;
  key: string;
  params?: Record<string, number>;
}

export function policyErrors(targets: readonly ContinuousProfilingPolicyTarget[]): PolicyError[] {
  const out: PolicyError[] = [];
  for (const t of targets) {
    if (!t.checkItems.length) out.push({ target: t.type, key: 'Add at least one condition.' });
    const seen = new Set<ContinuousProfilingMonitorType>();
    for (const it of t.checkItems) {
      const at = { target: t.type, measurement: it.type };
      if (seen.has(it.type)) out.push({ ...at, key: 'This measurement is used twice.' });
      seen.add(it.type);
      const bad = thresholdError(it.type, it.threshold);
      if (bad) out.push({ ...at, key: bad.key, params: bad.params });
      if (!Number.isInteger(it.period) || it.period <= 0) {
        out.push({ ...at, key: 'Period must be a whole number greater than 0.' });
      }
      if (!Number.isInteger(it.count) || it.count <= 0) {
        out.push({ ...at, key: 'Times before triggering must be a whole number greater than 0.' });
      } else if (Number.isInteger(it.period) && it.count > it.period) {
        out.push({ ...at, key: 'Times before triggering cannot exceed the period.' });
      }
    }
  }
  return out;
}

/** True when a selected serviceId does not belong to this layer's roster —
 *  a `?service=` seed from another layer, or a stale route param. `false`
 *  while the roster is still loading, so a fetch-in-flight is never
 *  misread as "this id belongs to no layer". */
export function isForeignSeed(
  serviceId: string | null,
  services: readonly { id: string }[],
  servicesLoading: boolean,
): boolean {
  return !!serviceId && !servicesLoading && !services.some((s) => s.id === serviceId);
}

/** Whether a roster READ can be trusted: not while the request itself never
 *  completed (network failure, BFF down — vue-query's `error`), and not when
 *  the BFF answered but could not reach OAP (`reachable:false` in the body).
 *  Absent data with no error (still loading) defaults to true — there is
 *  nothing to call unreachable yet. */
export function rosterReachable(dataReachable: boolean | undefined, hasQueryError: boolean): boolean {
  return !hasQueryError && (dataReachable ?? true);
}

/** Whether the layer-landing watcher should auto-pick a default service this
 *  tick, and whether it should first forget an earlier auto-pick.
 *
 *  The "forget" half matters on its own: `autoPickedFor` exists so a pick,
 *  once made for a layer, is not re-fought if the operator clears it — but
 *  that memory must not survive a genuine layer change (A -> B -> A). Without
 *  resetting on `prevKey !== key`, a layer with zero services (B) never gets
 *  the chance to record a pick, so returning to A finds the marker still set
 *  to A from before and skips picking — even though the id was cleared by the
 *  navigation itself, not by anything the operator did on A.
 */
export function autoPickDecision(input: {
  key: string;
  prevKey: string | null;
  hasServiceId: boolean;
  seedIsForeign: boolean;
  servicesLoading: boolean;
  summaryFetching: boolean;
  autoPickedFor: string | null;
}): { resetMarker: boolean; shouldPick: boolean } {
  const resetMarker = input.prevKey !== null && input.prevKey !== input.key;
  const effectiveMarker = resetMarker ? null : input.autoPickedFor;
  const shouldPick =
    !!input.key &&
    !input.servicesLoading &&
    !(input.hasServiceId && !input.seedIsForeign) &&
    !(effectiveMarker === input.key && !input.seedIsForeign) &&
    !input.summaryFetching;
  return { resetMarker, shouldPick };
}

/** Whether a successful save should reseed the draft from the just-confirmed
 *  server read.
 *
 *  Three ways an unconditional reseed goes wrong, all avoided here:
 *  - The confirmation read itself can fail or answer unreachable — reseeding
 *    from a failed read presents whatever was there BEFORE as "applied"
 *    (stale-vs-old, not stale-vs-new).
 *  - The operator can keep editing while the save request is in flight
 *    (nothing disables the form); reseeding then would discard an edit that
 *    was never sent, using the OLDER snapshot this request actually submitted.
 *  - The operator can switch to a DIFFERENT service while the save is in
 *    flight (nothing disables the picker either); `draft` at that point holds
 *    the OTHER service's edits, and reseeding it with THIS save's confirmed
 *    policy would silently overwrite them with the wrong service's data.
 *
 *  Comparing serialised snapshots rather than object identity, since `draft`
 *  is a plain array the caller mutates in place. */
export function shouldReseedAfterSave(
  confirm: { succeeded: boolean; reachable: boolean | undefined },
  currentDraftJson: string,
  submittedDraftJson: string,
  currentServiceId: string | null,
  savedServiceId: string,
): boolean {
  return (
    confirm.succeeded &&
    !!confirm.reachable &&
    currentDraftJson === submittedDraftJson &&
    currentServiceId === savedServiceId
  );
}

export type UriMode = 'none' | 'list' | 'regex';

/** Which URI-filter mode a check item is actually in, from its wire fields.
 *  Never derived reactively from the item inside the form — see the "identity
 *  swap" watchers in CheckItemRow.vue for why the mode is local state,
 *  re-seeded only on genuine item-identity changes. */
export function modeOf(it: { uriList?: string[] | null; uriRegex?: string | null }): UriMode {
  if ((it.uriList ?? []).length) return 'list';
  if (it.uriRegex) return 'regex';
  return 'none';
}

/** Whether an item-identity-changed watcher should re-seed `uriMode` (and, in
 *  the caller, clear any pending confirmation with it).
 *
 *  `incoming === 'none'` never reseeds — an item can legitimately be edited
 *  down to "no filter yet" by the operator's own typing, which is not an
 *  identity swap. `incoming === current` never reseeds either, since nothing
 *  actually changed. Only a DIFFERENT, non-empty mode means the row is now
 *  showing a different item than the one it was — see PolicyTargetCard.vue's
 *  index-keyed `v-for`, which reuses component instances across a removal. */
export function shouldReseedUriMode(incoming: UriMode, current: UriMode): boolean {
  return incoming !== 'none' && incoming !== current;
}
