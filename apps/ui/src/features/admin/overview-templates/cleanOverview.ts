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

import type { OverviewDashboard, OverviewKpi, OverviewWidget } from '@skywalking-horizon-ui/api-client';
import { AGGREGATION_MODE_TYPES, dropPageSideOnly, fitMaxToStyle, isFiniteNumber, normalRankBy } from './widgetEdits';

const NUMBER_FIELDS = ['cols', 'span', 'rowSpan', 'windowDays', 'limit'] as const;

function isBlank(v: unknown): boolean {
  return typeof v === 'string' && v.trim() === '';
}

/**
 * A copy of `d` as the overview editor saves and pushes it: only what its
 * current settings use. Whatever the drawer hides for a widget's type and mode
 * is dropped, an emptied number or optional text is absent, and a KPI or
 * ranking field that the rest of the widget no longer supports goes with it.
 */
export function cleanOverview(d: OverviewDashboard): OverviewDashboard {
  const out = JSON.parse(JSON.stringify(d)) as OverviewDashboard;
  // The sidebar lists an overview for every layer in `layers` AND every layer
  // its widgets name. This editor never shows `layers`, so a stale entry would
  // keep the overview listed for a layer none of its widgets reads.
  delete out.layers;
  if (isBlank(out.description)) delete out.description;
  for (const w of out.widgets ?? []) cleanWidget(w);
  return out;
}

function cleanWidget(w: OverviewWidget): void {
  for (const key of NUMBER_FIELDS) {
    if (w[key] !== undefined && !isFiniteNumber(w[key])) delete w[key];
  }
  if (isBlank(w.tip)) delete w.tip;
  if (w.aggregateOnPage !== true) delete w.aggregateOnPage;
  // A metric widget renders its own MQE; KPI rows on it would only widen what
  // the BFF lets the overview evaluate layer-wide.
  if (w.type === 'metric') delete w.kpis;
  if (!w.aggregateOnPage) dropPageSideOnly(w);
  for (const k of w.kpis ?? []) cleanKpi(k);
  const rankBy = w.aggregateOnPage && AGGREGATION_MODE_TYPES.has(w.type) ? normalRankBy(w.rankBy, w.kpis) : undefined;
  if (rankBy) w.rankBy = rankBy;
  else delete w.rankBy;
}

function cleanKpi(k: OverviewKpi): void {
  if (k.source === 'service-count') {
    delete k.mqe;
    delete k.rangeTotal;
  }
  fitMaxToStyle(k);
}
