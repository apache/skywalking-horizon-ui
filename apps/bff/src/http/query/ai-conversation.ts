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
 * AI agent conversations — the `AI_AGENT` layer, landed by the AI Sessionizer.
 *
 *   POST /api/layer/:key/ai-conversations          one row per conversation
 *   GET  /api/ai-conversation/:conversation/view   the whole conversation, one `asz.view` document
 *
 * The list wraps `listConversations`. Its `limit` counts ROUNDS, not rows: OAP
 * reads the newest `limit` rounds in the window and folds them to one row per
 * conversation, so a chatty conversation spends the budget of the quiet ones.
 * Measured on a real corpus: at OAP's default of 1,000, one 865-round
 * conversation pushed a 19-round one off the list. The BFF therefore sends the
 * OAP ceiling by default (`performance.aiConversation.listLimit`) and names the
 * limit in the response so the page can state the rule — OAP gives no
 * truncation signal to relay.
 *
 * The view relays OAP's own route, streamed and still compressed: the largest
 * real document is 61 MB, 13 MB as gzip, and its first byte arrives only after
 * OAP has folded the whole chain (8.5 s measured). So the relay runs under
 * `performance.aiConversation.viewTimeoutMs`, not `oap.timeoutMs`, forwards the
 * browser's `Accept-Encoding` so OAP compresses for the browser, and passes
 * OAP's problem+json errors through with their status. It makes no other OAP
 * call: the OAP doc says the page reads this route and nothing else.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  AiConversationsQueryRequest,
  AiConversationsResponse,
  FetchLike,
} from '@skywalking-horizon-ui/api-client';
import type { AuthDeps } from '../../user/middleware.js';
import { requireAuth } from '../../user/middleware.js';
import { buildOapOpts } from '../../client/graphql.js';
import {
  AiConversationViewTimeout,
  listAiConversations,
  openAiConversationView,
  type AiConversationViewUpstream,
} from '../../client/ai-conversation.js';
import { clientGone } from '../client-gone.js';
import { withColdStage } from '../../util/duration.js';
import { fmtSecond, getServerOffsetMinutes } from '../../util/window.js';

export interface AiConversationRouteDeps extends AuthDeps {
  fetch?: FetchLike;
}

/** A conversation lives for days, and the list reads only round headers, so the
 *  window is wide where the trace and log feeds keep a week. */
const DEFAULT_WINDOW_MIN = 60 * 24 * 7;
const MAX_WINDOW_MIN = 60 * 24 * 90;
const WINDOW_MIN_MS = 60_000;

/** The window in epoch ms: an explicit range clamped to its newest 90 days, or
 *  a rolling one ending at `nowMs`. Mirrors the events feed's arithmetic so the
 *  three feeds cannot drift on what "a week" means. */
export function clampWindowMs(
  windowMinutes: number | undefined,
  explicit: { startMs?: number; endMs?: number } | undefined,
  nowMs = Date.now(),
): { startMs: number; endMs: number } {
  const maxMs = MAX_WINDOW_MIN * WINDOW_MIN_MS;
  if (
    typeof explicit?.startMs === 'number' &&
    typeof explicit.endMs === 'number' &&
    Number.isFinite(explicit.startMs) &&
    Number.isFinite(explicit.endMs) &&
    explicit.startMs < explicit.endMs
  ) {
    return { startMs: Math.max(explicit.startMs, explicit.endMs - maxMs), endMs: explicit.endMs };
  }
  const minutes =
    Number.isFinite(windowMinutes) && (windowMinutes as number) > 0
      ? Math.min(MAX_WINDOW_MIN, Math.round(windowMinutes as number))
      : DEFAULT_WINDOW_MIN;
  return { startMs: nowMs - minutes * WINDOW_MIN_MS, endMs: nowMs };
}

/** The `limit` sent to OAP: what the caller asked for, never above the
 *  configured cap, and the cap itself when the caller said nothing — the cap is
 *  the OAP ceiling by default, because a smaller number hides conversations. */
export function clampLimit(requested: number | undefined, cap: number): number {
  if (!Number.isFinite(requested as number) || (requested as number) < 1) return cap;
  return Math.min(cap, Math.round(requested as number));
}

