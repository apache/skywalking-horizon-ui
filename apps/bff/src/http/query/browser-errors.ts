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
 * `POST /api/layer/:key/browser-errors`
 *
 * Wraps OAP's `queryBrowserErrorLogs(BrowserErrorLogQueryCondition)` for
 * the BROWSER-layer "Browser Errors" tab (#6784). Body shape is
 * `BrowserErrorsQueryRequest` from `@skywalking-horizon-ui/api-client`.
 *
 * Like the logs feed, we accept a `service` NAME on the body and resolve
 * it to an OAP id server-side, query at SECOND precision (error logs are
 * event-style — MINUTE rounding would drop the most recent rows), and the
 * source-map resolution is a separate concern (see admin/source-maps.ts).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  BrowserErrorRow,
  BrowserErrorsQueryRequest,
  BrowserErrorsResponse,
  FetchLike,
} from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import { graphqlPost, buildOapOpts, type GraphqlOptions } from '../../client/graphql.js';
import { withColdStage } from '../../util/duration.js';
import { fmtSecond, getServerOffsetMinutes } from '../../util/window.js';

export interface BrowserErrorsRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
}

const DEFAULT_WINDOW_MIN = 30;
/** OAP feeds `paging.pageSize` straight to storage as a LIMIT. The cap
 *  is `performance.limits.maxPageSize.browserLogs` (default 100);
 *  mirror that server-side so the cap holds against direct API callers. */
function clampPageSize(requested: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(requested as number) || (requested as number) < 1) return fallback;
  return Math.min(max, Math.round(requested as number));
}

function defaultWindow(
  offsetMinutes: number,
  minutes?: number,
  explicit?: { startMs?: number; endMs?: number },
): { start: string; end: string } {
  // Absolute range: the UI sends epoch MS (TZ-unambiguous) and the BFF
  // renders them in OAP-server-local using the OAP offset — same path as
  // the rolling window. (Sending bare browser-local strings would be read
  // by OAP as OAP-local and miss the data by the browser↔OAP TZ delta.)
  if (
    typeof explicit?.startMs === 'number' &&
    typeof explicit.endMs === 'number' &&
    explicit.startMs < explicit.endMs
  ) {
    return { start: fmtSecond(explicit.startMs, offsetMinutes), end: fmtSecond(explicit.endMs, offsetMinutes) };
  }
  const m =
    Number.isFinite(minutes) && (minutes as number) > 0
      ? Math.min(60 * 24 * 7, Math.round(minutes as number))
      : DEFAULT_WINDOW_MIN;
  const endMs = Date.now();
  const startMs = endMs - m * 60_000;
  return { start: fmtSecond(startMs, offsetMinutes), end: fmtSecond(endMs, offsetMinutes) };
}

const LIST_SERVICES_FOR_RESOLVE = /* GraphQL */ `
  query ListServicesForBrowserErrors($layer: String!) {
    services: listServices(layer: $layer) {
      id
      name
    }
  }
`;

const QUERY_BROWSER_ERRORS = /* GraphQL */ `
  query QueryBrowserErrorLogs($condition: BrowserErrorLogQueryCondition) {
    data: queryBrowserErrorLogs(condition: $condition) {
      logs {
        service
        serviceVersion
        time
        pagePath
        category
        grade
        message
        line
        col
        stack
        errorUrl
        firstReportedError
      }
    }
  }
`;

interface OapBrowserErrorRow {
  service: string;
  serviceVersion: string;
  time: number;
  pagePath: string;
  category: BrowserErrorRow['category'];
  grade?: string | null;
  message?: string | null;
  line?: number | null;
  col?: number | null;
  stack?: string | null;
  errorUrl?: string | null;
  firstReportedError: boolean;
}

