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
 * `/api/debug/*` routes — passthrough proxy for the actual SWIP-13
 * `/dsl-debugging/*` wire surface (see
 * `reference_swip13_actual_wire.md`).
 *
 *   POST /api/debug/session              — start (audited)
 *   GET  /api/debug/session/:id          — poll
 *   POST /api/debug/session/:id/stop     — stop  (audited)
 *   GET  /api/debug/sessions             — active list (JSON object)
 *   GET  /api/debug/status               — per-cluster fan-out
 *
 * The handler accepts a JSON body for input convenience (so the SPA
 * doesn't need to query-string-encode params) and translates to the
 * upstream's query-param shape on the wire. RBAC verb `rule:debug`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  MAX_RECORD_CAP,
  RuntimeRuleApiError,
  isDebugCatalog,
  isGranularity,
  type DebugCatalog,
  type DslDebuggingStatus,
  type Granularity,
  type StartSessionArgs,
} from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { AuditLogger } from '../../audit/logger.js';
import { requireAuth } from '../../user/middleware.js';
import { sessionHasVerb } from '../../rbac/policy.js';
import type { Session } from '../../user/sessions.js';
import type { SessionStore } from '../../user/sessions.js';
import { resolveTargets } from '../../util/dns-fanout.js';
import { buildOapClients, type OapClients } from '../../client/index.js';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';

export interface DebugRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  audit: AuditLogger;
  fetch?: FetchLike;
}

/** Per-node `/dsl-debugging/status` slice — keyed by admin URL. */
export interface ClusterDebugStatus {
  generatedAt: number;
  nodes: { url: string; ok: boolean; status?: DslDebuggingStatus; error?: string }[];
}

