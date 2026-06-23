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
 * SWIP-14 Inspect API surface — BFF proxy for the admin-only routes
 * exposed by OAP's `inspect` feature module (port 17128):
 *
 *   GET /api/inspect/metrics
 *   GET /api/inspect/entities
 *
 * The MQE values themselves are NOT served here — those go via the
 * regular GraphQL `execExpression` mutation, which the BFF proxies in
 * `inspect-exec.ts`. The merged catalog endpoint `/api/inspect/catalog`
 * layers Studio-side rule attribution on top of `/inspect/metrics`.
 *
 * Inspect is read-only and metadata-ish — every route is gated on a
 * single `inspect:read` verb. There is no write surface.
 *
 * INSPECT_NOT_ENABLED disambiguation: OAP returns a plain 404 for the
 * inspect routes when `SW_INSPECT=default` was not set. The plain
 * `oap_unreachable` envelope from the generic error handler would be
 * misleading there, so we sniff for 404s on these specific paths and
 * promote them to a structured `inspect_not_enabled` code that the SPA
 * surfaces as an actionable banner.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  InspectApiError,
  INSPECT_ENTITY_LIMIT_MAX,
  INSPECT_STEPS,
  isInspectDate,
  type FetchLike,
  type InspectCatalog,
  type InspectMetricType,
  type InspectStep,
} from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { AuditLogger } from '../../audit/logger.js';
import { requireAuth } from '../../user/middleware.js';
import { sessionHasVerb } from '../../rbac/policy.js';
import type { Session, SessionStore } from '../../user/sessions.js';
import { buildOapClients, type OapClients } from '../../client/index.js';
import { AttributionCache, attributeOrUnknown } from '../../logic/inspect/attribution.js';
import { MqeTargetCache } from '../../util/mqe-target.js';
import { parseExecBody, fireMqe, MqeFireError } from '../../logic/inspect/exec.js';
import { ServerTimeCache } from '../../util/time.js';

export interface InspectRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  audit: AuditLogger;
  fetch?: FetchLike;
}

const VALID_METRIC_TYPES = new Set<InspectMetricType>([
  'REGULAR_VALUE',
  'LABELED_VALUE',
  'HEATMAP',
  'SAMPLED_RECORD',
]);

const TRUTHY = new Set(['true', '1', 'yes']);

