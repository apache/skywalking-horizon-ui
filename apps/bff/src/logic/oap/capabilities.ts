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
 * OAP GraphQL-schema capability probe. The query-protocol evolves
 * (fields added across OAP versions); routes that conditionally use a
 * newer field need to know whether the connected OAP exposes it.
 *
 * The probe runs a minimal `__type(name: "Query") { fields { name } }`
 * introspection call and reports per-feature booleans. Result is cached
 * per `queryUrl` for `CAPS_TTL_MS` — the GraphQL schema is fixed for an
 * OAP process lifetime, so the TTL only matters across OAP restarts
 * (and the staleness is harmless: legacy-mode fallback works against
 * new OAP, just doesn't use the new filters).
 *
 * A probe that fails returns false for everything — a legacy path or a
 * hidden input beats a failed page.
 */

import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import type { HorizonConfig } from '../../config/schema.js';
import { buildOapOpts, graphqlPost } from '../../client/graphql.js';

export interface OapCapabilities {
  /** `Query.queryAlarms(condition: AlarmQueryCondition!)` — introduced
   *  alongside the deprecation of `getAlarm`. Enables Entity / layer /
   *  ruleName filters; absence means the BFF must fall back to the
   *  scope+keyword+tags-only `getAlarm`. */
  queryAlarms: boolean;
  /** Whether stored-log CONTENT can be searched (`keywordsOfContent`).
   *  Decided by the storage, not the OAP version — ElasticSearch yes, the
   *  others no — so two OAPs on the same build can disagree. */
  logKeywords: boolean;
}

const INTROSPECTION_QUERY = /* GraphQL */ `
  query HorizonOapCapabilities {
    __type(name: "Query") { fields { name } }
  }
`;

interface IntrospectionRaw {
  __type?: { fields?: Array<{ name?: string | null } | null> | null } | null;
}

/** The storage-answered half. Asked only when introspection proved the field
 *  exists, so an OAP predating it never sees an invalid document. */
const LOG_KEYWORDS_QUERY = /* GraphQL */ `
  query HorizonLogKeywordSupport {
    supportQueryLogsByKeywords
  }
`;

interface LogKeywordsRaw {
  supportQueryLogsByKeywords?: boolean | null;
}

interface Entry {
  result: OapCapabilities;
  fetchedAt: number;
}
const cache = new Map<string, Entry>();
const CAPS_TTL_MS = 5 * 60_000;
/** When introspection itself fails, cache the conservative result for
 *  only this long so the page recovers quickly when OAP comes back —
 *  but long enough that a sustained outage doesn't trigger a probe on
 *  every request. */
const CAPS_FAILURE_TTL_MS = 60_000;

/** Reset the per-queryUrl cache. Test-only. */
export function _resetCapabilitiesCache(): void {
  cache.clear();
}

export async function getOapCapabilities(
  config: HorizonConfig,
  fetchImpl?: FetchLike,
  /** The caller's cancellation, on a read route. See `getServerOffsetMinutes`:
   *  the same reasoning applies, and the conservative result this caches on
   *  failure lasts a minute rather than expiring with the request. */
  signal?: AbortSignal,
): Promise<OapCapabilities> {
  const key = config.oap.queryUrl;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.fetchedAt < CAPS_TTL_MS) return hit.result;

  let raw: IntrospectionRaw;
  try {
    raw = await graphqlPost<IntrospectionRaw>(
      buildOapOpts(config, fetchImpl, signal),
      INTROSPECTION_QUERY,
    );
  } catch (err) {
    // Cancelled by the caller, so it measured nothing. Caching the conservative
    // answer here would hide alarm queries and content search from every LATER
    // request for a minute, on the strength of a probe that was never made.
    if (signal?.aborted) throw err;
    const conservative: OapCapabilities = { queryAlarms: false, logKeywords: false };
    cache.set(key, { result: conservative, fetchedAt: now - CAPS_TTL_MS + CAPS_FAILURE_TTL_MS });
    return conservative;
  }

  const fieldSet = new Set<string>();
  for (const f of raw.__type?.fields ?? []) {
    if (f?.name) fieldSet.add(f.name);
  }
  // A backend that cannot match content answers false, and so does a failed
  // read — the input it gates is offered only on a definite yes.
  let logKeywords = false;
  let probeFailed = false;
  if (fieldSet.has('supportQueryLogsByKeywords')) {
    try {
      const env = await graphqlPost<LogKeywordsRaw>(
        buildOapOpts(config, fetchImpl, signal),
        LOG_KEYWORDS_QUERY,
      );
      logKeywords = env.supportQueryLogsByKeywords === true;
    } catch (err) {
      if (signal?.aborted) throw err;
      logKeywords = false;
      probeFailed = true;
    }
  }
  const result: OapCapabilities = {
    queryAlarms: fieldSet.has('queryAlarms'),
    logKeywords,
  };
  // A false that came from a TIMEOUT expires on the short TTL, not the long
  // one: caching it for the full window would hide content search on a
  // capable backend for five minutes over one slow reply. A false the storage
  // actually answered is durable — it only changes when OAP restarts.
  cache.set(key, {
    result,
    fetchedAt: probeFailed ? now - CAPS_TTL_MS + CAPS_FAILURE_TTL_MS : now,
  });
  return result;
}
