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
 * Add a new probe by inserting it into {@link CAPABILITY_FIELDS}: each
 * entry says "feature `X` requires field `Y` on `Query`". The probe
 * returns false (conservative) when introspection itself fails — we'd
 * rather use the legacy path than fail the page.
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
}

const INTROSPECTION_QUERY = /* GraphQL */ `
  query HorizonOapCapabilities {
    __type(name: "Query") { fields { name } }
  }
`;

interface IntrospectionRaw {
  __type?: { fields?: Array<{ name?: string | null } | null> | null } | null;
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
): Promise<OapCapabilities> {
  const key = config.oap.queryUrl;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.fetchedAt < CAPS_TTL_MS) return hit.result;

  let raw: IntrospectionRaw;
  try {
    raw = await graphqlPost<IntrospectionRaw>(buildOapOpts(config, fetchImpl), INTROSPECTION_QUERY);
  } catch {
    const conservative: OapCapabilities = { queryAlarms: false };
    cache.set(key, { result: conservative, fetchedAt: now - CAPS_TTL_MS + CAPS_FAILURE_TTL_MS });
    return conservative;
  }

  const fieldSet = new Set<string>();
  for (const f of raw.__type?.fields ?? []) {
    if (f?.name) fieldSet.add(f.name);
  }
  const result: OapCapabilities = {
    queryAlarms: fieldSet.has('queryAlarms'),
  };
  cache.set(key, { result, fetchedAt: now });
  return result;
}
