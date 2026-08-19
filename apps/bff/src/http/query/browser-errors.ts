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
 * Like the logs feed, the body carries the picked service's identity
 * (`serviceId` + `service`) and the condition keys on the id. Queried at
 * SECOND precision (error logs are event-style — MINUTE rounding would drop
 * the most recent rows); source-map resolution is a separate concern (see
 * admin/source-maps.ts).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  BrowserErrorCategory,
  BrowserErrorRow,
  BrowserErrorsQueryRequest,
  BrowserErrorsResponse,
  FetchLike,
} from '@skywalking-horizon-ui/api-client';
import type { AuthDeps } from '../../user/middleware.js';
import { requireAuth } from '../../user/middleware.js';
import { buildOapOpts, type GraphqlOptions } from '../../client/graphql.js';
import { serviceScopeOf } from '../../logic/oap/service-scope.js';
import {
  readPage,
  type OapPaging,
  type PagedQuerySpec,
} from '../../logic/paging/read-page.js';
import { fmtSecond, getServerOffsetMinutes } from '../../util/window.js';

export interface BrowserErrorsRouteDeps extends AuthDeps {
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

const BROWSER_ERROR_ROW_SELECTION = `
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
        firstReportedError`;

/** OAP's `BrowserErrorLogs` type carries a single `logs` field — no total and
 *  no has-more, so paging facts come from the over-fetch seam. */
const BROWSER_ERROR_PAGE: PagedQuerySpec = {
  operationName: 'QueryBrowserErrorLogs',
  conditionType: 'BrowserErrorLogQueryCondition',
  field: 'queryBrowserErrorLogs',
  rowsField: 'logs',
  rowsSelection: BROWSER_ERROR_ROW_SELECTION,
  probeSelection: 'time',
};

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

/** OAP id filters the browser-error query scopes by — all PRE-RESOLVED by
 *  the caller (no `listServices(layer)` lookup). The per-layer route
 *  resolves a service name first; explore forwards an id it already
 *  minted. `category` of `ALL` (or omitted) means "no filter". */
export interface BrowserErrorScope {
  serviceId?: string | null;
  serviceVersionId?: string | null;
  pagePathId?: string | null;
  category?: BrowserErrorCategory;
}

/** Run OAP's `queryBrowserErrorLogs(BrowserErrorLogQueryCondition)` for a
 *  pre-resolved scope + SECOND-precision window + page, mapping rows to
 *  {@link BrowserErrorRow} (newest-first). Shared by the per-layer Browser
 *  Logs route and the cross-layer Log inspect browser branch. Soft-fails to
 *  `reachable: false` on any OAP error. */
export async function fetchBrowserErrors(
  opts: GraphqlOptions,
  scope: BrowserErrorScope,
  window: { start: string; end: string },
  paging: OapPaging,
  coldStage: boolean,
): Promise<BrowserErrorsResponse> {
  // Curried over the resolved window so the page and its next-page probe read
  // the same range.
  const condition = (p: OapPaging): Record<string, unknown> => ({
    ...(scope.serviceId ? { serviceId: scope.serviceId } : {}),
    ...(scope.serviceVersionId ? { serviceVersionId: scope.serviceVersionId } : {}),
    ...(scope.pagePathId ? { pagePathId: scope.pagePathId } : {}),
    // `ALL` is OAP's "no filter" sentinel — omit it so storage doesn't try
    // to match a literal category named ALL.
    ...(scope.category && scope.category !== 'ALL' ? { category: scope.category } : {}),
    queryDuration: {
      start: window.start,
      end: window.end,
      step: 'SECOND',
      ...(coldStage ? { coldStage: true } : {}),
    },
    paging: p,
  });
  try {
    const page = await readPage<OapBrowserErrorRow>(
      opts,
      BROWSER_ERROR_PAGE,
      condition,
      paging,
    );
    const logs: BrowserErrorRow[] = page.rows.map((r) => ({
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
    // Normalise to newest-first. OAP's BrowserErrorLog DAO sorts DESC, but
    // BanyanDB returns it per time-segment (each segment DESC, the segments
    // concatenated oldest-first), so a multi-segment result is not globally
    // ordered. Sort by the records' own `time` to guarantee a strictly
    // newest-first stream. The page boundary was already taken in OAP's own
    // order upstream, so this only reorders WITHIN the page.
    logs.sort((a, b) => b.time - a.time);
    return {
      generatedAt: Date.now(),
      query: {},
      pageNum: page.pageNum,
      pageSize: page.pageSize,
      hasNext: page.hasNext,
      logs,
      reachable: true,
    };
  } catch (err) {
    return {
      generatedAt: Date.now(),
      query: {},
      pageNum: paging.pageNum,
      pageSize: paging.pageSize,
      hasNext: false,
      logs: [],
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface Body extends BrowserErrorsQueryRequest {
  /** Name half of the picked service's identity; the condition queries with
   *  `serviceId`. */
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

      const paging: OapPaging = {
        pageNum: Math.max(1, Math.round(body.page ?? 1)),
        pageSize: clampPageSize(body.pageSize, 50, deps.config.current.performance.limits.maxPageSize.browserLogs),
      };

      // `BrowserErrorLogQueryCondition.serviceId` is nullable — a name left
      // without its id would list every browser app's JS errors.
      const scope = serviceScopeOf(body);
      if (scope.kind === 'incomplete') {
        return reply.send({
          generatedAt: Date.now(),
          query: body,
          ...paging,
          hasNext: false,
          logs: [],
          reachable: false,
          error: scope.message,
        } satisfies BrowserErrorsResponse);
      }
      const serviceId = scope.kind === 'service' ? scope.service.id : null;

      const res = await fetchBrowserErrors(
        opts,
        {
          serviceId,
          serviceVersionId: body.serviceVersionId,
          pagePathId: body.pagePathId,
          category: body.category,
        },
        window,
        paging,
        !!req.coldStage,
      );
      // Echo the operator's query (the shared helper returns an empty echo
      // since it's entity-agnostic).
      return reply.send({ ...res, query: body } satisfies BrowserErrorsResponse);
    },
  );
}