export function registerInspectRoutes(app: FastifyInstance, deps: InspectRouteDeps): void {
  const auth = requireAuth(deps);
  /* One cache per server. The cache's `get()` is fingerprint-aware,
   * so it auto-invalidates whenever rules change; `refresh=true` on
   * /api/inspect/catalog busts it explicitly for the SPA's manual
   * refresh button. */
  const attribution = new AttributionCache();
  const mqeTarget = new MqeTargetCache();
  const serverTime = new ServerTimeCache();

  function clients(): OapClients {
    return buildOapClients(deps.config.current, { fetch: deps.fetch });
  }

  // ── /api/inspect/metrics ─────────────────────────────────────────

  app.get(
    '/api/inspect/metrics',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!ensureVerb(req, reply, deps, 'inspect:read')) return;
      const q = req.query as Record<string, string | string[] | undefined>;

      const types = parseTypes(q.type, reply);
      if (types === null) return;
      const catalogs = parseCatalogs(q.catalog);

      const args: Parameters<ReturnType<OapClients['inspect']>['listMetrics']>[0] = {};
      if (typeof q.regex === 'string' && q.regex.length > 0) args.regex = q.regex;
      if (types.length > 0) args.type = types;
      if (catalogs.length > 0) args.catalog = catalogs;
      if (typeof q.mqeQueryable === 'string' && TRUTHY.has(q.mqeQueryable.toLowerCase())) {
        args.mqeQueryable = true;
      }

      try {
        const got = await clients().inspect().listMetrics(args);
        return reply.send(got);
      } catch (err) {
        return passInspectError(err, reply, '/inspect/metrics');
      }
    },
  );

  // ── /api/inspect/catalog ─────────────────────────────────────────
  // Merges `/inspect/metrics` with Studio's rule-file attribution
  // (source + file per metric). This is the endpoint the Inspect
  // page's catalog drawer hits — the raw `/api/inspect/metrics`
  // proxy above stays for scripting / debugging.

  app.get(
    '/api/inspect/catalog',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!ensureVerb(req, reply, deps, 'inspect:read')) return;
      const q = req.query as Record<string, string | undefined>;
      if (q.refresh === 'true' || q.refresh === '1') attribution.invalidate();

      try {
        const c = clients();
        const [metricsRes, idx] = await Promise.all([
          c.inspect().listMetrics(),
          attribution.get({ oal: () => c.oal(), rules: () => c.primary() }),
        ]);

        const entries = metricsRes.metrics.map((m) => {
          const attr = attributeOrUnknown(idx, m.name);
          return {
            ...m,
            attribution: attr,
          };
        });

        const summary: Record<string, number> = {};
        for (const e of entries) {
          summary[e.attribution.source] = (summary[e.attribution.source] ?? 0) + 1;
        }

        return reply.send({
          metrics: entries,
          summary,
          attributionFingerprint: idx.fingerprint,
        });
      } catch (err) {
        return passInspectError(err, reply, '/inspect/metrics');
      }
    },
  );

  // ── /api/inspect/server-time ─────────────────────────────────────
  // Caches OAP's `getTimeInfo` so the SPA can display dates in browser
  // local TZ while sending server-TZ strings to OAP.

  app.get(
    '/api/inspect/server-time',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!ensureVerb(req, reply, deps, 'inspect:read')) return;
      const q = req.query as Record<string, string | undefined>;
      if (q.refresh === 'true' || q.refresh === '1') serverTime.invalidate();
      const fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
      const value = await serverTime.get({
        config: () => deps.config.current,
        fetch: fetchImpl,
        mqeTarget,
      });
      return reply.send(value);
    },
  );

  // ── /api/inspect/exec ────────────────────────────────────────────
  // Fires `mutation execExpression` against the resolved MQE base
  // and returns the `ExpressionResult` payload verbatim.

  app.post(
    '/api/inspect/exec',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!ensureVerb(req, reply, deps, 'inspect:read')) return;
      const body = parseExecBody(req.body, reply);
      if (!body) return; // 400 already sent.

      const cfg = deps.config.current;
      const fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
      try {
        const target = await mqeTarget.resolve({
          config: () => cfg,
          fetch: fetchImpl,
        });
        const result = await fireMqe(target, body, {
          fetch: fetchImpl,
          timeoutMs: cfg.oap.timeoutMs,
          ...(cfg.oap.auth ? { auth: cfg.oap.auth } : {}),
        });
        return reply.send(result);
      } catch (err) {
        if (err instanceof MqeFireError) {
          return reply.code(502).send({
            error: 'mqe_error',
            message: err.message,
            graphqlErrors: err.graphqlErrors,
          });
        }
        return reply.code(502).send({
          error: 'mqe_target_unresolved',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // ── /api/inspect/entities ────────────────────────────────────────

  app.get(
    '/api/inspect/entities',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!ensureVerb(req, reply, deps, 'inspect:read')) return;
      const q = req.query as Record<string, string | undefined>;

      if (!q.metric) return reply.code(400).send({ error: 'missing_metric' });
      if (!q.start) return reply.code(400).send({ error: 'missing_start' });
      if (!q.end) return reply.code(400).send({ error: 'missing_end' });
      if (!q.step) return reply.code(400).send({ error: 'missing_step' });

      const step = parseStep(q.step, reply);
      if (step === null) return;

      // We validate dates client-side too. OAP also validates and
      // returns a 400 with a helpful message, but pre-validating keeps
      // a misformatted UI input from showing as a generic error.
      if (!isInspectDate(q.start, step)) {
        return reply.code(400).send({ error: 'invalid_start_format', step, value: q.start });
      }
      if (!isInspectDate(q.end, step)) {
        return reply.code(400).send({ error: 'invalid_end_format', step, value: q.end });
      }

      let limit: number | undefined;
      if (q.limit !== undefined) {
        const parsed = Number.parseInt(q.limit, 10);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > INSPECT_ENTITY_LIMIT_MAX) {
          return reply.code(400).send({
            error: 'invalid_limit',
            min: 1,
            max: INSPECT_ENTITY_LIMIT_MAX,
            value: q.limit,
          });
        }
        limit = parsed;
      }

      try {
        const got = await clients()
          .inspect()
          .listEntities({
            metric: q.metric,
            start: q.start,
            end: q.end,
            step,
            ...(limit !== undefined ? { limit } : {}),
          });
        return reply.send(got);
      } catch (err) {
        return passInspectError(err, reply, '/inspect/entities');
      }
    },
  );
}

