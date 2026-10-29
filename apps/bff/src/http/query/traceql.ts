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
 * TraceQL (Tempo API) query routes, one datasource per `:ds` segment.
 *
 * Thin by design: each route parses the request, fires one backend query and
 * shapes the reply. There is no `logic/` step because there is nothing
 * stateful or shared to own — except the availability probe, which lives in
 * `logic/traceql/`.
 *
 * Two answers are deliberately NOT failures:
 *   - a 404 from a by-id read means the trace is not there;
 *   - a 400 carries OAP's own message for an expression it refused, which the
 *     editor shows verbatim rather than translating.
 * Everything else reports the source as unreachable, because a wrong port, a
 * wrong context path and a datasource nobody enabled all fail alike and differ
 * only in the fix.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { normalizeZipkinTraceId, serviceFilterOf, serviceLayerOf } from '@skywalking-horizon-ui/api-client';
import type {
  FetchLike,
  TraceQLDatasource,
  TraceStore,
  TraceQLTraceDetailResponse,
  TraceQLTraceListResponse,
  TraceQLTagsResponse,
  TraceQLTagValuesResponse,
  TracesConfig,
  UITemplateClient,
} from '@skywalking-horizon-ui/api-client';
import type { AuthDeps } from '../../user/middleware.js';
import { requireAuth } from '../../user/middleware.js';
import {
  buildTraceQLOpts,
  traceqlSearch,
  traceqlTagValues,
  traceqlTags,
  traceqlTraceById,
  TraceQLHttpError,
} from '../../client/traceql.js';
import { traceqlSourceStatus, traceqlSources } from '../../logic/traceql/availability.js';
import { fillTraceStatuses } from '../../logic/traceql/status.js';
import { resolveEffectiveLayer } from '../../logic/layers/effective.js';
import { parsePreviewTraces } from '../../logic/layers/preview.js';
import { sessionHasVerb } from '../../rbac/policy.js';
import { clientGone } from '../client-gone.js';

export interface TraceQLRouteDeps extends AuthDeps {
  fetch?: FetchLike;
  /** OAP UI-template client — the layer's in-use config, for the per-store
   *  service filter the picker applies. */
  uiTemplateClient?: () => UITemplateClient;
}

function datasourceOf(raw: string): TraceQLDatasource | null {
  return raw === 'native' || raw === 'zipkin' || raw === 'otlp' ? raw : null;
}

/** The window every query carries, in milliseconds. A by-id lookup may omit it
 *  — that is the "no time range" choice, which this API answers by searching
 *  its whole history. */
function windowOf(q: Record<string, string | undefined>): { startMs: number; endMs: number } | null {
  const startMs = Number(q.startMs);
  const endMs = Number(q.endMs);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return { startMs, endMs };
}

/** OAP refuses a few expressions outright — a duration it cannot parse, for
 *  one — with `{"error":"…"}`. The MESSAGE is what the editor shows, so the
 *  envelope is unwrapped here; a body that is not that shape passes through
 *  unchanged rather than being guessed at. */
function refusedExpression(e: unknown): string | null {
  if (!(e instanceof TraceQLHttpError) || e.status !== 400) return null;
  const body = e.body || e.message;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') {
      return (parsed as { error: string }).error;
    }
  } catch {
    // Not JSON — the body is the message.
  }
  return body;
}

function failureText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The store a datasource fills for a layer — how a `:ds` route reaches the
 *  per-store template settings. */
const STORE_OF: Readonly<Record<TraceQLDatasource, TraceStore>> = {
  native: 'traceql-native',
  zipkin: 'traceql-zipkin',
  otlp: 'traceql-otlp',
};

function storeOf(ds: TraceQLDatasource): TraceStore {
  return STORE_OF[ds];
}

/**
 * The `traces` block that narrows the service picker of the layer that asked.
 *
 * The Tempo API's service-name values are every service of the underlying
 * store, so a layer owning a subset of them says which by pattern, and on the
 * OTLP store by layer too, which OAP's service catalog answers. Applied to the
 * PICKER alone — never to result rows, which legitimately cross services.
 *
 * @returns `blocked` when the layer's configuration cannot be read, whose picker
 * must be emptied; else the block, `null` when nothing narrows it
 */
async function layerTracesOf(
  deps: TraceQLRouteDeps,
  req: FastifyRequest,
  layerKey: string | undefined,
  previewConfig?: string,
): Promise<{ blocked: boolean; traces: TracesConfig | null }> {
  if (!layerKey || !/^[a-z0-9_]+$/i.test(layerKey)) return { blocked: false, traces: null };
  // In preview the DRAFT is the configuration — an admin editing the filter
  // has to see what it does before publishing. A pattern off the request is
  // code someone else's request runs on this event loop, so it is taken only
  // from a caller who may edit templates, and only in a bounded form.
  const preview = req.session && sessionHasVerb(deps.config.current, req.session, 'layer-template:write')
    ? parsePreviewTraces(previewConfig)
    : null;
  if (preview) return { blocked: false, traces: preview };
  const eff = await resolveEffectiveLayer(deps.uiTemplateClient, layerKey);
  // A layer whose configuration cannot be read must not have its picker
  // WIDENED: serving every service of the store is the one answer that looks
  // like more access rather than less.
  if (eff.blocked) return { blocked: true, traces: null };
  return { blocked: false, traces: eff.template?.traces ?? null };
}

