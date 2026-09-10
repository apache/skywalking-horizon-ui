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
 * Deterministic mock-data generators for the OverviewTemplates admin edit
 * canvas. The canvas renders the REAL overview widget primitives (Metric /
 * KpiTile / MetricComposite) so the preview matches the live page, but with
 * fabricated values — the operator is designing layout + scope, not browsing
 * live data, so a BFF round-trip per keystroke would be wasteful.
 *
 * Everything is keyed off the widget id (+ KPI label) so a single widget's
 * preview stays stable as the operator tweaks it — flipping span / rowSpan or
 * editing a sibling shouldn't jiggle the numbers under their cursor.
 */

import { LANDING_TOP_N_MAX, CALENDAR_HEATMAP_WINDOW_DAYS_DEFAULT, type OverviewWidget } from '@skywalking-horizon-ui/api-client';
import { DAY_MS, HOUR_MS, formatDay, formatHour, resolutionFor, weekdayIndex, type CalendarHeatmapSeries } from '@/render/widgets/calendarHeatmap';
import type { RankingRow } from '@/render/widgets/ranking';

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function mockNumber(seed: string, max = 999): number {
  return hash(seed) % max;
}

export function mockPercent(seed: string): number {
  return 10 + (hash(seed) % 85);
}

/** Mock alarm rows for the preview's alarms widget. Deterministic
 *  per widget id so the rows don't churn while editing. */
const MOCK_ALARM_MSGS = [
  'Response time of service mesh-svr::cart is more than 20ms.',
  'JVM old-gen GC > 5s/min on agent::orders',
  'p95 SLA below threshold for service mesh-svr::reviews',
];
const MOCK_ALARM_SCOPES = ['Service · mesh-svr::cart', 'Instance · pod-2 of agent::orders', 'Service · reviews'];
const MOCK_ALARM_AGES = ['2m', '14m', '47m'];

export interface MockAlarmRow {
  key: string;
  firing: boolean;
  msg: string;
  scope: string;
  since: string;
}

export function mockAlarms(seed: string, n: number): MockAlarmRow[] {
  const out: MockAlarmRow[] = [];
  const cap = Math.max(0, Math.min(n, MOCK_ALARM_MSGS.length));
  for (let i = 0; i < cap; i++) {
    out.push({
      key: `${seed}::${i}`,
      firing: (hash(seed + i) % 4) !== 0, // ~3/4 firing
      msg: MOCK_ALARM_MSGS[i]!,
      scope: MOCK_ALARM_SCOPES[i]!,
      since: MOCK_ALARM_AGES[i]!,
    });
  }
  return out;
}

/** Mock daily series for the calendar heatmap — the widget's own window
 *  ending today, weekends quieter, stable per widget id. */
/** Quiet weekends at day resolution; office hours at hour resolution. */
export function mockCalendarSeries(w: OverviewWidget): CalendarHeatmapSeries {
  const days = w.windowDays ?? CALENDAR_HEATMAP_WINDOW_DAYS_DEFAULT;
  if (resolutionFor(days, w.resolution) === 'hour') {
    const start = Date.now() - (days * 24 - 1) * HOUR_MS;
    return {
      resolution: 'hour',
      start: formatHour(start),
      values: Array.from({ length: days * 24 }, (_, i) => {
        const hour = new Date(start + i * HOUR_MS).getUTCHours();
        return (hour >= 9 && hour < 19 ? 4 : hour < 6 ? 0 : 1) * mockNumber(`${w.id}#${i}`);
      }),
    };
  }
  const start = Date.now() - (days - 1) * DAY_MS;
  return {
    resolution: 'day',
    start: formatDay(start),
    values: Array.from({ length: days }, (_, i) =>
      (weekdayIndex(start + i * DAY_MS) >= 5 ? 1 : 4) * mockNumber(`${w.id}#${i}`),
    ),
  };
}

/** Mock value per KPI label for the real widget components — percent /
 *  progress-bar rows get a 0-100 value, everything else a plain number.
 *  Keyed by widget id + label so it's stable across re-renders. */
export function mockKpiValues(w: OverviewWidget): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const k of w.kpis ?? []) {
    out[k.label] =
      k.unit === '%' || k.style === 'progress-bar'
        ? mockPercent(w.id + k.label)
        : mockNumber(w.id + k.label, k.max ?? 999);
  }
  return out;
}

/** Ranked rows for a `ranking` widget: `limit` services of the widget's
 *  layer with values falling from the top, stable per widget. */
export function mockRanking(w: OverviewWidget): RankingRow[] {
  const n = Math.min(LANDING_TOP_N_MAX, Math.max(1, w.limit ?? 10));
  const layer = (w.layer ?? 'service').toLowerCase();
  return Array.from({ length: n }, (_, i) => ({
    serviceId: `${w.id}#${i}`,
    name: `${layer}-${i + 1}`,
    value: (mockNumber(`${w.id}#${i}`, 400) + 600) * (n - i),
  }));
}