const OAP_SERVICE_ID_RE = /^[A-Za-z0-9+/=]+\.\d+$/;
async function resolveServiceId(
  opts: GraphqlOptions,
  layer: string,
  serviceArg: string,
): Promise<string | null> {
  if (!serviceArg) return null;
  if (OAP_SERVICE_ID_RE.test(serviceArg)) return serviceArg;
  const data = await graphqlPost<{ services: Array<{ id: string; name: string }> }>(
    opts,
    LIST_SERVICES_FOR_RESOLVE,
    { layer: layer.toUpperCase() },
  );
  return (
    data.services.find((s) => s.name === serviceArg)?.id ??
    data.services.find((s) => s.id === serviceArg)?.id ??
    null
  );
}

interface Body extends BrowserErrorsQueryRequest {
  service?: string;
}

export function registerBrowserErrorsRoute(app: FastifyInstance, deps: BrowserErrorsRouteDeps): void {
  const auth = requireAuth(deps);
  app.post(
    '/api/layer/:key/browser-errors',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const layerKey = params.key;
      if (!layerKey || !/^[a-z0-9_]+$/i.test(layerKey)) {
        return reply.code(400).send({ error: 'invalid_layer_key' });
      }
      const body = (req.body ?? {}) as Body;
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      const offset = await getServerOffsetMinutes(deps.config, deps.fetch);
      const window = defaultWindow(offset, body.windowMinutes, {
        startMs: body.startMs,
        endMs: body.endMs,
      });

      let serviceId = body.serviceId ?? null;
      if (!serviceId && body.service) {
        try {
          serviceId = await resolveServiceId(opts, layerKey, body.service);
        } catch (err) {
          return reply.send({
            generatedAt: Date.now(),
            query: body,
            total: 0,
            logs: [],
            reachable: false,
            error: err instanceof Error ? err.message : String(err),
          } satisfies BrowserErrorsResponse);
        }
      }

      const condition = {
        ...(serviceId ? { serviceId } : {}),
        ...(body.serviceVersionId ? { serviceVersionId: body.serviceVersionId } : {}),
        ...(body.pagePathId ? { pagePathId: body.pagePathId } : {}),
        // `ALL` is OAP's "no filter" sentinel — omit it so storage doesn't
        // try to match a literal category named ALL.
        ...(body.category && body.category !== 'ALL' ? { category: body.category } : {}),
        queryDuration: withColdStage(req, { start: window.start, end: window.end, step: 'SECOND' }),
        paging: {
          pageNum: Math.max(1, Math.round(body.page ?? 1)),
          pageSize: clampPageSize(body.pageSize, 50, deps.config.current.performance.limits.maxPageSize.browserLogs),
        },
      };

      try {
        const env = await graphqlPost<{ data: { logs: OapBrowserErrorRow[] } }>(
          opts,
          QUERY_BROWSER_ERRORS,
          { condition },
        );
        const logs: BrowserErrorRow[] = (env.data?.logs ?? []).map((r) => ({
          service: r.service,
          serviceVersion: r.serviceVersion,
          time: r.time,
          pagePath: r.pagePath,
          category: r.category,
          grade: r.grade ?? null,
          message: r.message ?? null,
          line: r.line ?? null,
          col: r.col ?? null,
          stack: r.stack ?? null,
          errorUrl: r.errorUrl ?? null,
          firstReportedError: r.firstReportedError,
        }));
        // Normalise to newest-first. OAP's BrowserErrorLog DAO sorts DESC,
        // but BanyanDB returns it per time-segment (each segment DESC, the
        // segments concatenated oldest-first), so a multi-segment result is
        // not globally ordered. Sort by the records' own `time` to guarantee
        // a strictly newest-first stream.
        logs.sort((a, b) => b.time - a.time);
        return reply.send({
          generatedAt: Date.now(),
          query: body,
          total: logs.length,
          logs,
          reachable: true,
        } satisfies BrowserErrorsResponse);
      } catch (err) {
        return reply.send({
          generatedAt: Date.now(),
          query: body,
          total: 0,
          logs: [],
          reachable: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies BrowserErrorsResponse);
      }
    },
  );
}
