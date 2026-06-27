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
 * Zipkin trace proxy.
 *
 * OAP serves the Zipkin v2 REST API via `ZipkinQueryHandler` (separate
 * from the GraphQL `queryBasicTraces` flow). Layers whose data path
 * ships Zipkin-format spans (Envoy ALS, k8s rover) need the operator
 * to query those endpoints instead of OAP's native trace store.
 *
 * These routes thin-proxy to:
 *   GET /api/v2/services
 *   GET /api/v2/spans?serviceName=
 *   GET /api/v2/remoteServices?serviceName=
 *   GET /api/v2/traces?...
 *   GET /api/v2/trace/{traceId}
 *
 * Base URL is `cfg.oap.zipkinUrl` (default `http://127.0.0.1:9412/zipkin`).
 * Auth piggy-backs on the same `cfg.oap.auth` block the GraphQL client
 * uses, since the demo OAP gates Zipkin behind the same basic-auth.
 *
 * No GraphQL — we forward fetch directly. The response bodies are
 * standard Zipkin v2 JSON (arrays of arrays of spans for the list
 * endpoint, array of spans for the detail).
 */

import type {
  FetchLike,
  ZipkinSpan,
  ZipkinTraceListResponse,
  ZipkinTraceListRow,
  ZipkinTraceDetailResponse,
} from '@skywalking-horizon-ui/api-client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import { basicAuthHeader } from '../../client/graphql.js';

export interface ZipkinRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
}

/** Derive a one-row summary (`ZipkinTraceListRow`) from a trace's
 *  full span array. Zipkin's REST list endpoint returns the full span
 *  set per trace — the SPA's list view doesn't need every span, just
 *  the root + counts. */
function summariseTrace(spans: ZipkinSpan[]): ZipkinTraceListRow {
  // Root = span with no parent. Falls back to the earliest span when
  // every span has a parentId (broken trace).
  const root = spans.find((s) => !s.parentId)
    ?? spans.slice().sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))[0]
    ?? null;
  const errorCount = spans.reduce((n, s) => {
    const t = s.tags ?? {};
    if (t['error'] != null || t['http.status_code']?.startsWith('5') || t['otel.status_code'] === 'ERROR') {
      return n + 1;
    }
    return n;
  }, 0);
  return {
    traceId: root?.traceId ?? (spans[0]?.traceId ?? ''),
    rootName: root?.name ?? null,
    rootService: root?.localEndpoint?.serviceName ?? null,
    timestamp: root?.timestamp ?? null,
    duration: root?.duration ?? null,
    spanCount: spans.length,
    errorCount,
  };
}

