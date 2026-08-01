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

// The Alarms page-setup config and its validate helper. A leaf module
// (imports nothing internal) so the alarms api scope can read the effective
// config without a cycle through client.ts. It is the
// `horizon.alert.page-setup` singleton template — edited on the Alert page
// admin, and read back as one of the effective org settings.

/** Allowed values for `AlarmsConfig.defaultWindowMs`, in ms. Matches the alarms
 *  page's preset list so the admin's choice always corresponds to a real tab. */
export const ALARMS_WINDOW_OPTIONS = [
  20 * 60_000,
  2 * 60 * 60_000,
  4 * 60 * 60_000,
] as const;
export type AlarmsWindowMs = (typeof ALARMS_WINDOW_OPTIONS)[number];

export const OVERVIEW_ALARMS_LIMIT_MIN = 10;
export const OVERVIEW_ALARMS_LIMIT_MAX = 500;
export const OVERVIEW_ALARMS_LIMIT_DEFAULT = 200;

export interface AlarmsConfig {
  /** OAP layer keys (canonical `GENERAL`, `MESH`, …) that get a dedicated tile
   *  on the alarms page header. Render order matches the array order. */
  pinnedLayers: string[];
  /** Default time window in ms for the topbar alarm badge AND the alarms page's
   *  initial picker selection. */
  defaultWindowMs: number;
  /** Fetch cap for the overview "Active alarms" widget. Default 200, range
   *  [10, 500]. Bigger = more incident variety; smaller = cheaper poll. */
  overviewAlarmsLimit: number;
}

/** Shipped default — kept in sync with the bundled alert page-setup template
 *  (`apps/bff/src/bundled_templates/alert/page-setup.json`). */
export const DEFAULT_ALARMS_CONFIG: AlarmsConfig = {
  pinnedLayers: ['GENERAL', 'MESH'],
  defaultWindowMs: ALARMS_WINDOW_OPTIONS[0],
  overviewAlarmsLimit: OVERVIEW_ALARMS_LIMIT_DEFAULT,
};

/** Validate the alert page-setup content the BFF resolved for its template
 *  mode. Any missing / out-of-range field falls back to the shipped default,
 *  so a partial template — or none at all, when live mode has no readable OAP
 *  row — still yields a usable config. */
export function normalizeAlarmsConfig(raw: unknown): AlarmsConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_ALARMS_CONFIG };
  }
  const content = raw as Partial<AlarmsConfig>;
  const pinnedLayers = Array.isArray(content.pinnedLayers)
    ? content.pinnedLayers.filter((l): l is string => typeof l === 'string')
    : DEFAULT_ALARMS_CONFIG.pinnedLayers;
  const defaultWindowMs = (ALARMS_WINDOW_OPTIONS as readonly number[]).includes(
    content.defaultWindowMs as number,
  )
    ? (content.defaultWindowMs as number)
    : DEFAULT_ALARMS_CONFIG.defaultWindowMs;
  const lim = content.overviewAlarmsLimit;
  const overviewAlarmsLimit =
    typeof lim === 'number' &&
    Number.isInteger(lim) &&
    lim >= OVERVIEW_ALARMS_LIMIT_MIN &&
    lim <= OVERVIEW_ALARMS_LIMIT_MAX
      ? lim
      : DEFAULT_ALARMS_CONFIG.overviewAlarmsLimit;
  return { pinnedLayers, defaultWindowMs, overviewAlarmsLimit };
}
