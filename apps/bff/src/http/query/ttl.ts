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
 * `GET /api/oap/ttl` — one round-trip combining `getRecordsTTL` and
 * `getMetricsTTL` on the query port. Read-only data-retention view.
 * Never rejects on an unreachable OAP: returns `{ reachable: false }`
 * so the page degrades instead of 502-ing.
 *
 * On top of the raw OAP fields, we derive:
 *   - `backend` — `banyandb` / `other` / `unknown` from the TTL shape
 *     (see {@link classifyBackend}); cached upstream so this poll
 *     reuses it.
 *   - `stages.hot` + `stages.cold` — a per-stage view that lets the UI
 *     render a single component twice instead of branching on the raw
 *     field names. `stages.cold` is `null` when no `cold*` field is
 *     configured for any class.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  FetchLike,
  MetricsTTL,
  OapTtlResponse,
  RecordsTTL,
  TtlStageBreakdown,
} from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import { buildOapOpts, graphqlPost } from '../../client/graphql.js';
import { classifyBackend } from '../../logic/oap/backend.js';

const TTL_QUERY = /* GraphQL */ `
  query HorizonOapTtl {
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

interface TtlRaw {
  records?: RecordsTTL | null;
  metrics?: MetricsTTL | null;
}

/** Compose `stages.hot` + `stages.cold` from the raw OAP fields. The
 *  cold pane is `null` when every `cold*` field is `-1` (BanyanDB
 *  without a cold lifecycle stage, or any non-BanyanDB backend). */
export function deriveStages(raw: TtlRaw): { hot: TtlStageBreakdown; cold: TtlStageBreakdown | null } | null {
  const r = raw.records;
  const m = raw.metrics;
  if (!r || !m) return null;
  const hot: TtlStageBreakdown = {
    records: {
      normal: r.normal,
      trace: r.trace,
      zipkinTrace: r.zipkinTrace,
      log: r.log,
      browserErrorLog: r.browserErrorLog,
    },
    metrics: {
      metadata: m.metadata,
      minute: m.minute,
      hour: m.hour,
      day: m.day,
    },
  };
  const coldVals = [
    r.coldNormal, r.coldTrace, r.coldZipkinTrace, r.coldLog, r.coldBrowserErrorLog,
    m.coldMinute, m.coldHour, m.coldDay,
  ];
  const hasCold = coldVals.some((v) => typeof v === 'number' && v >= 0);
  if (!hasCold) return { hot, cold: null };
  const cold: TtlStageBreakdown = {
    records: {
      normal: r.coldNormal,
      trace: r.coldTrace,
      zipkinTrace: r.coldZipkinTrace,
      log: r.coldLog,
      browserErrorLog: r.coldBrowserErrorLog,
    },
    metrics: {
      // OAP does not surface a cold metadata TTL — drop the field
      // (the UI hides cards with `undefined` values).
      minute: m.coldMinute,
      hour: m.coldHour,
      day: m.coldDay,
    },
  };
  return { hot, cold };
}

export interface TtlRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
}

export function registerTtlRoute(app: FastifyInstance, deps: TtlRouteDeps): void {
  const auth = requireAuth(deps);
  app.get('/api/oap/ttl', { preHandler: auth }, async (_req: FastifyRequest, reply: FastifyReply) => {
    const cfg = deps.config.current;
    try {
      const raw = await graphqlPost<TtlRaw>(buildOapOpts(cfg, deps.fetch), TTL_QUERY);
      const stages = deriveStages(raw);
      const body: OapTtlResponse = {
        reachable: true,
        records: raw.records ?? undefined,
        metrics: raw.metrics ?? undefined,
        backend: classifyBackend(raw),
        stages: stages ?? undefined,
      };
      return reply.send(body);
    } catch (err) {
      const body: OapTtlResponse = {
        reachable: false,
        backend: 'unknown',
        error: err instanceof Error ? err.message : String(err),
      };
      return reply.status(200).send(body);
    }
  });
}
