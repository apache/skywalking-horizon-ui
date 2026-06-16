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
 *   GET  /api/rule              — single rule fetch (`If-None-Match` aware).
 *   GET  /api/rule/status       — structural-apply progress (`rule:read`,
 *                                  poll by `applyId` or `contentHash`).
 *   POST /api/rule              — add or update (audited; structural
 *                                  writes need `rule:write:structural`).
 *                                  A structural apply returns 200
 *                                  `structural_applied` + `applyId` at
 *                                  phase FENCING; the UI polls /status.
 *   POST /api/rule/inactivate   — `rule:write`, audited.
 *   POST /api/rule/delete       — `rule:delete`; `mode=revertToBundled`
 *                                  is treated as a structural write.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '../../../user/middleware.js';
import {
  auditMutation,
  type DslRouteDeps,
  ensureVerb,
  makeClients,
  parseBoolean,
  parseDeleteMode,
  parseRequiredCatalog,
  passOapError,
  passOapErrorAudit,
  passSubmittedOrError,
} from './_shared.js';

export function registerDslRuleRoutes(app: FastifyInstance, deps: DslRouteDeps): void {
  const auth = requireAuth(deps);
  const clients = makeClients(deps);

  app.get('/api/rule', { preHandler: auth }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!ensureVerb(req, reply, deps, 'rule:read')) return;
    const q = req.query as Record<string, string | undefined>;
    const catalog = parseRequiredCatalog(q, reply);
    if (!catalog) return;
    if (!q.name) return reply.code(400).send({ error: 'missing_name' });
    const source = q.source as 'runtime' | 'bundled' | undefined;
    if (source !== undefined && source !== 'runtime' && source !== 'bundled') {
      return reply.code(400).send({ error: 'invalid_source', value: source });
    }
    const ifNoneMatch = req.headers['if-none-match'] as string | undefined;
    try {
      const got = await clients()
        .primary()
        .get({
          catalog,
          name: q.name,
          ...(source !== undefined ? { source } : {}),
          ...(ifNoneMatch !== undefined ? { ifNoneMatch } : {}),
        });
      if ('notModified' in got) {
        reply.header('etag', got.etag);
        reply.header('x-sw-content-hash', got.contentHash);
        reply.header('x-sw-status', got.status);
        return reply.code(304).send();
      }
      reply.header('content-type', 'application/x-yaml; charset=utf-8');
      reply.header('etag', got.etag);
      reply.header('x-sw-content-hash', got.contentHash);
      reply.header('x-sw-status', got.status);
      reply.header('x-sw-source', got.source);
      reply.header('x-sw-update-time', String(got.updateTime));
      return reply.send(got.content);
    } catch (err) {
      return passOapError(err, reply);
    }
  });

  // Poll target for a structural apply. The `structural_applied` response
  // carries an `applyId`; the UI polls this until the phase is terminal
  // (APPLIED / DEGRADED / FAILED), or by `contentHash` after a reload.
  app.get('/api/rule/status', { preHandler: auth }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!ensureVerb(req, reply, deps, 'rule:read')) return;
    const q = req.query as Record<string, string | undefined>;
    const catalog = parseRequiredCatalog(q, reply);
    if (!catalog) return;
    if (!q.name) return reply.code(400).send({ error: 'missing_name' });
    try {
      const status = await clients()
        .primary()
        .status({
          catalog,
          name: q.name,
          ...(q.applyId ? { applyId: q.applyId } : {}),
          ...(q.contentHash ? { contentHash: q.contentHash } : {}),
        });
      return reply.send(status);
    } catch (err) {
      return passOapError(err, reply);
    }
  });

  app.post('/api/rule', { preHandler: auth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as Record<string, string | undefined>;
    const catalog = parseRequiredCatalog(q, reply);
    if (!catalog) return;
    if (!q.name) return reply.code(400).send({ error: 'missing_name' });
    if (typeof req.body !== 'string' || req.body.length === 0) {
      return reply.code(400).send({ error: 'empty_body' });
    }
    const allowStorageChange = parseBoolean(q.allowStorageChange, false);
    const force = parseBoolean(q.force, false);
    const verb = allowStorageChange || force ? 'rule:write:structural' : 'rule:write';
    if (!ensureVerb(req, reply, deps, verb)) return;

    try {
      // A structural apply now returns 200 `structural_applied` + `applyId`
      // at phase FENCING (no longer runs past the request timeout) — relay
      // the result verbatim; the UI polls /api/rule/status by applyId.
      const result = await clients().primary().addOrUpdate({
        catalog,
        name: q.name,
        body: req.body,
        allowStorageChange,
        force,
      });
      auditMutation(deps, req, 'addOrUpdate', verb, catalog, q.name, result.applyStatus, {
        allowStorageChange,
        force,
      });
      return reply.send(result);
    } catch (err) {
      return passOapErrorAudit(err, reply, deps, req, 'addOrUpdate', verb, catalog, q.name);
    }
  });

  app.post(
    '/api/rule/inactivate',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = req.query as Record<string, string | undefined>;
      const catalog = parseRequiredCatalog(q, reply);
      if (!catalog) return;
      if (!q.name) return reply.code(400).send({ error: 'missing_name' });
      if (!ensureVerb(req, reply, deps, 'rule:write')) return;
      try {
        // inactivate returns synchronously (no schema change) — no async
        // apply to poll, so a failure is just an error, never `submitted`.
        const result = await clients().primary().inactivate(catalog, q.name);
        auditMutation(deps, req, 'inactivate', 'rule:write', catalog, q.name, result.applyStatus);
        return reply.send(result);
      } catch (err) {
        return passOapErrorAudit(err, reply, deps, req, 'inactivate', 'rule:write', catalog, q.name);
      }
    },
  );

  app.post(
    '/api/rule/delete',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = req.query as Record<string, string | undefined>;
      const catalog = parseRequiredCatalog(q, reply);
      if (!catalog) return;
      if (!q.name) return reply.code(400).send({ error: 'missing_name' });
      const mode = parseDeleteMode(q.mode, reply);
      if (mode === null) return;
      // mode=revertToBundled is structural — swaps the active row's
      // identity back to the bundled twin. A caller with only
      // `rule:delete` must not be able to revert.
      const verb = mode === 'revertToBundled' ? 'rule:write:structural' : 'rule:delete';
      if (!ensureVerb(req, reply, deps, verb)) return;
      try {
        const result = await clients().primary().delete(catalog, q.name, mode);
        auditMutation(deps, req, 'delete', verb, catalog, q.name, result.applyStatus, { mode });
        return reply.send(result);
      } catch (err) {
        // Plain delete and inactivate are synchronous. Only revert-to-bundled
        // runs the structural apply pipeline inline and can outlast the
        // request timeout (it has no applyId), so it alone still maps a
        // timeout to `202 submitted` for the UI's poll-by-reread.
        if (mode === 'revertToBundled') {
          return passSubmittedOrError(err, reply, deps, req, 'delete', verb, catalog, q.name, { mode });
        }
        return passOapErrorAudit(err, reply, deps, req, 'delete', verb, catalog, q.name, { mode });
      }
    },
  );
}