async function zipkinFetch(
  cfg: ZipkinRouteDeps['config']['current'],
  fetchFn: FetchLike | undefined,
  path: string,
  query?: Record<string, string | number | undefined>,
): Promise<{ status: number; body: unknown }> {
  const f = fetchFn ?? globalThis.fetch.bind(globalThis);
  const base = cfg.oap.zipkinUrl.replace(/\/$/, '');
  const url = new URL(base + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.oap.timeoutMs);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (cfg.oap.auth) {
    headers.authorization = basicAuthHeader(cfg.oap.auth.username, cfg.oap.auth.password);
  }
  try {
    const res = await f(url.toString(), {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export function registerZipkinRoutes(app: FastifyInstance, deps: ZipkinRouteDeps): void {
  const auth = requireAuth(deps);

  app.get('/api/zipkin/services', { preHandler: auth }, async (_req, reply) => {
    try {
      const { status, body } = await zipkinFetch(deps.config.current, deps.fetch, '/api/v2/services');
      return reply.code(status).send(body);
    } catch (err) {
      return reply
        .code(200)
        .send({ services: [], reachable: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/zipkin/spans', { preHandler: auth }, async (req, reply) => {
    const q = req.query as { serviceName?: string };
    if (!q.serviceName) return reply.code(400).send({ error: 'missing_serviceName' });
    try {
      const { status, body } = await zipkinFetch(deps.config.current, deps.fetch, '/api/v2/spans', {
        serviceName: q.serviceName,
      });
      return reply.code(status).send(body);
    } catch (err) {
      return reply.code(200).send({ spans: [], reachable: false, error: String(err) });
    }
  });

  app.get('/api/zipkin/remote-services', { preHandler: auth }, async (req, reply) => {
    const q = req.query as { serviceName?: string };
    if (!q.serviceName) return reply.code(400).send({ error: 'missing_serviceName' });
    try {
      const { status, body } = await zipkinFetch(
        deps.config.current,
        deps.fetch,
        '/api/v2/remoteServices',
        { serviceName: q.serviceName },
      );
      return reply.code(status).send(body);
    } catch (err) {
      return reply.code(200).send({ remoteServices: [], reachable: false, error: String(err) });
    }
  });

  app.get('/api/zipkin/traces', { preHandler: auth }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = q.limit ? Math.max(1, Math.min(200, Number(q.limit))) : 30;
    const lookback = q.lookback ? Number(q.lookback) : 30 * 60_000; // 30 min default (ms)
    const endTs = q.endTs ? Number(q.endTs) : Date.now();
    try {
      const { status, body } = await zipkinFetch(
        deps.config.current,
        deps.fetch,
        '/api/v2/traces',
        {
          serviceName: q.serviceName,
          remoteServiceName: q.remoteServiceName,
          spanName: q.spanName,
          annotationQuery: q.annotationQuery,
          minDuration: q.minDuration,
          maxDuration: q.maxDuration,
          endTs,
          lookback,
          limit,
        },
      );
      // Zipkin's `/traces` returns `Array<Array<Span>>` — one inner
      // array per trace. Compress each into a `ZipkinTraceListRow`
      // (root summary + counts) so the SPA's list view doesn't have
      // to ship the full span tree just to render rows. The detail
      // route serves the full spans for the popout.
      const raw = Array.isArray(body) ? (body as ZipkinSpan[][]) : [];
      const summaries: ZipkinTraceListRow[] = raw.map(summariseTrace);
      const response: ZipkinTraceListResponse = {
        source: 'zipkin',
        traces: summaries,
        reachable: true,
      };
      return reply.code(status).send(response);
    } catch (err) {
      const response: ZipkinTraceListResponse = {
        source: 'zipkin',
        traces: [],
        reachable: false,
        error: err instanceof Error ? err.message : String(err),
      };
      return reply.code(200).send(response);
    }
  });

  app.get<{ Params: { traceId: string } }>(
    '/api/zipkin/trace/:traceId',
    { preHandler: auth },
    async (req, reply) => {
      const { traceId } = req.params;
      if (!traceId || !/^[0-9a-fA-F]+$/.test(traceId)) {
        return reply.code(400).send({ error: 'invalid_trace_id' });
      }
      try {
        const { status, body } = await zipkinFetch(
          deps.config.current,
          deps.fetch,
          `/api/v2/trace/${encodeURIComponent(traceId)}`,
        );
        const detail: ZipkinTraceDetailResponse = {
          source: 'zipkin',
          traceId,
          spans: Array.isArray(body) ? (body as ZipkinSpan[]) : [],
          reachable: status !== 404,
          ...(status === 404 ? { error: 'trace not found' } : {}),
        };
        return reply.code(status === 404 ? 200 : status).send(detail);
      } catch (err) {
        const detail: ZipkinTraceDetailResponse = {
          source: 'zipkin',
          traceId,
          spans: [],
          reachable: false,
          error: err instanceof Error ? err.message : String(err),
        };
        return reply.code(200).send(detail);
      }
    },
  );

  // Proxies for `/api/v2/autocompleteKeys` + `/api/v2/autocompleteValues`.
  // OAP keeps a pre-configured set of "autocomplete keys" (operator
  // adds to a config list) and indexes their distinct values from
  // recent Zipkin spans. The Zipkin trace UI uses these to power
  // typeahead on the `annotationQuery` field — same UX Zipkin Lens
  // ships, but routed through Horizon so the basic-auth handshake +
  // CORS stay invisible to the SPA.
  app.get('/api/zipkin/autocomplete/keys', { preHandler: auth }, async (_req, reply) => {
    try {
      const { status, body } = await zipkinFetch(
        deps.config.current,
        deps.fetch,
        '/api/v2/autocompleteKeys',
      );
      return reply.code(status).send(body);
    } catch (err) {
      return reply.code(200).send({ keys: [], reachable: false, error: String(err) });
    }
  });
  app.get('/api/zipkin/autocomplete/values', { preHandler: auth }, async (req, reply) => {
    const q = req.query as { key?: string };
    if (!q.key) return reply.code(400).send({ error: 'missing_key' });
    try {
      const { status, body } = await zipkinFetch(
        deps.config.current,
        deps.fetch,
        '/api/v2/autocompleteValues',
        { key: q.key },
      );
      return reply.code(status).send(body);
    } catch (err) {
      return reply.code(200).send({ values: [], reachable: false, error: String(err) });
    }
  });

  app.get('/api/zipkin/traceMany', { preHandler: auth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as { traceIds?: string };
    const ids = (q.traceIds ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return reply.code(400).send({ error: 'missing_traceIds' });
    try {
      const { status, body } = await zipkinFetch(
        deps.config.current,
        deps.fetch,
        '/api/v2/traceMany',
        { traceIds: ids.join(',') },
      );
      return reply.code(status).send({
        traces: Array.isArray(body) ? body : [],
        reachable: true,
      });
    } catch (err) {
      return reply.code(200).send({
        traces: [],
        reachable: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
