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
 * Tiny per-process cache for the trace-protocol probe.
 *
 * OAP 9.6+ exposes `queryTraces` (v2) which returns the list AND
 * the spans inline in a single roundtrip. Older OAP only exposes
 * `queryBasicTraces` (v3) which returns trace summaries; the SPA
 * fetches each detail via `queryTrace(traceId)`.
 *
 * The v2 query type carries a sibling boolean `hasQueryTracesV2Support`
 * we can probe once and cache. Cached for 5 minutes so an OAP rollover
 * or a redeploy is picked up without an explicit reload.
 *
 * The decision is per OAP target (keyed by `queryUrl`) — when the
 * operator points horizon at a different cluster, the probe runs
 * again.
 */

import { graphqlPost } from '../client/graphql.js';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';

export type TraceProtocol = 'v2' | 'v3';

interface CacheEntry {
  protocol: TraceProtocol;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, CacheEntry>();

interface ProbeOpts {
  queryUrl: string;
  timeoutMs: number;
  fetch?: FetchLike;
  /** Optional basic-auth — same shape as GraphqlOptions so call
   *  sites can pass the same `opts` object through. */
  auth?: { username: string; password: string };
}

const PROBE_QUERY = /* GraphQL */ `
  query ProbeQueryTracesV2 {
    hasQueryTracesV2Support
  }
`;

/**
 * Returns the protocol the BFF should use for trace queries against
 * this OAP target. Probes once and caches; falls back to v3 on
 * probe failure since v3's `queryBasicTraces` is supported by every
 * shipped OAP version.
 */
export async function detectTraceProtocol(opts: ProbeOpts): Promise<TraceProtocol> {
  const now = Date.now();
  const cached = cache.get(opts.queryUrl);
  if (cached && cached.expiresAt > now) return cached.protocol;
  let protocol: TraceProtocol = 'v3';
  try {
    const data = await graphqlPost<{ hasQueryTracesV2Support?: boolean }>(opts, PROBE_QUERY);
    if (data.hasQueryTracesV2Support === true) protocol = 'v2';
  } catch {
    // Probe failed — older OAP doesn't have the field, GraphQL errors
    // out. Cache v3 so we don't re-probe on every list call.
  }
  cache.set(opts.queryUrl, { protocol, expiresAt: now + CACHE_TTL_MS });
  return protocol;
}

/** Force-invalidate the cache. Wired into the future "Refresh" admin
 *  affordance; not used by the runtime today. */
export function invalidateTraceProtocolCache(): void {
  cache.clear();
}
