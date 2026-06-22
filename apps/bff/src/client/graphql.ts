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

import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import type { HorizonConfig } from '../config/schema.js';
import { mapPool } from '../util/mapPool.js';

export interface GraphqlOptions {
  queryUrl: string;
  timeoutMs: number;
  fetch?: FetchLike;
  /** Optional basic-auth credentials for outbound OAP calls. When
   *  set, the client adds an `Authorization: Basic <b64>` header. */
  auth?: { username: string; password: string };
}

/**
 * Build a {@link GraphqlOptions}-shaped object from the live config
 * plus an injected fetch. Use this in every route to keep `auth`,
 * `timeoutMs`, etc. flowing consistently from `horizon.yaml`.
 */
export function buildOapOpts(
  cfg: HorizonConfig,
  fetch?: FetchLike,
): GraphqlOptions {
  return {
    queryUrl: cfg.oap.queryUrl,
    timeoutMs: cfg.oap.timeoutMs,
    auth: cfg.oap.auth,
    fetch,
  };
}

/** Build a basic-auth header value from a username/password pair. */
export function basicAuthHeader(username: string, password: string): string {
  // btoa handles ASCII; encode utf-8 first for safety.
  const raw = `${username}:${password}`;
  const b64 = typeof Buffer !== 'undefined'
    ? Buffer.from(raw, 'utf8').toString('base64')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    : (globalThis as any).btoa(unescape(encodeURIComponent(raw)));
  return `Basic ${b64}`;
}

export class GraphqlError extends Error {
  readonly statusCode: number;
  readonly errors?: ReadonlyArray<{ message: string; path?: ReadonlyArray<string | number> }>;
  constructor(
    statusCode: number,
    message: string,
    errors?: ReadonlyArray<{ message: string; path?: ReadonlyArray<string | number> }>,
  ) {
    super(message);
    this.name = 'GraphqlError';
    this.statusCode = statusCode;
    this.errors = errors;
  }
}

/**
 * POST a GraphQL query to OAP's `/graphql` endpoint and return the unwrapped
 * `data` field. Throws on transport errors and on GraphQL-level error arrays.
 */
export async function graphqlPost<T>(
  opts: GraphqlOptions,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const url = opts.queryUrl.replace(/\/$/, '') + '/graphql';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.auth) {
    headers.authorization = basicAuthHeader(opts.auth.username, opts.auth.password);
  }
  let res: Response;
  try {
    res = await f(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables: variables ?? {} }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new GraphqlError(res.status, `graphql http ${res.status}: ${text.slice(0, 200)}`);
  }
  // A 200 that isn't JSON means the endpoint isn't actually OAP's
  // GraphQL — most commonly it's serving an HTML page (a reverse proxy
  // / SPA fallback, a login redirect, or the OAP UI itself). Parsing
  // that as JSON yields the opaque `Unexpected token '<'`; surface a
  // clear diagnostic with the status, content-type, and a snippet.
  const raw = await res.text();
  const ctype = res.headers.get('content-type') ?? '';
  const looksJson = ctype.includes('json') || /^\s*[{[]/.test(raw);
  if (!looksJson) {
    const snippet = raw.replace(/\s+/g, ' ').trim().slice(0, 120);
    throw new GraphqlError(
      res.status,
      `OAP query endpoint returned non-JSON (HTTP ${res.status}, content-type "${ctype || 'unknown'}") — ` +
        `expected GraphQL JSON. Check oap.queryUrl points at OAP's GraphQL port, not a UI/proxy. Body: ${snippet}`,
    );
  }
  let body: { data?: T; errors?: ReadonlyArray<{ message: string; path?: ReadonlyArray<string | number> }> };
  try {
    body = JSON.parse(raw);
  } catch (e) {
    throw new GraphqlError(res.status, `OAP returned malformed JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (body.errors && body.errors.length) {
    throw new GraphqlError(200, body.errors.map((e) => e.message).join('; '), body.errors);
  }
  if (body.data === undefined || body.data === null) {
    throw new GraphqlError(200, 'graphql response had no data field');
  }
  return body.data;
}

/**
 * Fan an aliased-fragment metric query out to OAP in bounded-concurrency
 * chunks, merging every chunk's aliases into one object. `chunkSize` caps
 * fragments per request (OAP enforces a per-request complexity ceiling);
 * `concurrency` caps simultaneous chunk requests so a wide topology doesn't
 * stampede OAP. Each chunk soft-fails independently — a failed chunk simply
 * contributes no aliases, so one transient error degrades that slice to
 * null metrics instead of aborting the whole fan-out (the topology routes
 * keep the graph and emit nulls). Returns `{}` when there are no fragments.
 * Pass `stats` to accumulate failed/total chunk counts for surfacing.
 */
export async function fetchAliasedChunks<T>(
  opts: GraphqlOptions,
  fragments: readonly string[],
  chunkSize: number,
  queryName: string,
  concurrency = 4,
  stats?: { failed: number; total: number },
): Promise<Record<string, T>> {
  if (fragments.length === 0) return {};
  const chunks: string[][] = [];
  for (let i = 0; i < fragments.length; i += chunkSize) {
    chunks.push(fragments.slice(i, i + chunkSize));
  }
  const envs = await mapPool(chunks, concurrency, async (slice) => {
    const query = `query ${queryName} {\n  ${slice.join('\n  ')}\n}`;
    try {
      return await graphqlPost<Record<string, T>>(opts, query);
    } catch {
      return null;
    }
  });
  const merged: Record<string, T> = {};
  for (const env of envs) {
    if (env) Object.assign(merged, env);
  }
  if (stats) {
    stats.total += chunks.length;
    stats.failed += envs.filter((e) => e === null).length;
  }
  return merged;
}
