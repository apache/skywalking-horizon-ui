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
 * Default dashboard widget sets per OAP layer enum. These are lifted
 * verbatim from the booster-ui templates the operator already knows —
 * see `docs/design/research/booster-templates/<layer>/<layer>-service.json`
 * for the source rows. Operators can edit + persist their own set via
 * the admin pages under Dashboard setup; this file is the seed the
 * BFF falls back to when OAP holds no overriding template.
 *
 * 24-column grid: matches booster-ui's vue-grid-layout dimensions so
 * positions and spans port without rework.
 */

import type { DashboardWidget } from '@skywalking-horizon-ui/api-client';
import type { LayerTemplate } from '../layers/loader.js';

/** Service-scope service-shaped layers (general / mesh / k8s_service). */
const SERVICE_WIDGETS: DashboardWidget[] = [
  {
    id: 'apdex',
    title: 'Service Apdex',
    tip: 'User satisfaction score on a 0–1 scale. service_apdex is integer-times-10000 server-side; expression divides to bring it into a familiar 0–1 range.',
    type: 'card',
    expressions: ['avg(service_apdex)/10000'],
    x: 0, y: 0, w: 8, h: 5,
  },
  {
    id: 'sla',
    title: 'Success Rate',
    tip: 'Percentage of successful requests. Source field is integer-times-100.',
    type: 'card',
    unit: '%',
    expressions: ['avg(service_sla)/100'],
    x: 8, y: 0, w: 8, h: 5,
  },
  {
    id: 'traffic',
    title: 'Traffic',
    tip: 'Requests per minute (cpm). For HTTP / gRPC / RPC services this reflects request throughput.',
    type: 'card',
    unit: 'rpm',
    expressions: ['avg(service_cpm)'],
    x: 16, y: 0, w: 8, h: 5,
  },
  {
    id: 'resp_time',
    title: 'Service Avg Response Time',
    tip: 'Mean latency across all calls in the window.',
    type: 'line',
    unit: 'ms',
    expressions: ['service_resp_time'],
    x: 0, y: 5, w: 12, h: 14,
  },
  {
    id: 'percentile',
    title: 'Service Response Time Percentile',
    tip: 'Latency at p50 / p75 / p90 / p95 / p99 — useful for tail behavior.',
    type: 'line',
    unit: 'ms',
    expressions: [
      "service_percentile{p='50'}",
      "service_percentile{p='75'}",
      "service_percentile{p='90'}",
      "service_percentile{p='95'}",
      "service_percentile{p='99'}",
    ],
    x: 12, y: 5, w: 12, h: 14,
  },
  {
    id: 'traffic_line',
    title: 'Traffic (line)',
    type: 'line',
    unit: 'rpm',
    expressions: ['service_cpm'],
    x: 0, y: 19, w: 12, h: 12,
  },
  {
    id: 'sla_line',
    title: 'Success Rate (line)',
    type: 'line',
    unit: '%',
    expressions: ['service_sla/100'],
    x: 12, y: 19, w: 12, h: 12,
  },
];

/** Browser-layer service-scope widgets (`browser` enum). Pulled from
 *  booster-templates/browser/browser-app.json. */
const BROWSER_WIDGETS: DashboardWidget[] = [
  {
    id: 'app_pv',
    title: 'Page Views',
    type: 'card',
    expressions: ['avg(browser_app_pv)'],
    x: 0, y: 0, w: 8, h: 5,
  },
  {
    id: 'app_error_rate',
    title: 'Page Error Rate',
    type: 'card',
    unit: '%',
    expressions: ['avg(browser_app_page_error_rate)/100'],
    x: 8, y: 0, w: 8, h: 5,
  },
  {
    id: 'app_error_sum',
    title: 'Page Errors',
    type: 'card',
    expressions: ['avg(browser_app_error_sum)'],
    x: 16, y: 0, w: 8, h: 5,
  },
  {
    id: 'app_pv_line',
    title: 'Page Views (over time)',
    type: 'line',
    expressions: ['browser_app_pv'],
    x: 0, y: 5, w: 12, h: 12,
  },
  {
    id: 'app_error_line',
    title: 'Page Errors (over time)',
    type: 'line',
    expressions: ['browser_app_error_sum'],
    x: 12, y: 5, w: 12, h: 12,
  },
];

/** Generic fallback widget set for layers without a dedicated template.
 *  Mirrors the General-Service KPI block since most virtual / database
 *  / MQ layers also expose service_cpm + service_resp_time + service_sla. */
const GENERIC_WIDGETS: DashboardWidget[] = [
  {
    id: 'cpm',
    title: 'Calls per minute',
    type: 'card',
    unit: 'calls / min',
    expressions: ['avg(service_cpm)'],
    x: 0, y: 0, w: 8, h: 5,
  },
  {
    id: 'sla',
    title: 'Success Rate',
    type: 'card',
    unit: '%',
    expressions: ['avg(service_sla)/100'],
    x: 8, y: 0, w: 8, h: 5,
  },
  {
    id: 'resp',
    title: 'Avg Response Time',
    type: 'card',
    unit: 'ms',
    expressions: ['avg(service_resp_time)'],
    x: 16, y: 0, w: 8, h: 5,
  },
  {
    id: 'cpm_line',
    title: 'Calls per minute (line)',
    type: 'line',
    unit: 'calls / min',
    expressions: ['service_cpm'],
    x: 0, y: 5, w: 24, h: 12,
  },
];

/**
 * Last-resort widget set when no remote template resolved (`tpl` is
 * `null` — layer not yet synced to OAP, admin-disabled, or the template
 * store is unreachable). These hardcoded sets are NOT the disk-bundled
 * templates: bundled config only ever reaches the UI via OAP (sync /
 * reset / preview). This is a minimal generic KPI seed so a bare grid
 * isn't completely empty; the connectivity banner separately signals an
 * unreachable store. When `tpl` carries widgets, those win.
 */
export function defaultWidgetsFor(
  tpl: LayerTemplate | null,
  layerKey: string,
): DashboardWidget[] {
  if (tpl && tpl.widgets && tpl.widgets.length > 0) return tpl.widgets;
  const k = layerKey.toUpperCase();
  if (k === 'MESH_CP' || k === 'MESH_DP') return SERVICE_WIDGETS;
  if (k === 'BROWSER') return BROWSER_WIDGETS;
  return GENERIC_WIDGETS;
}
