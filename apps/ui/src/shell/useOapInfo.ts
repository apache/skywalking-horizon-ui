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

import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import {
  parseOapTimezoneMinutes,
  type OapBackend,
  type OapCapabilities,
  type OapInfo,
} from '@skywalking-horizon-ui/api-client';
import { bffClient } from '@/api/client';

/**
 * Live OAP info — version, server timezone, current server timestamp,
 * health score. Polled every 30s. Drives the topbar status chip and
 * (later) time-range conversion between the browser's local TZ (display)
 * and the OAP server TZ (query construction).
 */
export function useOapInfo() {
  const q = useQuery({
    queryKey: ['oap-info'],
    queryFn: () => bffClient.menu.oapInfo(),
    staleTime: 20_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const info = computed<OapInfo | null>(() => q.data.value ?? null);
  const reachable = computed<boolean>(() => info.value?.reachable ?? false);
  const version = computed<string | undefined>(() => info.value?.version);
  const healthScore = computed<number | undefined>(() => info.value?.healthScore);
  /** OAP server timezone offset in minutes (UTC+8 → 480). Derived from the
   *  OAP `±HHmm` string. */
  const timezone = computed<number | undefined>(() => parseOapTimezoneMinutes(info.value?.timezone));

  /** Pretty UTC offset like `UTC+8`, `UTC-5:30`. Returns `''` if unknown. */
  const tzOffsetLabel = computed<string>(() => {
    const tz = timezone.value;
    if (tz === undefined || tz === null) return '';
    const sign = tz >= 0 ? '+' : '-';
    const abs = Math.abs(tz);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    return m === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(m).padStart(2, '0')}`;
  });

  /**
   * Convert a UTC ms-epoch to a string in the OAP server's local TZ in
   * the `yyyy-MM-dd HHmm` format the OAP query-protocol expects. Returns
   * an empty string when timezone is unknown.
   */
  function toServerTzString(epochMs: number, granularity: 'minute' | 'hour' | 'day' = 'minute'): string {
    const tz = timezone.value;
    if (tz === undefined || tz === null) return '';
    // Shift the UTC instant by the server's offset, then format. Using
    // toISOString gives us a UTC-formatted timestamp on the shifted
    // value, which by construction is the server's wall-clock time.
    const shifted = new Date(epochMs + tz * 60_000);
    const y = shifted.getUTCFullYear();
    const mo = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const d = String(shifted.getUTCDate()).padStart(2, '0');
    if (granularity === 'day') return `${y}-${mo}-${d}`;
    const h = String(shifted.getUTCHours()).padStart(2, '0');
    if (granularity === 'hour') return `${y}-${mo}-${d} ${h}`;
    const mi = String(shifted.getUTCMinutes()).padStart(2, '0');
    return `${y}-${mo}-${d} ${h}${mi}`;
  }

  /** GraphQL-schema feature flags reported by the BFF. Defaults to a
   *  conservative all-false shape until the first poll lands, so pages
   *  branching on a capability render the legacy path during initial
   *  load rather than flashing a "new" UI that then disappears. */
  const capabilities = computed<OapCapabilities>(() => ({
    queryAlarms: info.value?.capabilities?.queryAlarms ?? false,
  }));

  /** Storage backend probed via TTL response shape. `unknown` until the
   *  first poll lands, so cold-stage UI affordances stay hidden during
   *  bootstrap rather than flashing on then disappearing. */
  const backend = computed<OapBackend>(() => info.value?.backend ?? 'unknown');

  /** Resolved `query.overviewTopN` — the value the BFF substitutes for the
   *  `{{topn}}` placeholder in Overview KPI MQE. Falls back to 100 (the
   *  config default) until the info call lands. */
  const overviewTopN = computed<number>(() => info.value?.overviewTopN ?? 100);

  /** Health status pill colour: ok / warn / err / unknown. */
  const healthState = computed<'ok' | 'warn' | 'err' | 'unknown'>(() => {
    if (!reachable.value) return 'err';
    if (healthScore.value === undefined) return 'unknown';
    if (healthScore.value < 0) return 'err';
    if (healthScore.value > 0) return 'warn';
    return 'ok';
  });

  return {
    isLoading: q.isLoading,
    info,
    reachable,
    version,
    timezone,
    tzOffsetLabel,
    healthScore,
    healthState,
    capabilities,
    backend,
    overviewTopN,
    toServerTzString,
    refetch: q.refetch,
  };
}
