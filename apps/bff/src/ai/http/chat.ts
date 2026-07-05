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
 * AI assistant HTTP surface.
 *   GET  /api/ai/config — readiness + starter prompts (the launcher
 *                          gates on `ready`; the panel renders `starters`).
 *   POST /api/ai/chat   — Server-Sent Events stream of the agent's answer
 *                          (token / thinking / tool / figure / error / done).
 * The chat route hijacks the reply for a long-lived SSE connection; it is the
 * only streaming endpoint in the BFF.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FetchLike, UITemplateClient } from '@skywalking-horizon-ui/api-client';
import { z } from 'zod';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import { sessionHasVerb } from '../../rbac/policy.js';
import { buildOapOpts } from '../../client/graphql.js';
import {
  defaultMinuteWindow,
  getServerOffsetMinutes,
  windowFromRange,
} from '../../util/window.js';
import {
  buildChatModel,
  resolveCredentials,
  aiEffectivelyReady,
  AiConfigError,
} from '../provider/model.js';
import { resolveSystemPrompt, resolveStarters } from '../agent/prompt.js';
import { runAiChat } from '../agent/agent.js';
import { createFigureBuffer } from '../figure-buffer.js';
import type { AiRequestContext } from '../context.js';
import type { SseEvent } from '../types.js';

export interface AiChatRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
  uiTemplateClient?: () => UITemplateClient;
}

const chatBodySchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))
    .min(1),
  startMs: z.number().optional(),
  endMs: z.number().optional(),
  step: z.enum(['MINUTE', 'HOUR', 'DAY']).optional(),
});

const DEFAULT_WINDOW_MIN = 60;

export function registerAiRoutes(app: FastifyInstance, deps: AiChatRouteDeps): void {
  const auth = requireAuth(deps);

  app.get('/api/ai/config', { preHandler: auth }, async (_req, reply) => {
    const ai = deps.config.current.ai;
    return reply.send({
      enabled: ai.enabled,
      ready: aiEffectivelyReady(ai),
      provider: ai.provider,
      starters: resolveStarters(ai),
    });
  });

  app.post('/api/ai/chat', { preHandler: auth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const cfg = deps.config.current;
    const ai = cfg.ai;
    if (!ai.enabled) return reply.code(503).send({ error: 'ai_disabled' });

    const parsed = chatBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.flatten() });
    }

    // Build the model up front so a config problem is a clean 503, not a
    // half-open SSE stream.
    let model;
    try {
      model = buildChatModel(resolveCredentials(ai));
    } catch (err) {
      if (err instanceof AiConfigError) {
        return reply.code(503).send({ error: 'ai_unconfigured', detail: err.message });
      }
      throw err;
    }

    const roles = req.session?.roles ?? [];
    const offset = await getServerOffsetMinutes(deps.config, deps.fetch);
    const nowMs = Date.now();
    const endMs = parsed.data.endMs ?? nowMs;
    const startMs = parsed.data.startMs ?? endMs - DEFAULT_WINDOW_MIN * 60_000;
    const step = parsed.data.step ?? 'MINUTE';
    const window =
      windowFromRange(step, startMs, endMs, offset) ?? defaultMinuteWindow(offset, DEFAULT_WINDOW_MIN);

    // ── Hand off to a long-lived SSE stream ──
    reply.hijack();
    const raw = reply.raw;
    const setCookie = reply.getHeader('set-cookie');
    raw.writeHead(200, {
      // Re-add what the bypassed onSend hook would set, plus the SSE headers.
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      ...(setCookie ? { 'Set-Cookie': setCookie } : {}),
    });

    // On a client disconnect the socket is `destroyed` (not `writableEnded`),
    // so guard writes on `raw.writable` + a `closed` flag, and swallow the
    // stream 'error' (EPIPE / ERR_STREAM_DESTROYED) that would otherwise be
    // unhandled and could crash the process.
    let closed = false;
    const send = (ev: SseEvent): void => {
      if (!closed && raw.writable) raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    // Mirror the global error handler: never stream a raw internal/upstream
    // exception message (it can carry the provider endpoint or response snippets)
    // to the client in production — log it server-side and return a generic line
    // with the request id for correlation; dev keeps the raw text for debugging.
    const isDev = process.env.NODE_ENV === 'development';
    const clientError = (rawMsg: string): string =>
      isDev ? rawMsg : `The assistant hit an internal error (ref: ${req.id}).`;
    const ping = setInterval(() => {
      if (!closed && raw.writable) raw.write(': ping\n\n');
    }, 15_000);
    ping.unref();
    const ac = new AbortController();
    raw.on('error', () => {
      closed = true;
    });
    raw.on('close', () => {
      closed = true;
      ac.abort();
    });

    const {
      emitFigure,
      emitSubPage,
      emitProposal,
      emitPodLogs,
      emitHierarchy,
      emitTopology,
      emitDeployment,
      emitInstanceTopology,
      emitEndpointDependency,
      emitTraces,
      emitZipkinTraces,
      emitLogs,
      emitBrowserErrors,
      flushFigures,
    } = createFigureBuffer(send);
    const ctx: AiRequestContext = {
      config: deps.config,
      fetch: deps.fetch,
      uiTemplateClient: deps.uiTemplateClient,
      opts: buildOapOpts(cfg, deps.fetch),
      window,
      range: { startMs, endMs, step },
      bulkSize: cfg.performance.bulk.dashboard.bulkSize,
      hasVerb: (verb) => sessionHasVerb(cfg, roles, verb),
      emitFigure,
      emitSubPage,
      emitProposal,
      emitPodLogs,
      emitHierarchy,
      emitTopology,
      emitDeployment,
      emitInstanceTopology,
      emitEndpointDependency,
      emitTraces,
      emitZipkinTraces,
      emitLogs,
      emitBrowserErrors,
      flushFigures,
      emitTool: (name, status) => send({ type: 'tool', name, status }),
    };

    try {
      await runAiChat({
        ctx,
        model,
        systemPrompt: resolveSystemPrompt(ai),
        messages: parsed.data.messages,
        signal: ac.signal,
        onToken: (text) => send({ type: 'token', text }),
        onError: (message) => {
          req.log.error({ aiError: message }, 'ai chat stream error');
          send({ type: 'error', message: clientError(message) });
        },
      });
      flushFigures(); // emit any trailing group not closed by narration
      send({ type: 'done' });
    } catch (err) {
      req.log.error({ err }, 'ai chat route error');
      send({ type: 'error', message: clientError(err instanceof Error ? err.message : String(err)) });
    } finally {
      clearInterval(ping);
      if (!closed && raw.writable) raw.end();
    }
  });
}
