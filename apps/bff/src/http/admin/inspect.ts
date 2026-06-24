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
  INSPECT_FOREIGN_VALUE_TYPES,
  INSPECT_STEPS,
  isInspectDate,
  type FetchLike,
  type InspectCatalog,
  type InspectForeignValueType,
  type InspectMetricType,
  type InspectStep,
  type InspectValuesRequest,
  type ForeignMetricInput,
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

const VALID_FOREIGN_VALUE_TYPES = new Set<InspectForeignValueType>(INSPECT_FOREIGN_VALUE_TYPES);

/** Mirrors OAP's `InspectRestHandler.VALUE_COLUMN_PATTERN` — a storage column
 *  is a plain SQL identifier. Validating it here fails a typo'd column at the
 *  edge instead of bouncing it off OAP. */
const VALUE_COLUMN_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

      // Foreign-metric path: `valueColumn` + `valueType` let OAP inspect a
      // metric it doesn't define (persisted by another OAP into shared
      // storage). OAP requires BOTH; we mirror that with a crisp 400 rather
      // than forwarding a half-specified pair and surfacing OAP's generic
      // "unknown locally" error.
      const foreign = parseForeign(q.valueColumn, q.valueType, reply);
      if (foreign === null) return; // 400 already sent.

      try {
        const got = await clients()
          .inspect()
          .listEntities({
            metric: q.metric,
            start: q.start,
            end: q.end,
            step,
            ...(limit !== undefined ? { limit } : {}),
            ...foreign,
          });
        return reply.send(got);
      } catch (err) {
        return passInspectError(err, reply, '/inspect/entities');
      }
    },
  );

  // ── /api/inspect/values ──────────────────────────────────────────
  // Reads VALUES of FOREIGN metric(s) the connected OAP doesn't define,
  // via OAP's admin-port `POST /inspect/values` (returns the same
  // ExpressionResult shape as execExpression). This is the value path
  // for foreign metrics — execExpression can't evaluate a metric the
  // OAP has no model for.

  app.post(
    '/api/inspect/values',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!ensureVerb(req, reply, deps, 'inspect:read')) return;
      const body = parseValuesBody(req.body, reply);
      if (!body) return; // 400 already sent.
      try {
        const result = await clients().inspect().inspectValues(body);
        return reply.send(result);
      } catch (err) {
        return passInspectError(err, reply, '/inspect/values');
      }
    },
  );
}

// ── helpers ───────────────────────────────────────────────────────

/** Parse the foreign-metric `valueColumn` / `valueType` pair. Returns an
 *  empty object for an aware request (neither supplied), the validated pair
 *  for a foreign request (both supplied), or `null` after sending a 400 when
 *  the pair is half-specified or `valueType` is out of range. */
function parseForeign(
  valueColumn: string | undefined,
  valueType: string | undefined,
  reply: FastifyReply,
): { valueColumn: string; valueType: InspectForeignValueType } | Record<string, never> | null {
  const hasColumn = typeof valueColumn === 'string' && valueColumn.length > 0;
  const hasType = typeof valueType === 'string' && valueType.length > 0;
  if (!hasColumn && !hasType) return {};
  if (!hasColumn || !hasType) {
    reply.code(400).send({
      error: 'foreign_requires_both',
      message: 'valueColumn and valueType must be supplied together to inspect a foreign metric',
    });
    return null;
  }
  if (!VALUE_COLUMN_PATTERN.test(valueColumn as string)) {
    reply.code(400).send({
      error: 'invalid_value_column',
      detail: `valueColumn is invalid: ${valueColumn}`,
      value: valueColumn,
    });
    return null;
  }
  const upper = (valueType as string).toUpperCase();
  if (!VALID_FOREIGN_VALUE_TYPES.has(upper as InspectForeignValueType)) {
    reply.code(400).send({
      error: 'invalid_value_type',
      value: valueType,
      allowed: INSPECT_FOREIGN_VALUE_TYPES,
    });
    return null;
  }
  return { valueColumn: valueColumn as string, valueType: upper as InspectForeignValueType };
}

