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
 * Live OAP status carried by `GET /api/oap/info`. The UI surfaces this in
 * the topbar (version + UTC offset + reachable dot) and uses the
 * `timezone` + `currentTimestamp` to align time-range queries with the
 * OAP server clock — display stays in the browser's local TZ; the
 * outgoing query string is converted into the OAP's TZ for the wire.
 */

export interface OapInfo {
  reachable: boolean;
  queryUrl: string;
  /** OAP build version. */
  version?: string;
  /** Raw OAP timezone string in `±HHmm` form (e.g. `+0000`, `+0800`, `-0530`).
   *  Use `parseOapTimezoneMinutes` to convert to signed minutes-from-UTC. */
  timezone?: string;
  /** OAP-clock "now" in ms epoch when the BFF made the call. */
  currentTimestamp?: number;
  /** Health score: 0 = OK, >0 = degraded, <0 = not started. */
  healthScore?: number;
  healthDetails?: string;
  /** Per-feature schema capabilities probed via GraphQL introspection.
   *  Absent when `reachable === false`. Each field is `true` iff the
   *  corresponding `Query.<name>` field exists on the connected OAP.
   *  Routes / pages branch on this to choose between legacy + new
   *  query shapes (e.g. `getAlarm` vs `queryAlarms`). */
  capabilities?: OapCapabilities;
  /** Storage backend probed via the TTL response shape (`getRecordsTTL`
   *  / `getMetricsTTL`). Cached BFF-side for ~5 min — the storage choice
   *  doesn't change at OAP runtime. Absent when `reachable === false`. */
  backend?: OapBackend;
  error?: string;
  /** OAP's Zipkin v2 REST base URL (`oap.zipkinUrl`). Only the Zipkin /
   *  OTLP trace menu reads from it — an unreachable Zipkin endpoint does
   *  NOT degrade any other page, so the cluster-status pane scopes it
   *  to the trace component explicitly. */
  zipkinUrl?: string;
  /** Whether `GET {zipkinUrl}/api/v2/services` answered 2xx. Probed in
   *  parallel with the GraphQL info call and independent of `reachable`
   *  (query port can be up while Zipkin is off, and vice versa). */
  zipkinReachable?: boolean;
  zipkinError?: string;
  /** Horizon's resolved `query.overviewTopN` (`HORIZON_QUERY_OVERVIEW_TOPN`,
   *  default 100) — the value the BFF substitutes for the `{{topn}}`
   *  placeholder in Overview KPI MQE. Surfaced so the Overview-templates
   *  editor can show the live value in its `{{topn}}` hint. Always present
   *  (a static Horizon config), independent of OAP reachability. */
  overviewTopN?: number;
}

export interface OapCapabilities {
  /** `Query.queryAlarms(condition: AlarmQueryCondition!)` — introduced
   *  alongside the deprecation of `getAlarm`. Enables Entity / layer /
   *  ruleName filters; absence means clients fall back to the
   *  scope+keyword+tags-only `getAlarm`. */
  queryAlarms: boolean;
}

/** Storage backend the connected OAP runs on, as far as the BFF can
 *  tell from the TTL response shape. `banyandb` ⇒ the UI exposes the
 *  cold-stage query toggle; `other` ⇒ the toggle is hidden because OAP
 *  ignores `Duration.coldStage` for non-BanyanDB storage. `unknown` is
 *  the conservative default until the first probe lands. */
export type OapBackend = 'banyandb' | 'other' | 'unknown';

/**
 * Convert OAP's `±HHmm` timezone string to signed minutes-from-UTC.
 * Returns `undefined` for malformed input.
 */
export function parseOapTimezoneMinutes(tz: string | undefined): number | undefined {
  if (!tz) return undefined;
  const m = /^([+-])(\d{2})(\d{2})$/.exec(tz);
  if (!m) return undefined;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}
