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
 * On-demand Pod logs — live-tail a Kubernetes pod's container logs,
 * fetched on demand straight from the K8s API through OAP and NEVER
 * persisted. Backs the per-layer "Pod Logs" tab.
 *
 *   GET  /api/layer/:key/pod-logs/containers?instance=<id>
 *        → list the pod's containers (OAP `listContainers`).
 *   POST /api/layer/:key/pod-logs
 *        → tail one container's logs over a rolling SECOND window
 *          (OAP `ondemandPodLogs`).
 *
 * Two OAP sharp edges this route smooths:
 *   - The feature is DISABLED by default on OAP (logs can leak secrets).
 *     When off — or when the pod can't be resolved (a stale instance id
 *     from a terminated pod) — OAP returns `errorReason` instead of data.
 *     We forward it verbatim so the UI can show a hint rather than an
 *     empty pane.
 *   - The window is SECOND-precision (live tail), formatted in OAP-local
 *     time via the cached server offset. `container` is REQUIRED by the
 *     OAP condition.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import { graphqlPost, buildOapOpts } from '../../client/graphql.js';
import { fmtSecond, getServerOffsetMinutes } from '../../util/window.js';

export interface PodLogRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
}

/** Default tail window in seconds when the client omits one. Matches
 *  the UI picker's smallest sensible "recent" slice. */
const DEFAULT_WINDOW_SEC = 60;
const MAX_WINDOW_SEC = 30 * 60; // cap at 30m — same ceiling as booster-ui

const QUERY_CONTAINERS = /* GraphQL */ `
  query ListContainers($condition: OndemandContainergQueryCondition) {
    containers: listContainers(condition: $condition) {
      errorReason
      containers
    }
  }
`;

const QUERY_POD_LOGS = /* GraphQL */ `
  query OndemandPodLogs($condition: OndemandLogQueryCondition) {
    logs: ondemandPodLogs(condition: $condition) {
      errorReason
      logs {
        content
        timestamp
      }
    }
  }
`;

interface OapContainers {
  errorReason?: string | null;
  containers?: string[] | null;
}
interface OapPodLogLine {
  content?: string | null;
  timestamp?: number | null;
}
interface OapPodLogs {
  errorReason?: string | null;
  logs?: OapPodLogLine[] | null;
}

const logBodySchema = z
  .object({
    serviceInstanceId: z.string().min(1),
    container: z.string().min(1),
    windowSeconds: z.number().int().positive().optional(),
    keywordsOfContent: z.array(z.string().min(1)).optional(),
    excludingKeywordsOfContent: z.array(z.string().min(1)).optional(),
  })
  .strict();

function validLayerKey(k: string): boolean {
  return /^[a-z0-9_]+$/i.test(k);
}

export function registerPodLogRoutes(app: FastifyInstance, deps: PodLogRouteDeps): void {
  const auth = requireAuth(deps);

  // ── List a pod's containers ──────────────────────────────────────
  app.get(
    '/api/layer/:key/pod-logs/containers',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { key } = req.params as { key: string };
      if (!validLayerKey(key)) return reply.code(400).send({ error: 'invalid_layer_key' });
      const instance = (req.query as { instance?: string }).instance ?? '';
      if (!instance) {
        return reply.send({ containers: [], errorReason: null, reachable: true, generatedAt: Date.now() });
      }
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      try {
        const data = await graphqlPost<{ containers: OapContainers }>(opts, QUERY_CONTAINERS, {
          condition: { serviceInstanceId: instance },
        });
        const c = data.containers ?? {};
        return reply.send({
          containers: c.containers ?? [],
          // OAP returns a non-empty errorReason when the pod can't be
          // found (stale instance) or the feature is disabled. The
          // empty-string case is normalized to null.
          errorReason: c.errorReason ? c.errorReason : null,
          reachable: true,
          generatedAt: Date.now(),
        });
      } catch (err) {
        return reply.send({
          containers: [],
          errorReason: null,
          reachable: false,
          error: err instanceof Error ? err.message : String(err),
          generatedAt: Date.now(),
        });
      }
    },
  );

  // ── Tail a container's logs ──────────────────────────────────────
  app.post(
    '/api/layer/:key/pod-logs',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { key } = req.params as { key: string };
      if (!validLayerKey(key)) return reply.code(400).send({ error: 'invalid_layer_key' });
      const parsed = logBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.flatten() });
      }
      const body = parsed.data;
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      const offset = await getServerOffsetMinutes(deps.config, deps.fetch);

      const windowSec = Math.min(
        MAX_WINDOW_SEC,
        body.windowSeconds && body.windowSeconds > 0 ? body.windowSeconds : DEFAULT_WINDOW_SEC,
      );
      const endMs = Date.now();
      const startMs = endMs - windowSec * 1000;
      const duration = {
        start: fmtSecond(startMs, offset),
        end: fmtSecond(endMs, offset),
        step: 'SECOND' as const,
      };

      const condition: Record<string, unknown> = {
        serviceInstanceId: body.serviceInstanceId,
        container: body.container,
        duration,
      };
      if (body.keywordsOfContent?.length) condition.keywordsOfContent = body.keywordsOfContent;
      if (body.excludingKeywordsOfContent?.length) {
        condition.excludingKeywordsOfContent = body.excludingKeywordsOfContent;
      }

      try {
        const data = await graphqlPost<{ logs: OapPodLogs }>(opts, QUERY_POD_LOGS, { condition });
        const l = data.logs ?? {};
        const lines = (l.logs ?? []).map((row) => ({
          content: row.content ?? '',
          // OAP returns timestamp in epoch SECONDS; surface milliseconds
          // so the UI's date handling matches every other timestamp it
          // renders (echarts / Date all expect ms).
          timestamp: typeof row.timestamp === 'number' ? row.timestamp * 1000 : null,
        }));
        return reply.send({
          lines,
          errorReason: l.errorReason ? l.errorReason : null,
          reachable: true,
          generatedAt: Date.now(),
          window: duration,
        });
      } catch (err) {
        return reply.send({
          lines: [],
          errorReason: null,
          reachable: false,
          error: err instanceof Error ? err.message : String(err),
          generatedAt: Date.now(),
          window: duration,
        });
      }
    },
  );
}
