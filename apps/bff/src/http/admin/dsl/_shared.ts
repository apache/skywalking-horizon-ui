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
 * Shared deps + parsers + audit/verb helpers for every DSL admin handler
 * (catalog / rule / dump / oal). Lives next to the routes so each handler
 * file stays small enough to read in one screen.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  RuntimeRuleApiError,
  isCatalog,
  type Catalog,
  type DeleteMode,
  type FetchLike,
} from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../../config/loader.js';
import type { AuditLogger } from '../../../audit/logger.js';
import type { Session, SessionStore } from '../../../user/sessions.js';
import { sessionHasVerb } from '../../../rbac/policy.js';
import { buildOapClients, type OapClients } from '../../../client/index.js';

export interface DslRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  audit: AuditLogger;
  /** Test seam — replaces `globalThis.fetch` in every OAP call. */
  fetch?: FetchLike;
}

export function makeClients(deps: DslRouteDeps): () => OapClients {
  return () => buildOapClients(deps.config.current, { fetch: deps.fetch });
}

const TRUTHY = new Set(['true', '1', 'yes']);
export function parseBoolean(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return TRUTHY.has(v.toLowerCase());
}

export function hasCatalogParam(q: unknown): boolean {
  return typeof q === 'object' && q !== null && 'catalog' in q;
}

/** When `catalog` is missing → returns `undefined`. When present but
 *  invalid → sends 400 and returns `undefined`; callers use
 *  {@link hasCatalogParam} to disambiguate. */
export function parseOptionalCatalog(q: unknown, reply: FastifyReply): Catalog | undefined {
  const raw = (q as Record<string, string | undefined>).catalog;
  if (raw === undefined || raw === '') return undefined;
  if (!isCatalog(raw)) {
    reply.code(400).send({ error: 'invalid_catalog', value: raw });
    return undefined;
  }
  return raw;
}

export function parseRequiredCatalog(q: unknown, reply: FastifyReply): Catalog | null {
  const raw = (q as Record<string, string | undefined>).catalog;
  if (!raw) {
    reply.code(400).send({ error: 'missing_catalog' });
    return null;
  }
  if (!isCatalog(raw)) {
    reply.code(400).send({ error: 'invalid_catalog', value: raw });
    return null;
  }
  return raw;
}

export function parseDeleteMode(raw: string | undefined, reply: FastifyReply): DeleteMode | null {
  if (raw === undefined || raw === '') return '';
  if (raw === 'revertToBundled') return 'revertToBundled';
  reply.code(400).send({ error: 'invalid_delete_mode', value: raw });
  return null;
}

export function ensureVerb(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: DslRouteDeps,
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

export function passOapError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof RuntimeRuleApiError) {
    return reply.code(err.status).send(err.body);
  }
  return reply.code(502).send({
    error: 'oap_unreachable',
    message: err instanceof Error ? err.message : String(err),
  });
}

/**
 * Revert-to-bundled runs OAP's structural apply pipeline INLINE (it has no
 * applyId / phase tracking, unlike `/addOrUpdate`) and can outlast OAP's
 * admin request timeout: OAP returns 503 `RequestTimeoutException`, or the
 * BFF's own fetch aborts first — but the apply keeps running under OAP's
 * per-file lock and completes regardless. Treating that as a hard failure
 * makes operators retry, piling new waiters on the same lock. So for revert
 * we report `202 submitted` and the UI confirms by re-reading the rule.
 * (`/addOrUpdate` no longer needs this: a structural apply returns 200
 * `structural_applied` + `applyId` immediately at phase FENCING, so the UI
 * polls /status instead.) Genuine 4xx rejections (409
 * requires_inactivate_first / requires_revert_to_bundled, 400
 * no_bundled_twin, …) are NOT timeouts and fall through to the error path.
 */
export function isOapApplyTimeout(err: unknown): boolean {
  if (err instanceof RuntimeRuleApiError) {
    return err.status === 503 || err.status === 504;
  }
  // The BFF's own AbortController fired (oap.timeoutMs) or a network timeout.
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/** Map an apply-timeout to `202 submitted`; everything else to the normal
 *  audited OAP-error path. Used by the structural mutation routes. */
export function passSubmittedOrError(
  err: unknown,
  reply: FastifyReply,
  deps: DslRouteDeps,
  req: FastifyRequest,
  action: string,
  verb: string,
  catalog: Catalog,
  name: string,
  details: Record<string, unknown> = {},
): FastifyReply {
  if (isOapApplyTimeout(err)) {
    deps.audit.record({
      action,
      verb,
      actor: req.session?.username ?? null,
      outcome: 'submitted',
      details: { catalog, name, ...details },
      fromIp: req.ip,
      sessionId: req.session?.sid,
    });
    return reply.code(202).send({
      applyStatus: 'submitted',
      catalog,
      name,
      message:
        'OAP accepted the change and is applying it asynchronously; a structural apply can exceed the admin request timeout. Poll the rule status to confirm.',
    });
  }
  return passOapErrorAudit(err, reply, deps, req, action, verb, catalog, name, details);
}

export function passOapErrorAudit(
  err: unknown,
  reply: FastifyReply,
  deps: DslRouteDeps,
  req: FastifyRequest,
  action: string,
  verb: string,
  catalog: Catalog,
  name: string,
  details: Record<string, unknown> = {},
): FastifyReply {
  let outcome = 'oap_unreachable';
  if (err instanceof RuntimeRuleApiError) {
    const apiErr: RuntimeRuleApiError = err;
    const body = apiErr.body;
    outcome =
      typeof body === 'object' && body !== null && 'applyStatus' in body
        ? body.applyStatus
        : `http_${apiErr.status}`;
  }
  deps.audit.record({
    action,
    verb,
    actor: req.session?.username ?? null,
    outcome,
    details: { catalog, name, ...details },
    fromIp: req.ip,
    sessionId: req.session?.sid,
  });
  return passOapError(err, reply);
}

export function auditMutation(
  deps: DslRouteDeps,
  req: FastifyRequest,
  action: string,
  verb: string,
  catalog: Catalog,
  name: string,
  outcome: string,
  details: Record<string, unknown> = {},
): void {
  deps.audit.record({
    action,
    verb,
    actor: req.session?.username ?? null,
    outcome,
    details: { catalog, name, ...details },
    fromIp: req.ip,
    sessionId: req.session?.sid,
  });
}