/**
 * The picker's expression narrowed to a layer: the caller's own single spanset
 * with the layer's condition added to it, since OAP takes one `{...}` only.
 * Added last: OAP keeps the last condition on an attribute, so a layer the
 * caller named cannot replace the template's.
 *
 * @returns null when the caller's expression is not one spanset, which cannot
 * be narrowed and so must not be sent widened
 */
function withServiceLayer(q: string | undefined, layer: string): string | null {
  const condition = `resource.service.layer="${layer}"`;
  const t = (q ?? '').trim();
  if (!t) return `{${condition}}`;
  if (!t.startsWith('{') || closingBrace(t) !== t.length - 1) return null;
  const inner = t.slice(1, -1).trim();
  return inner ? `{${inner} && ${condition}}` : `{${condition}}`;
}

/** Where the brace opening `q` closes, skipping string literals; -1 if it never does. A literal is
 *  OAP's only kind, double-quoted with backslash escapes (its TraceQLLexer `STRING_LITERAL`). */
function closingBrace(q: string): number {
  let depth = 0;
  let inLiteral = false;
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (inLiteral) {
      if (c === '\\') i++;
      else if (c === '"') inLiteral = false;
    } else if (c === '"') {
      inLiteral = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}' && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/** The tags whose values are service names on every store, narrowed by the layer's settings: OAP resolves the
 *  unscoped `.service.name` and `.service` to the resource scope first. The plain `service.name` is one on the OTLP
 *  store only, whose catalog answers it too (`OTLPTraceQLApiHandler.SERVICE_NAME_TAGS`); elsewhere it is a tag. */
const SERVICE_TAGS = new Set(['resource.service.name', 'resource.service', '.service.name', '.service']);

/** Backtracking cost grows with the SUBJECT as well as the pattern, and a
 *  service name is nowhere near this long. */
const MAX_MATCHED_LENGTH = 256;

function filterByPattern(values: string[], re: RegExp): string[] {
  // `test` on a /g|y/ regex advances lastIndex, so one shared instance would
  // skip every other match. Match fresh per value instead.
  const safe = new RegExp(re.source, re.flags.replace(/[gy]/g, ''));
  return values.filter((v) => safe.test(v.slice(0, MAX_MATCHED_LENGTH)));
}

export function registerTraceQLRoutes(app: FastifyInstance, deps: TraceQLRouteDeps): void {
  const auth = requireAuth(deps);

  app.get('/api/traceql/sources', { preHandler: auth }, async (_req, reply) => {
    return reply.send(await traceqlSources(deps.config.current, deps.fetch, clientGone(reply)));
  });

  app.get<{ Params: { ds: string } }>(
    '/api/traceql/:ds/search',
    { preHandler: auth },
    async (req: FastifyRequest<{ Params: { ds: string } }>, reply: FastifyReply) => {
      const ds = datasourceOf(req.params.ds);
      if (!ds) return reply.code(400).send({ error: 'unknown_datasource' });
      const q = req.query as Record<string, string | undefined>;
      const window = windowOf(q);
      if (!window) return reply.code(400).send({ error: 'invalid_window' });

      const opts = buildTraceQLOpts(deps.config.current, ds, deps.fetch, clientGone(reply));
      if (!opts) {
        return reply.send({ ds, traces: [], capped: false, reachable: false } satisfies TraceQLTraceListResponse);
      }
      const maxRows = deps.config.current.performance.limits.maxPageSize.traces;
      const limit = Math.max(1, Math.min(maxRows, Number(q.limit) || 20));
      try {
        const found = await traceqlSearch(opts, { q: q.q, ...window, limit });
        // The search response cannot say whether a trace failed, so a second
        // pass asks the backend for the failures by id.
        const traces = await fillTraceStatuses(opts, { q: q.q, ...window, limit }, found);
        // No paging here: `pageNum` is pinned upstream and `limit` is the only
        // control, so a full page is the only "there may be more" signal there is.
        return reply.send({
          ds,
          traces,
          capped: traces.length >= limit,
          reachable: true,
        } satisfies TraceQLTraceListResponse);
      } catch (e) {
        const refused = refusedExpression(e);
        return reply.send({
          ds,
          traces: [],
          capped: false,
          reachable: refused !== null,
          error: refused ?? failureText(e),
        } satisfies TraceQLTraceListResponse);
      }
    },
  );

  app.get<{ Params: { ds: string; traceId: string } }>(
    '/api/traceql/:ds/trace/:traceId',
    { preHandler: auth },
    async (req: FastifyRequest<{ Params: { ds: string; traceId: string } }>, reply: FastifyReply) => {
      const ds = datasourceOf(req.params.ds);
      if (!ds) return reply.code(400).send({ error: 'unknown_datasource' });
      const traceId = req.params.traceId;
      const q = req.query as Record<string, string | undefined>;
      const window = windowOf(q);

      const opts = buildTraceQLOpts(deps.config.current, ds, deps.fetch, clientGone(reply));
      if (!opts) {
        return reply.send({
          ds, traceId, spans: [], reachable: false, notFound: false, configured: false,
        } satisfies TraceQLTraceDetailResponse);
      }
      // Not an id Zipkin can hold, so the Zipkin datasource holds no trace with
      // it: an answer, not a failure. OAP is not asked — its 400 would not say
      // which parameter it refused.
      if (ds === 'zipkin' && normalizeZipkinTraceId(traceId) === null) {
        return reply.send({
          ds, traceId, spans: [], reachable: true, notFound: true, invalidId: true,
        } satisfies TraceQLTraceDetailResponse);
      }
      try {
        const detail = await traceqlTraceById(opts, traceId, window ?? undefined);
        // OAP answers 404 for a trace it has no record of AND on the path of a
        // datasource it does not enable; only the build-info probe tells them
        // apart, and "no such trace" would send the operator looking for data.
        if (detail === null) {
          const status = await traceqlSourceStatus(deps.config.current, ds, deps.fetch, clientGone(reply));
          if (status.served === false) {
            return reply.send({
              ds, traceId, spans: [], reachable: false, notFound: false, served: false,
            } satisfies TraceQLTraceDetailResponse);
          }
        }
        return reply.send({
          ds,
          traceId: detail?.traceId ?? traceId,
          spans: detail?.spans ?? [],
          reachable: true,
          notFound: detail === null,
        } satisfies TraceQLTraceDetailResponse);
      } catch (e) {
        return reply.send({
          ds, traceId, spans: [], reachable: false, notFound: false, error: failureText(e),
        } satisfies TraceQLTraceDetailResponse);
      }
    },
  );

  app.get<{ Params: { ds: string } }>(
    '/api/traceql/:ds/tags',
    { preHandler: auth },
    async (req: FastifyRequest<{ Params: { ds: string } }>, reply: FastifyReply) => {
      const ds = datasourceOf(req.params.ds);
      if (!ds) return reply.code(400).send({ error: 'unknown_datasource' });
      const window = windowOf(req.query as Record<string, string | undefined>);
      if (!window) return reply.code(400).send({ error: 'invalid_window' });

      const opts = buildTraceQLOpts(deps.config.current, ds, deps.fetch, clientGone(reply));
      if (!opts) return reply.send({ scopes: [] } satisfies TraceQLTagsResponse);
      try {
        return reply.send({ scopes: await traceqlTags(opts, window) } satisfies TraceQLTagsResponse);
      } catch {
        // Autocomplete is an aid, not an answer: a failed lookup leaves the
        // field as plain text rather than blocking the query behind it.
        return reply.send({ scopes: [] } satisfies TraceQLTagsResponse);
      }
    },
  );

  app.get<{ Params: { ds: string } }>(
    '/api/traceql/:ds/tag-values',
    { preHandler: auth },
    async (req: FastifyRequest<{ Params: { ds: string } }>, reply: FastifyReply) => {
      const ds = datasourceOf(req.params.ds);
      if (!ds) return reply.code(400).send({ error: 'unknown_datasource' });
      const q = req.query as Record<string, string | undefined>;
      const window = windowOf(q);
      if (!window || !q.tag) return reply.code(400).send({ error: 'invalid_request' });

      const opts = buildTraceQLOpts(deps.config.current, ds, deps.fetch, clientGone(reply));
      if (!opts) return reply.send({ values: [] } satisfies TraceQLTagValuesResponse);
      try {
        const serviceTag = SERVICE_TAGS.has(q.tag) || (q.tag === 'service.name' && storeOf(ds) === 'traceql-otlp');
        const narrowing = serviceTag ? await layerTracesOf(deps, req, q.layer, q.previewConfig) : null;
        if (narrowing?.blocked) return reply.send({ values: [] } satisfies TraceQLTagValuesResponse);
        const layer = narrowing ? serviceLayerOf(narrowing.traces, storeOf(ds)) : null;
        const expr = layer ? withServiceLayer(q.q, layer) : q.q;
        if (expr === null) return reply.send({ values: [] } satisfies TraceQLTagValuesResponse);
        const values = await traceqlTagValues(opts, q.tag, window, expr);
        const re = narrowing ? serviceFilterOf(narrowing.traces, storeOf(ds)) : null;
        return reply.send({ values: re ? filterByPattern(values, re) : values } satisfies TraceQLTagValuesResponse);
      } catch {
        return reply.send({ values: [] } satisfies TraceQLTagValuesResponse);
      }
    },
  );
}
