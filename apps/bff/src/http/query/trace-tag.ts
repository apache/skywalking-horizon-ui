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
 * Trace + log tag autocomplete routes:
 *   GET /api/trace-tags/keys?windowMinutes=30
 *   GET /api/trace-tags/values?key=<k>&windowMinutes=30
 *   GET /api/log-tags/keys?windowMinutes=30&type=native|otlp
 *   GET /api/log-tags/values?key=<k>&windowMinutes=30&type=native|otlp
 *
 * All four wrap OAP's `queryXxxTagAutocompleteKeys` /
 * `queryXxxTagAutocompleteValues` GraphQL endpoints. Same pattern as
 * booster-ui's `ConditionTags.vue` — operator types in the Tag input,
 * the suggestion list swaps between keys (before `=`) and per-key
 * values (after `=`). Log keys/values share the same response shape
 * as traces, so the routes co-locate here and the UI side reuses the
 * same client helper pair. The log lists are read in `logic/oap/log-tags.ts`,
 * which picks the request shape for the connected OAP.
 */

import type { FetchLike, LogType } from '@skywalking-horizon-ui/api-client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthDeps } from '../../user/middleware.js';
import { requireAuth } from '../../user/middleware.js';
import { clientGone } from '../client-gone.js';
import { buildOapOpts, graphqlPost, type GraphqlOptions } from '../../client/graphql.js';
import { readLogTagKeys, readLogTagValues } from '../../logic/oap/log-tags.js';
import { fmtMinute, getServerOffsetMinutes } from '../../util/window.js';

export interface TraceTagRouteDeps extends AuthDeps {
  fetch?: FetchLike;
}

const DEFAULT_WINDOW_MIN = 30;
const MAX_WINDOW_MIN = 60 * 24 * 7;
function rollingWindow(
  minutes: number,
  offsetMinutes: number,
): { start: string; end: string; step: 'MINUTE' } {
  const m = Math.max(1, Math.min(MAX_WINDOW_MIN, Math.round(minutes)));
  const endMs = Date.now();
  const startMs = endMs - m * 60_000;
  return {
    start: fmtMinute(startMs, offsetMinutes),
    end: fmtMinute(endMs, offsetMinutes),
    step: 'MINUTE',
  };
}

const TRACE_KEYS_QUERY = /* GraphQL */ `
  query TraceTagKeys($duration: Duration!) {
    keys: queryTraceTagAutocompleteKeys(duration: $duration)
  }
`;
const TRACE_VALUES_QUERY = /* GraphQL */ `
  query TraceTagValues($tagKey: String!, $duration: Duration!) {
    values: queryTraceTagAutocompleteValues(tagKey: $tagKey, duration: $duration)
  }
`;
type Duration = ReturnType<typeof rollingWindow>;
type TagQuery = { key?: string; windowMinutes?: string; type?: string };
type KeysReader = (opts: GraphqlOptions, duration: Duration, q: TagQuery) => Promise<string[]>;
type ValuesReader = (opts: GraphqlOptions, duration: Duration, key: string, q: TagQuery) => Promise<string[]>;

export function registerTraceTagRoutes(app: FastifyInstance, deps: TraceTagRouteDeps): void {
  const auth = requireAuth(deps);

  function tagsKeysHandler(read: KeysReader) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const q = req.query as TagQuery;
      const m = q.windowMinutes ? Number(q.windowMinutes) : DEFAULT_WINDOW_MIN;
      const signal = clientGone(reply);
      const opts = buildOapOpts(deps.config.current, deps.fetch, signal);
      try {
        const offset = await getServerOffsetMinutes(deps.config, deps.fetch, signal);
        const duration = rollingWindow(Number.isFinite(m) ? m : DEFAULT_WINDOW_MIN, offset);
        const keys = await read(opts, duration, q);
        return reply.send({ keys, generatedAt: Date.now() });
      } catch (err) {
        return reply.code(200).send({
          keys: [],
          generatedAt: Date.now(),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
  }
  function tagsValuesHandler(read: ValuesReader) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const q = req.query as TagQuery;
      const key = (q.key ?? '').trim();
      if (!key) return reply.code(400).send({ error: 'missing_key' });
      const m = q.windowMinutes ? Number(q.windowMinutes) : DEFAULT_WINDOW_MIN;
      const signal = clientGone(reply);
      const opts = buildOapOpts(deps.config.current, deps.fetch, signal);
      try {
        const offset = await getServerOffsetMinutes(deps.config, deps.fetch, signal);
        const duration = rollingWindow(Number.isFinite(m) ? m : DEFAULT_WINDOW_MIN, offset);
        const values = await read(opts, duration, key, q);
        return reply.send({ key, values, generatedAt: Date.now() });
      } catch (err) {
        return reply.code(200).send({
          key,
          values: [],
          generatedAt: Date.now(),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
  }

  const traceKeys: KeysReader = async (opts, duration) =>
    (await graphqlPost<{ keys: string[] | null }>(opts, TRACE_KEYS_QUERY, { duration })).keys ?? [];
  const traceValues: ValuesReader = async (opts, duration, tagKey) =>
    (await graphqlPost<{ values: string[] | null }>(opts, TRACE_VALUES_QUERY, { tagKey, duration })).values ?? [];

  app.get('/api/trace-tags/keys', { preHandler: auth }, tagsKeysHandler(traceKeys));
  app.get('/api/trace-tags/values', { preHandler: auth }, tagsValuesHandler(traceValues));
  const logRead = (opts: GraphqlOptions, duration: Duration, q: TagQuery) => ({
    config: deps.config.current,
    fetch: deps.fetch,
    opts,
    duration,
    // Absent, or anything but `otlp`, is native — as in the layer template.
    logType: (q.type === 'otlp' ? 'otlp' : 'native') as LogType,
  });

  app.get('/api/log-tags/keys', { preHandler: auth }, tagsKeysHandler((opts, duration, q) => readLogTagKeys(logRead(opts, duration, q))));
  app.get(
    '/api/log-tags/values',
    { preHandler: auth },
    tagsValuesHandler((opts, duration, key, q) => readLogTagValues(logRead(opts, duration, q), key)),
  );
}
