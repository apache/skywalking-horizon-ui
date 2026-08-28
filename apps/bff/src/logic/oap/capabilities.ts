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
// One Horizon reads one OAP deployment, and every node in it answers alike, so
// there is no second answer for a key to separate — see apps/bff/CLAUDE.md.
// This was a Map keyed on `oap.queryUrl`, which is a single config field: it
// held exactly one entry for the life of the process and separated nothing.
let cache: Entry | null = null;
let flight: Promise<OapCapabilities> | null = null;
const CAPS_TTL_MS = 5 * 60_000;
/** When introspection itself fails, cache the conservative result for
 *  only this long so the page recovers quickly when OAP comes back —
 *  but long enough that a sustained outage doesn't trigger a probe on
 *  every request. */
const CAPS_FAILURE_TTL_MS = 60_000;

/** Reset the cache. Test-only. */
export function _resetCapabilitiesCache(): void {
  cache = null;
  flight = null;
}

export async function getOapCapabilities(
  config: HorizonConfig,
  fetchImpl?: FetchLike,
  /** The caller's cancellation, on a read route. It unblocks THIS caller only —
   *  see `getServerOffsetMinutes`, which shares its probe the same way. */
  signal?: AbortSignal,
): Promise<OapCapabilities> {
  if (cache && Date.now() - cache.fetchedAt < CAPS_TTL_MS) return cache.result;

  // ONE introspection per expiry, shared by every concurrent caller. Without
  // this a round's dozen reads each probed, and a slow failure landing after a
  // fast success overwrote real capabilities with the conservative all-false —
  // hiding alarm queries and content search for a minute on a capable backend.
  flight ??= probeCapabilities(config, fetchImpl).finally(() => {
    flight = null;
  });
  if (!signal) return flight;
  return Promise.race([
    flight,
    new Promise<OapCapabilities>((_, reject) => {
      const abort = (): void => {
        const e = new Error('This operation was aborted');
        e.name = 'AbortError';
        reject(e);
      };
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
    }),
  ]);
}

async function probeCapabilities(
  config: HorizonConfig,
  fetchImpl: FetchLike | undefined,
): Promise<OapCapabilities> {
  const now = Date.now();
  let raw: IntrospectionRaw;
  try {
    raw = await graphqlPost<IntrospectionRaw>(
      buildOapOpts(config, fetchImpl),
      INTROSPECTION_QUERY,
    );
  } catch {
    const conservative: OapCapabilities = { queryAlarms: false, logKeywords: false };
    cache = { result: conservative, fetchedAt: now - CAPS_TTL_MS + CAPS_FAILURE_TTL_MS };
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
        buildOapOpts(config, fetchImpl),
        LOG_KEYWORDS_QUERY,
      );
      logKeywords = env.supportQueryLogsByKeywords === true;
    } catch {
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
  cache = {
    result,
    fetchedAt: probeFailed ? now - CAPS_TTL_MS + CAPS_FAILURE_TTL_MS : now,
  };
  return result;
}
