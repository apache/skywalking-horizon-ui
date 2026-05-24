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
 * Detect which storage OAP is using, by inspecting `getRecordsTTL` /
 * `getMetricsTTL`. OAP doesn't expose the storage choice as a first-class
 * GraphQL field, but the TTL response shape is reliably different:
 *
 *   - Non-BanyanDB (Default core impl): every record/metric field returns
 *     the same `coreXxxTTL`, and every `cold*` field is `-1`.
 *   - BanyanDB: per-class TTLs (trace / log / minute / hour / day) come
 *     from each model's own config and are usually non-uniform; cold*
 *     fields hold real values when the cold lifecycle stage is on; and
 *     `MetricsTTL.metadata` is independently configured.
 *
 * Heuristic used:
 *   - Any `cold*` field >= 0          ⇒ banyandb (only it ever sets cold)
 *   - Any per-class TTL differs       ⇒ banyandb (default impl is uniform)
 *   - Metadata != minute              ⇒ banyandb (default impl unifies)
 *   - Otherwise                       ⇒ other
 *
 * The corner case — a BanyanDB instance with hot-only AND uniform per-class
 * TTLs — looks identical to the default impl on the wire and reports as
 * `other`. That's acceptable: the only behavior we gate on the result is
 * the visibility of the cold-stage UI affordance, and in that corner case
 * the BanyanDB instance has no cold stage to query anyway.
 *
 * Cached per-queryUrl for 5 min; failures cached for 60s so a transient
 * OAP outage recovers quickly without re-probing on every poll.
 */

import type { FetchLike, OapBackend, RecordsTTL, MetricsTTL } from '@skywalking-horizon-ui/api-client';
import type { HorizonConfig } from '../../config/schema.js';
import { buildOapOpts, graphqlPost } from '../../client/graphql.js';

const TTL_PROBE_QUERY = /* GraphQL */ `
  query HorizonOapBackendProbe {
    records: getRecordsTTL {
      normal trace zipkinTrace log browserErrorLog
      coldNormal coldTrace coldZipkinTrace coldLog coldBrowserErrorLog
    }
    metrics: getMetricsTTL {
      metadata minute hour day
      coldMinute coldHour coldDay
    }
  }
`;

interface TtlProbeRaw {
  records?: RecordsTTL | null;
  metrics?: MetricsTTL | null;
}

interface Entry {
  backend: OapBackend;
  fetchedAt: number;
}
const cache = new Map<string, Entry>();
const TTL_OK_MS = 5 * 60_000;
const TTL_FAIL_MS = 60_000;

/** Reset the per-queryUrl cache. Test-only. */
export function _resetBackendCache(): void {
  cache.clear();
}

export function classifyBackend(raw: TtlProbeRaw): OapBackend {
  const r = raw.records;
  const m = raw.metrics;
  if (!r || !m) return 'unknown';
  const coldVals = [
    r.coldNormal, r.coldTrace, r.coldZipkinTrace, r.coldLog, r.coldBrowserErrorLog,
    m.coldMinute, m.coldHour, m.coldDay,
  ];
  if (coldVals.some((v) => typeof v === 'number' && v >= 0)) return 'banyandb';
  const recVals = [r.normal, r.trace, r.zipkinTrace, r.log, r.browserErrorLog];
  if (new Set(recVals).size > 1) return 'banyandb';
  const metVals = [m.minute, m.hour, m.day];
  if (new Set(metVals).size > 1) return 'banyandb';
  if (typeof m.metadata === 'number' && m.metadata !== m.minute) return 'banyandb';
  return 'other';
}

export async function probeTtl(
  config: HorizonConfig,
  fetchImpl?: FetchLike,
): Promise<TtlProbeRaw> {
  return graphqlPost<TtlProbeRaw>(buildOapOpts(config, fetchImpl), TTL_PROBE_QUERY);
}

export async function getOapBackend(
  config: HorizonConfig,
  fetchImpl?: FetchLike,
): Promise<OapBackend> {
  const key = config.oap.queryUrl;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.fetchedAt < TTL_OK_MS) return hit.backend;
  try {
    const raw = await probeTtl(config, fetchImpl);
    const backend = classifyBackend(raw);
    cache.set(key, { backend, fetchedAt: now });
    return backend;
  } catch {
    // Conservative: report unknown rather than guessing. Short cache
    // so the next poll re-probes and recovers when OAP comes back.
    cache.set(key, { backend: 'unknown', fetchedAt: now - TTL_OK_MS + TTL_FAIL_MS });
    return 'unknown';
  }
}
