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
 * The overview widget drawer's edits, applied IN PLACE to the widget (and KPI)
 * objects the editor's draft holds. Each one also clears what the edit leaves
 * unused, so the draft never carries a setting the drawer no longer shows.
 */

import type { OverviewKpi, OverviewWidget } from '@skywalking-horizon-ui/api-client';

/** The widget types that offer the server-side / page-side aggregation choice. */
export const AGGREGATION_MODE_TYPES: ReadonlySet<OverviewWidget['type']> = new Set(['kpi-tile', 'metric-composite', 'metric']);

/** The ceiling a progress-bar KPI starts with, and the Max field's placeholder. */
export const PROGRESS_BAR_MAX_DEFAULT = 100;

/** Keys of `T` whose value is optional and exactly `V`. */
export type OptionalKey<T, V> = {
  [K in keyof T]-?: undefined extends T[K]
    ? [NonNullable<T[K]>] extends [V]
      ? [V] extends [NonNullable<T[K]>]
        ? K
        : never
      : never
    : never;
}[keyof T];

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** An emptied number field is an absent one, so the documented default applies
 *  again. `v-model.number` would store the raw `""` instead. */
export function setOptionalNumber<T extends object>(target: T, key: OptionalKey<T, number>, raw: string): void {
  const n = raw.trim() === '' ? Number.NaN : Number(raw);
  if (Number.isFinite(n)) (target as Record<OptionalKey<T, number>, number>)[key] = n;
  else delete target[key];
}

/** An emptied optional text field is an absent one. */
export function setOptionalText<T extends object>(target: T, key: OptionalKey<T, string>, raw: string): void {
  if (raw === '') delete target[key];
  else (target as Record<OptionalKey<T, string>, string>)[key] = raw;
}

export function isMqeKpi(k: OverviewKpi): boolean {
  return (k.source ?? 'mqe') === 'mqe';
}

/** The row an absent `rankBy` ranks by: the first `mqe` KPI. */
export function firstMqeKpi(kpis: readonly OverviewKpi[] | undefined): number {
  const i = (kpis ?? []).findIndex(isMqeKpi);
  return i < 0 ? 0 : i;
}

/**
 * `rankBy` as the editor stores it: the separate ranking MQE when one is
 * chosen, else the index of an `mqe` row other than the first. Absent already
 * means the first, and a row that is gone or counts services cannot rank — the
 * renderer falls back to the first column for both.
 */
export function normalRankBy(
  rankBy: OverviewWidget['rankBy'],
  kpis: readonly OverviewKpi[] | undefined,
): OverviewWidget['rankBy'] {
  if (!rankBy) return undefined;
  if (rankBy.mqe != null) return { mqe: rankBy.mqe };
  const i = rankBy.kpi;
  if (i == null) return undefined;
  const k = kpis?.[i];
  if (!k || !isMqeKpi(k) || i === firstMqeKpi(kpis)) return undefined;
  return { kpi: i };
}

function setRankBy(w: OverviewWidget, rankBy: OverviewWidget['rankBy']): void {
  if (rankBy) w.rankBy = rankBy;
  else delete w.rankBy;
}

/** The row a page-side widget ranks by — explicit, or the first `mqe` row an
 *  absent `rankBy` stands for. Null when it ranks by its own MQE, or does not
 *  rank. Resolved before a row edit, so the edit keeps the same row ranking
 *  rather than whichever row the default lands on afterwards. */
function rankedRow(w: OverviewWidget): number | null {
  if (!w.aggregateOnPage || w.rankBy?.mqe != null) return null;
  return w.rankBy?.kpi ?? firstMqeKpi(w.kpis);
}

/** Rank by row `at` of the widget's current rows, stored as `normalRankBy` does. */
function rankByRow(w: OverviewWidget, at: number | undefined): void {
  setRankBy(w, normalRankBy(at === undefined ? undefined : { kpi: at }, w.kpis));
}

/** Swap row `idx` with its neighbour; the ranked row follows its row. */
export function moveKpi(w: OverviewWidget, idx: number, dir: -1 | 1): void {
  const kpis = w.kpis;
  const j = idx + dir;
  if (!kpis || idx < 0 || idx >= kpis.length || j < 0 || j >= kpis.length) return;
  const at = rankedRow(w);
  const next = [...kpis];
  [next[idx], next[j]] = [next[j]!, next[idx]!];
  w.kpis = next;
  if (at === null) setRankBy(w, normalRankBy(w.rankBy, next));
  else rankByRow(w, at === idx ? j : at === j ? idx : at);
}

/** Remove row `idx`. Removing the ranked row falls back to the first `mqe`
 *  row; a ranked row after it shifts with it. */
export function removeKpi(w: OverviewWidget, idx: number): void {
  const kpis = w.kpis;
  if (!kpis || idx < 0 || idx >= kpis.length) return;
  const at = rankedRow(w);
  w.kpis = kpis.filter((_, i) => i !== idx);
  if (at === null) setRankBy(w, normalRankBy(w.rankBy, w.kpis));
  else rankByRow(w, at === idx ? undefined : at > idx ? at - 1 : at);
}

/** A service-count row carries no MQE and cannot rank; a row switched back to
 *  `mqe` starts from an empty expression, as a new row does. */
export function setKpiSource(w: OverviewWidget, idx: number, source: OverviewKpi['source']): void {
  const k = w.kpis?.[idx];
  if (!k || (k.source ?? 'mqe') === (source ?? 'mqe')) return;
  const at = rankedRow(w);
  if (source === 'service-count') {
    k.source = 'service-count';
    delete k.mqe;
    delete k.rangeTotal;
  } else {
    delete k.source;
    k.mqe = '';
  }
  // A row turned into an `mqe` row ahead of the ranked one would otherwise
  // take over an absent `rankBy`.
  if (at === null) setRankBy(w, normalRankBy(w.rankBy, w.kpis));
  else rankByRow(w, at);
}

/** `max` is read only by a progress bar, which cannot draw without one. */
export function fitMaxToStyle(k: OverviewKpi): void {
  if (k.style !== 'progress-bar') delete k.max;
  else if (!isFiniteNumber(k.max)) k.max = PROGRESS_BAR_MAX_DEFAULT;
}

/** What only the page-side path reads: its top-N window, its ranking, a metric
 *  widget's rollup and the KPIs' range totals. `limit` means something else on
 *  the widget types without the choice (alarms, ranking), so they keep it. */
export function dropPageSideOnly(w: OverviewWidget): void {
  if (!AGGREGATION_MODE_TYPES.has(w.type)) return;
  delete w.limit;
  delete w.rankBy;
  if (w.type === 'metric') delete w.aggregation;
  for (const k of w.kpis ?? []) delete k.rangeTotal;
}

/** Absent means server-side, so only page-side is stored. */
export function setAggregateOnPage(w: OverviewWidget, pageSide: boolean): void {
  if (pageSide) {
    w.aggregateOnPage = true;
    return;
  }
  delete w.aggregateOnPage;
  dropPageSideOnly(w);
}