export function registerDebugRoutes(app: FastifyInstance, deps: DebugRouteDeps): void {
  const auth = requireAuth(deps);

  function clients(): OapClients {
    return buildOapClients(deps.config.current, { fetch: deps.fetch });
  }

  // ── start session ────────────────────────────────────────────────
  app.post(
    '/api/debug/session',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!ensureVerb(req, reply, deps, 'rule:debug')) return;
      const parsed = parseStartArgs(req.body, reply);
      if (!parsed) return;
      try {
        const result = await clients().debug().startSession(parsed);
        const local = result.priorCleanup?.local;
        const peers = result.priorCleanup?.peers ?? [];
        const totalPriorCleanup =
          (local?.stoppedCount ?? 0) +
          peers.reduce((n, p) => n + (p.stoppedCount ?? p.stoppedSessionIds?.length ?? 0), 0);
        deps.audit.record({
          action: 'debug.start',
          verb: 'rule:debug',
          actor: req.session?.username ?? null,
          outcome: 'ok',
          details: {
            sessionId: result.sessionId,
            clientId: parsed.clientId,
            catalog: parsed.catalog,
            name: parsed.name,
            ruleName: parsed.ruleName,
            granularity: result.granularity,
            localInstalled: result.localInstalled,
            installedCreated: result.installed?.created,
            installedTotal: result.installed?.total,
            recordCap: parsed.recordCap,
            retentionMillis: parsed.retentionMillis,
            priorCleanupCount: totalPriorCleanup,
          },
          fromIp: req.ip,
          sessionId: req.session?.sid,
        });
        return reply.send(result);
      } catch (err) {
        deps.audit.record({
          action: 'debug.start',
          verb: 'rule:debug',
          actor: req.session?.username ?? null,
          outcome: outcomeOf(err),
          details: {
            clientId: parsed.clientId,
            catalog: parsed.catalog,
            name: parsed.name,
            ruleName: parsed.ruleName,
          },
          fromIp: req.ip,
          sessionId: req.session?.sid,
        });
        return passOapError(err, reply);
      }
    },
  );

  // ── poll session ─────────────────────────────────────────────────
  app.get(
    '/api/debug/session/:id',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!ensureVerb(req, reply, deps, 'rule:debug')) return;
      const params = req.params as { id: string };
      if (!params.id) return reply.code(400).send({ error: 'missing_id' });
      try {
        const got = await clients().debug().getSession(params.id);
        if (got === null) return reply.code(404).send({ error: 'not_found' });
        return reply.send(got);
      } catch (err) {
        return passOapError(err, reply);
      }
    },
  );

  // ── stop session ─────────────────────────────────────────────────
  app.post(
    '/api/debug/session/:id/stop',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!ensureVerb(req, reply, deps, 'rule:debug')) return;
      const params = req.params as { id: string };
      if (!params.id) return reply.code(400).send({ error: 'missing_id' });
      try {
        const result = await clients().debug().stopSession(params.id);
        deps.audit.record({
          action: 'debug.stop',
          verb: 'rule:debug',
          actor: req.session?.username ?? null,
          outcome: 'ok',
          details: { sessionId: params.id, localStopped: result.localStopped },
          fromIp: req.ip,
          sessionId: req.session?.sid,
        });
        return reply.send(result);
      } catch (err) {
        deps.audit.record({
          action: 'debug.stop',
          verb: 'rule:debug',
          actor: req.session?.username ?? null,
          outcome: outcomeOf(err),
          details: { sessionId: params.id },
          fromIp: req.ip,
          sessionId: req.session?.sid,
        });
        return passOapError(err, reply);
      }
    },
  );

  // ── list active sessions ─────────────────────────────────────────
  app.get(
    '/api/debug/sessions',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!ensureVerb(req, reply, deps, 'rule:debug')) return;
      try {
        const list = await clients().debug().listSessions();
        return reply.send(list);
      } catch (err) {
        return passOapError(err, reply);
      }
    },
  );

  // ── per-cluster status fan-out ───────────────────────────────────
  // /dsl-debugging/status is a per-node read; OAP doesn't aggregate it
  // cluster-wide. We turn the single `oap.adminUrl` into one URL per
  // resolved IP via DNS lookup and probe each. When the hostname is
  // already an IP (or DNS returns one address), this collapses to a
  // single fire.
  app.get(
    '/api/debug/status',
    { preHandler: auth },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      // Gated by `live-debug:read` in ROUTE_POLICY (the single source of truth);
      // no extra in-handler verb so a caller doesn't need two grants.
      const c = clients();
      const targets = await resolveTargets(c.adminUrl());
      const nodes = await Promise.all(
        targets.map(async (t) => {
          try {
            const status = await c.debugForUrl(t.url).getStatus();
            return { url: t.url, ok: true as const, status };
          } catch (err) {
            return {
              url: t.url,
              ok: false as const,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );
      const body: ClusterDebugStatus = { generatedAt: Date.now(), nodes };
      return reply.send(body);
    },
  );
}

// ── helpers ─────────────────────────────────────────────────────────

function ensureVerb(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: DebugRouteDeps,
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

/** Validate the JSON body the SPA posts. Translates to the wire's
 *  query-param + optional-body shape inside `DslDebuggingClient`. */
function parseStartArgs(raw: unknown, reply: FastifyReply): StartSessionArgs | null {
  if (typeof raw !== 'object' || raw === null) {
    reply.code(400).send({ error: 'invalid_body' });
    return null;
  }
  const b = raw as Record<string, unknown>;
  if (typeof b.clientId !== 'string' || b.clientId.length === 0) {
    reply.code(400).send({ error: 'missing_clientId' });
    return null;
  }
  if (typeof b.catalog !== 'string' || !isDebugCatalog(b.catalog)) {
    reply.code(400).send({ error: 'invalid_catalog', value: b.catalog });
    return null;
  }
  if (typeof b.name !== 'string' || b.name.length === 0) {
    reply.code(400).send({ error: 'missing_name' });
    return null;
  }
  if (typeof b.ruleName !== 'string' || b.ruleName.length === 0) {
    reply.code(400).send({ error: 'missing_ruleName' });
    return null;
  }
  const out: StartSessionArgs = {
    clientId: b.clientId,
    catalog: b.catalog as DebugCatalog,
    name: b.name,
    ruleName: b.ruleName,
  };
  if (b.granularity !== undefined) {
    if (!isGranularity(b.granularity)) {
      reply.code(400).send({ error: 'invalid_granularity', value: b.granularity });
      return null;
    }
    out.granularity = b.granularity as Granularity;
  }
  // Bounds match upstream `SessionLimits.java` so we surface a 400
  // here rather than letting OAP reject the install with a
  // `invalid_limits` error after the round-trip.
  if (b.recordCap !== undefined) {
    if (
      typeof b.recordCap !== 'number' ||
      !Number.isFinite(b.recordCap) ||
      b.recordCap <= 0 ||
      b.recordCap > MAX_RECORD_CAP
    ) {
      reply.code(400).send({ error: 'invalid_recordCap' });
      return null;
    }
    out.recordCap = b.recordCap;
  }
  if (b.retentionMillis !== undefined) {
    if (
      typeof b.retentionMillis !== 'number' ||
      !Number.isFinite(b.retentionMillis) ||
      b.retentionMillis <= 0 ||
      b.retentionMillis > 3_600_000
    ) {
      reply.code(400).send({ error: 'invalid_retentionMillis' });
      return null;
    }
    out.retentionMillis = b.retentionMillis;
  }
  return out;
}

function outcomeOf(err: unknown): string {
  if (err instanceof RuntimeRuleApiError) {
    const body: unknown = err.body;
    if (typeof body === 'object' && body !== null) {
      const o = body as Record<string, unknown>;
      if (typeof o.code === 'string') return o.code;
      if (typeof o.applyStatus === 'string') return o.applyStatus;
    }
    return `http_${err.status}`;
  }
  return 'oap_unreachable';
}

function passOapError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof RuntimeRuleApiError) {
    return reply.code(err.status).send(err.body);
  }
  return reply.code(502).send({
    error: 'oap_unreachable',
    message: err instanceof Error ? err.message : String(err),
  });
}