/** OAP reads `Accept` the same way: any type naming yaml gets the yaml twin. */
export function wantsYaml(accept: string | string[] | undefined): boolean {
  const v = Array.isArray(accept) ? accept.join(',') : accept ?? '';
  return v.toLowerCase().includes('yaml');
}

/** The upstream headers the browser must see. `Content-Encoding` is the one
 *  that matters — the body is forwarded compressed — and `Content-Type` names
 *  the document and its version. Everything else about the upstream hop
 *  (server, date, connection) stays there. */
export function passthroughHeaders(upstream: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ['content-type', 'content-encoding', 'content-length', 'vary']) {
    const v = upstream[name];
    if (v) out[name] = v;
  }
  return out;
}

export function registerAiConversationRoutes(app: FastifyInstance, deps: AiConversationRouteDeps): void {
  const auth = requireAuth(deps);

  app.post(
    '/api/layer/:key/ai-conversations',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { key } = req.params as { key: string };
      if (!key || !/^[a-z0-9_]+$/i.test(key)) {
        return reply.code(400).send({ error: 'invalid_layer_key' });
      }
      const body = (req.body ?? {}) as AiConversationsQueryRequest;
      const serviceName = typeof body.service === 'string' ? body.service.trim() : '';
      if (!serviceName) {
        return reply.code(400).send({ error: 'service_required' });
      }
      const cfg = deps.config.current;
      const signal = clientGone(reply);
      const limit = clampLimit(body.limit, cfg.performance.aiConversation.listLimit);
      const instanceName =
        typeof body.instanceName === 'string' && body.instanceName.trim()
          ? body.instanceName.trim()
          : undefined;
      const respond = (partial: Pick<AiConversationsResponse, 'rows' | 'reachable' | 'error'>) =>
        reply.send({
          generatedAt: Date.now(),
          query: body,
          limit,
          ...partial,
        } satisfies AiConversationsResponse);
      try {
        const offset = await getServerOffsetMinutes(deps.config, deps.fetch, signal);
        const { startMs, endMs } = clampWindowMs(body.windowMinutes, {
          startMs: body.startMs,
          endMs: body.endMs,
        });
        const duration = withColdStage(req, {
          start: fmtSecond(startMs, offset),
          end: fmtSecond(endMs, offset),
          step: 'SECOND' as const,
        });
        const { rows, errorReason } = await listAiConversations(
          buildOapOpts(cfg, deps.fetch, signal),
          { serviceName, instanceName, limit, duration },
        );
        rows.sort((a, b) => b.to - a.to);
        return respond({ rows, reachable: true, ...(errorReason ? { error: errorReason } : {}) });
      } catch (err) {
        return respond({
          rows: [],
          reachable: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  app.get(
    '/api/ai-conversation/:conversation/view',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { conversation } = req.params as { conversation: string };
      const q = req.query as { service?: string; instance?: string };
      const serviceName = typeof q.service === 'string' ? q.service.trim() : '';
      if (!conversation || !serviceName) {
        return reply.code(400).send({ error: 'service_required' });
      }
      const cfg = deps.config.current;
      const acceptEncoding = req.headers['accept-encoding'];
      let upstream: AiConversationViewUpstream;
      try {
        upstream = await openAiConversationView(
          {
            queryUrl: cfg.oap.queryUrl,
            auth: cfg.oap.auth,
            timeoutMs: cfg.performance.aiConversation.viewTimeoutMs,
            signal: clientGone(reply),
          },
          {
            conversation,
            serviceName,
            instanceName: typeof q.instance === 'string' && q.instance ? q.instance : undefined,
            format: wantsYaml(req.headers.accept) ? 'yaml' : 'json',
            acceptEncoding: typeof acceptEncoding === 'string' ? acceptEncoding : undefined,
          },
        );
      } catch (err) {
        if (err instanceof AiConversationViewTimeout) {
          return reply.code(504).send({ error: 'oap_timeout', message: err.message });
        }
        if (err instanceof Error && err.name === 'AbortError') {
          // The browser left before OAP answered; there is nobody to reply to.
          return reply.code(499).send();
        }
        return reply
          .code(502)
          .send({ error: 'oap_unreachable', message: err instanceof Error ? err.message : String(err) });
      }
      reply.code(upstream.status);
      for (const [name, value] of Object.entries(passthroughHeaders(upstream.headers))) {
        reply.header(name, value);
      }
      return reply.send(upstream.body);
    },
  );
}
