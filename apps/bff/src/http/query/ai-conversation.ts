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
 * The view relays OAP's own route, still compressed: the largest real document
 * is 61 MB, 13 MB as gzip, and its first byte arrives only after OAP has folded
 * the whole chain (8.5 s measured). So the relay runs under
 * `performance.aiConversation.viewTimeoutMs`, not `oap.timeoutMs`, and passes
 * OAP's problem+json errors through with their status. It makes no other OAP
 * call: the OAP doc says the page reads this route and nothing else.
 *
 * OAP streams the document without knowing its length, so the BFF holds the
 * whole body (gzip, in memory, a fifth of the document) before answering, and
 * sends the decoded size and the summary's counts ahead of the bytes — that is
 * what lets the page say "12 of 61 MB". Only gzip is asked of OAP, because the
 * BFF decodes what it holds to count it.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  AiConversationsQueryRequest,
  AiConversationsResponse,
  FetchLike,
} from '@skywalking-horizon-ui/api-client';
import type { AuthDeps } from '../../user/middleware.js';
import { requireAuth } from '../../user/middleware.js';
import {
  AI_CONVERSATION_DOCUMENT_BYTES_HEADER,
  AI_CONVERSATION_DOCUMENT_SUMMARY_HEADER,
  ASZ_FILES_MAX_SEQS,
} from '@skywalking-horizon-ui/api-client';
import { buildOapOpts } from '../../client/graphql.js';
import { holdDocument } from '../../logic/ai-conversation/hold-document.js';
import {
  AiConversationViewTimeout,
  listAiConversations,
  openAiConversationFiles,
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

/**
 * Whether the client takes gzip. The body is forwarded exactly as OAP sends it, so a client that
 * refuses gzip must not be asked for it upstream. `Accept-Encoding: gzip;q=0` names gzip and refuses
 * it, and `*` offers everything unless gzip is refused by name, which RFC 9110 spells out.
 */
export function takesGzip(accept: string | string[] | undefined): boolean {
  const v = Array.isArray(accept) ? accept.join(',') : accept ?? '';
  let any = false;
  for (const part of v.split(',')) {
    const [name, ...rest] = part.trim().split(';');
    const coding = (name ?? '').trim().toLowerCase();
    if (coding !== 'gzip' && coding !== 'x-gzip' && coding !== '*') continue;
    const q = rest.map((p) => p.trim().toLowerCase()).find((p) => p.startsWith('q='));
    const refused = q ? Number(q.slice(2)) === 0 : false;
    if (coding === '*') {
      if (!refused) any = true;
      continue;
    }
    return !refused;
  }
  return any;
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
      const conversation =
        typeof body.conversation === 'string' && body.conversation.trim() ? body.conversation.trim() : undefined;
      const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 512) : undefined;
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
          { serviceName, instanceName, conversation, title, limit, duration },
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
      // Only what the BFF can decode is asked of OAP: gzip when the browser
      // takes gzip, plain bytes otherwise. Forwarding the browser's list could
      // bring back brotli or zstd, which would have to be relayed uncounted.
      const browserTakesGzip = takesGzip(req.headers['accept-encoding']);
      const yaml = wantsYaml(req.headers.accept);
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
            coldStage: !!req.coldStage,
            format: yaml ? 'yaml' : 'json',
            acceptEncoding: browserTakesGzip ? 'gzip' : 'identity',
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
      if (upstream.status !== 200) {
        // A problem document is small and complete; it goes as it came.
        reply.code(upstream.status);
        for (const [name, value] of Object.entries(passthroughHeaders(upstream.headers))) {
          reply.header(name, value);
        }
        return reply.send(upstream.body);
      }
      let held;
      try {
        held = await holdDocument(upstream.body, upstream.headers['content-encoding'], { summary: !yaml });
      } catch (err) {
        if (reply.raw.destroyed || (err instanceof Error && err.name === 'AbortError')) {
          return reply.code(499).send();
        }
        return reply
          .code(502)
          .send({ error: 'oap_unreachable', message: err instanceof Error ? err.message : String(err) });
      }
      reply.code(200);
      const headers = passthroughHeaders(upstream.headers);
      delete headers['content-length'];
      for (const [name, value] of Object.entries(headers)) {
        reply.header(name, value);
      }
      if (held.decodedBytes !== null) reply.header(AI_CONVERSATION_DOCUMENT_BYTES_HEADER, String(held.decodedBytes));
      if (held.summary) reply.header(AI_CONVERSATION_DOCUMENT_SUMMARY_HEADER, JSON.stringify(held.summary));
      return reply.send(held.body);
    },
  );

  // The stored files of one session, by their landed seqs: what the page reads when someone opens a
  // call's prompt. The bodies are as large as they were landed, so the stream is relayed as it
  // arrives rather than held, and the browser's own gzip is asked of OAP and passed through.
  app.get(
    '/api/ai-conversation/:conversation/files',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { conversation } = req.params as { conversation: string };
      const q = req.query as { service?: string; instance?: string; session?: string; seq?: string | string[] };
      const serviceName = typeof q.service === 'string' ? q.service.trim() : '';
      const instanceName = typeof q.instance === 'string' ? q.instance.trim() : '';
      const session = typeof q.session === 'string' ? q.session.trim() : '';
      if (!conversation || !serviceName || !instanceName) {
        return reply.code(400).send({ error: 'service_and_instance_required' });
      }
      if (!session) {
        return reply.code(400).send({ error: 'session_required' });
      }
      const raw = q.seq === undefined ? [] : Array.isArray(q.seq) ? q.seq : [q.seq];
      const seqs: number[] = [];
      for (const text of raw) {
        const n = Number(text);
        if (!Number.isSafeInteger(n) || n <= 0) {
          return reply.code(400).send({ error: 'seq_invalid', message: `${text} is not a positive whole number` });
        }
        seqs.push(n);
      }
      if (!seqs.length) {
        return reply.code(400).send({ error: 'seq_required' });
      }
      if (seqs.length > ASZ_FILES_MAX_SEQS) {
        return reply.code(400).send({ error: 'too_many_seqs', message: `at most ${ASZ_FILES_MAX_SEQS} seqs a request` });
      }
      const cfg = deps.config.current;
      const browserTakesGzip = takesGzip(req.headers['accept-encoding']);
      let upstream: AiConversationViewUpstream;
      try {
        upstream = await openAiConversationFiles(
          {
            queryUrl: cfg.oap.queryUrl,
            auth: cfg.oap.auth,
            timeoutMs: cfg.performance.aiConversation.viewTimeoutMs,
            signal: clientGone(reply),
          },
          {
            conversation,
            serviceName,
            instanceName,
            session,
            seqs,
            coldStage: !!req.coldStage,
            acceptEncoding: browserTakesGzip ? 'gzip' : 'identity',
          },
        );
      } catch (err) {
        if (err instanceof AiConversationViewTimeout) {
          return reply.code(504).send({ error: 'oap_timeout', message: err.message });
        }
        if (err instanceof Error && err.name === 'AbortError') {
          return reply.code(499).send();
        }
        return reply
          .code(502)
          .send({ error: 'oap_unreachable', message: err instanceof Error ? err.message : String(err) });
      }
      // Both a problem document and the files themselves go as they came; the browser reads the
      // framing, and the BFF adds nothing to it.
      reply.code(upstream.status);
      for (const [name, value] of Object.entries(passthroughHeaders(upstream.headers))) {
        reply.header(name, value);
      }
      return reply.send(upstream.body);
    },
  );
}