// ── helpers ───────────────────────────────────────────────────────

function parseStep(raw: string, reply: FastifyReply): InspectStep | null {
  const upper = raw.toUpperCase();
  if (INSPECT_STEPS.includes(upper as InspectStep)) return upper as InspectStep;
  reply.code(400).send({
    error: 'invalid_step',
    value: raw,
    allowed: INSPECT_STEPS,
  });
  return null;
}

/** Returns the (deduped) `InspectMetricType[]` parsed from the query;
 *  returns `null` after sending a 400 if any value is unrecognised. */
function parseTypes(
  raw: string | string[] | undefined,
  reply: FastifyReply,
): InspectMetricType[] | null {
  if (raw === undefined) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const out: InspectMetricType[] = [];
  for (const v of arr) {
    const upper = v.toUpperCase();
    if (!VALID_METRIC_TYPES.has(upper as InspectMetricType)) {
      reply.code(400).send({ error: 'invalid_type', value: v });
      return null;
    }
    if (!out.includes(upper as InspectMetricType)) out.push(upper as InspectMetricType);
  }
  return out;
}

/** Catalog values are open-ended on the OAP side (`DefaultScopeDefine`
 *  can add new catalogs without an OAP-side enum change), so we don't
 *  validate the value itself — just upper-case for consistency and
 *  pass through. */
function parseCatalogs(raw: string | string[] | undefined): InspectCatalog[] {
  if (raw === undefined) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const out: InspectCatalog[] = [];
  for (const v of arr) {
    const upper = v.toUpperCase();
    if (!out.includes(upper)) out.push(upper);
  }
  return out;
}

function ensureVerb(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: InspectRouteDeps,
  verb: string,
): boolean {
  const session: Session | undefined = req.session;
  if (!session) {
    reply.code(401).send({ error: 'unauthenticated' });
    return false;
  }
  if (!sessionHasVerb(deps.config.current, session.roles, verb)) {
    reply.code(403).send({ error: 'permission_denied', verb });
    return false;
  }
  return true;
}

/** Translate every Inspect error into the BFF's envelope. The unique
 *  case is OAP returning 404 for an inspect path — that means the
 *  inspect module isn't enabled on OAP (no handler bound). Promote
 *  to a structured `inspect_not_enabled` code so the SPA can surface
 *  an actionable banner instead of a generic 404.
 *
 *  All other InspectApiError shapes (400 from validation, 500 from
 *  storage) are forwarded with their original status + body, so
 *  OAP's error.message reaches the operator unchanged. */
function passInspectError(err: unknown, reply: FastifyReply, path: string): FastifyReply {
  if (err instanceof InspectApiError) {
    if (err.status === 404) {
      return reply.code(404).send({
        error: 'inspect_not_enabled',
        message: 'OAP did not bind the inspect routes. Set SW_INSPECT=default on the admin-server.',
        path,
      });
    }
    return reply.code(err.status).send(err.body);
  }
  return reply.code(502).send({
    error: 'oap_unreachable',
    message: err instanceof Error ? err.message : String(err),
    path,
  });
}
