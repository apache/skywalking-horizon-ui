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
 * Which TraceQL datasources this OAP actually answers on.
 *
 * OAP registers a datasource's handler only when its flag is on, so asking a
 * context path for its build info is a per-datasource availability check: a
 * datasource nobody enabled 404s on its own path. It proves registration and
 * reachability and nothing more — the version string is hardcoded upstream, so
 * it says nothing about storage or about whether search will work.
 *
 * A source is OFFERED when its URL is configured; whether it is REACHABLE is a
 * separate fact the page surfaces itself. An unreachable source never hides its
 * menu row: a row that vanishes takes the explanation with it, and the operator
 * is left with a layer that silently lost a tab.
 */

import type { FetchLike, TraceQLDatasource, TraceQLSourceStatus } from '@skywalking-horizon-ui/api-client';
import { buildTraceQLOpts, traceqlBuildInfo, traceqlUrlFor, TraceQLHttpError } from '../../client/traceql.js';
import type { HorizonConfig } from '../../config/schema.js';

const TTL_MS = 5 * 60_000;
/** A FAILED probe expires far sooner than a good one. Holding "down" for five
 *  minutes outlives the datasource's own recovery, and the page that polls for
 *  it — and the Cluster page's Refresh — would read the cached failure back
 *  without ever contacting OAP again. */
const FAILED_TTL_MS = 5_000;

interface CacheEntry {
  status: TraceQLSourceStatus;
  expiresAt: number;
}

/** Keyed by datasource AND url: two datasources may be configured with the
 *  same URL, and a probe for one must not answer as the other. */
const cache = new Map<string, CacheEntry>();

export const TRACEQL_DATASOURCES: readonly TraceQLDatasource[] = ['native', 'zipkin', 'otlp'];

function failureText(e: unknown): string {
  if (e instanceof TraceQLHttpError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

async function probeOne(
  cfg: HorizonConfig,
  ds: TraceQLDatasource,
  fetch?: FetchLike,
  signal?: AbortSignal,
): Promise<TraceQLSourceStatus> {
  const opts = buildTraceQLOpts(cfg, ds, fetch, signal);
  const url = traceqlUrlFor(cfg, ds);
  if (!opts) return { ds, url: '', configured: false, reachable: false };

  const key = `${ds}\u0000${url}`;
  const cached = cache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.status;

  let status: TraceQLSourceStatus;
  try {
    const info = await traceqlBuildInfo(opts);
    status = { ds, url, configured: true, reachable: true, version: info.version };
  } catch (e) {
    // An abandoned read measured nothing. Report it, but do not write a
    // conclusion nobody reached into a cache every other request reads.
    if (signal?.aborted) return { ds, url, configured: true, reachable: false, error: failureText(e) };
    // A 404 is the service answering that this datasource is not enabled —
    // the operator has nothing to fix at the socket, so it must not read as
    // an outage next to datasources that really are down.
    const notServed = e instanceof TraceQLHttpError && e.status === 404;
    status = {
      ds, url, configured: true, reachable: false,
      ...(notServed ? { served: false } : {}),
      error: failureText(e),
    };
  }
  cache.set(key, { status, expiresAt: now + (status.reachable ? TTL_MS : FAILED_TTL_MS) });
  return status;
}

/** Every datasource's status, configured or not — the unconfigured ones are
 *  reported rather than omitted, so "nobody set this up" reads differently
 *  from "it is set up and down". */
export async function traceqlSources(
  cfg: HorizonConfig,
  fetch?: FetchLike,
  signal?: AbortSignal,
): Promise<TraceQLSourceStatus[]> {
  return Promise.all(TRACEQL_DATASOURCES.map((ds) => probeOne(cfg, ds, fetch, signal)));
}

/** Force a re-probe. Used by the tests; a config reload also invalidates by
 *  virtue of the URL being the cache key. */
export function resetTraceQLAvailability(): void {
  cache.clear();
}