/** Validate the `POST /api/inspect/values` body. Returns the typed request,
 *  or `null` after sending a 400. Mirrors the essentials OAP enforces so a
 *  malformed UI request fails crisply rather than as a generic upstream error;
 *  OAP remains the final authority (e.g. a metric that's actually local). */
function parseValuesBody(body: unknown, reply: FastifyReply): InspectValuesRequest | null {
  if (typeof body !== 'object' || body === null) {
    reply.code(400).send({ error: 'invalid_body' });
    return null;
  }
  const b = body as Partial<InspectValuesRequest>;
  if (typeof b.expression !== 'string' || b.expression.length === 0) {
    reply.code(400).send({ error: 'missing_expression' });
    return null;
  }
  if (typeof b.entity !== 'object' || b.entity === null || typeof b.entity.scope !== 'string') {
    reply.code(400).send({ error: 'invalid_entity', detail: 'entity.scope is required' });
    return null;
  }
  if (typeof b.step !== 'string' || !INSPECT_STEPS.includes(b.step.toUpperCase() as InspectStep)) {
    reply.code(400).send({ error: 'invalid_step', allowed: INSPECT_STEPS });
    return null;
  }
  const step = b.step.toUpperCase() as InspectStep;
  if (typeof b.start !== 'string' || !isInspectDate(b.start, step)) {
    reply.code(400).send({ error: 'invalid_start_format', step });
    return null;
  }
  if (typeof b.end !== 'string' || !isInspectDate(b.end, step)) {
    reply.code(400).send({ error: 'invalid_end_format', step });
    return null;
  }
  if (!Array.isArray(b.foreignMetrics) || b.foreignMetrics.length === 0) {
    reply.code(400).send({ error: 'missing_foreign_metrics' });
    return null;
  }
  const foreignMetrics: ForeignMetricInput[] = [];
  for (const fm of b.foreignMetrics) {
    if (typeof fm?.name !== 'string' || fm.name.length === 0) {
      reply.code(400).send({ error: 'invalid_foreign_metric', detail: 'name is required' });
      return null;
    }
    if (typeof fm.valueColumn !== 'string' || fm.valueColumn.length === 0) {
      reply.code(400).send({ error: 'invalid_foreign_metric', detail: 'valueColumn is required' });
      return null;
    }
    if (!VALUE_COLUMN_PATTERN.test(fm.valueColumn)) {
      reply.code(400).send({ error: 'invalid_foreign_metric', detail: `valueColumn is invalid: ${fm.valueColumn}` });
      return null;
    }
    const vt = typeof fm.valueType === 'string' ? fm.valueType.toUpperCase() : '';
    if (!VALID_FOREIGN_VALUE_TYPES.has(vt as InspectForeignValueType)) {
      reply.code(400).send({ error: 'invalid_value_type', value: fm.valueType, allowed: INSPECT_FOREIGN_VALUE_TYPES });
      return null;
    }
    foreignMetrics.push({ name: fm.name, valueColumn: fm.valueColumn, valueType: vt as InspectForeignValueType });
  }
  return {
    expression: b.expression,
    entity: b.entity,
    start: b.start,
    end: b.end,
    step,
    foreignMetrics,
  };
}

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
      // `POST /inspect/values` (and the foreign `/inspect/entities` params) are
      // newer than the base inspect module, so a 404 there means a different
      // thing than a 404 on the catalog: the inspect module IS enabled (the
      // catalog loaded, or the page-level banner already covers a fully-off
      // module), but THIS OAP build predates the foreign-values endpoint. A
      // generic "Set SW_INSPECT=default" would misdirect the operator — point
      // at the OAP version instead. This is the exact cross-version case the
      // foreign-metric feature exists for, so the message has to be honest.
      if (path === '/inspect/values') {
        return reply.code(404).send({
          error: 'inspect_values_unsupported',
          message:
            'OAP did not expose POST /inspect/values. Reading a foreign metric’s ' +
            'values needs a newer OAP build (or, if the whole inspect module is off, ' +
            'set SW_INSPECT=default on the admin-server).',
          path,
        });
      }
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
