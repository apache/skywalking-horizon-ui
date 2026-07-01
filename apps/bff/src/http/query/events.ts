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
 * `POST /api/events`
 *
 * Wraps OAP's `queryEvents(EventQueryCondition)` for the per-service events
 * popout. Body shape is `EventsQueryRequest` from
 * `@skywalking-horizon-ui/api-client`.
 *
 * Events are event-style records, so we query at SECOND precision (MINUTE
 * rounding would drop the most recent rows) and default to DES (newest-first).
 * Unlike the logs / browser-errors feeds there is NO service-name→id
 * resolution: `source.service` stores and filters on the literal service
 * name, so the `service` filter is forwarded verbatim. `layer` is OAP's
 * single-valued filter (the popout always passes one).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  EventOrder,
  EventRow,
  EventType,
  EventsQueryRequest,
  EventsResponse,
  FetchLike,
} from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import { graphqlPost, buildOapOpts, type GraphqlOptions } from '../../client/graphql.js';
import { fmtSecond, getServerOffsetMinutes } from '../../util/window.js';

export interface EventsRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
}

const DEFAULT_WINDOW_MIN = 60 * 24; // 1 day — events default to a recent window
const MAX_WINDOW_MIN = 60 * 24 * 7; // clamp rolling windows to a week

/** OAP feeds `paging.pageSize` straight to storage as a LIMIT. Mirror the
 *  configured cap server-side so the cap holds against direct API callers. */
export function clampPageSize(requested: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(requested as number) || (requested as number) < 1) return fallback;
  return Math.min(max, Math.round(requested as number));
}

/** Resolve the query window as epoch-ms, clamped to MAX_WINDOW_MIN. An explicit
 *  absolute range keeps its NEWEST slice; otherwise a rolling window of
 *  `minutes` (capped, default 1 day) ends at `nowMs`. Pure — `nowMs` is passed
 *  in so it stays testable — so a direct API caller can't ask for an unbounded
 *  range the UI picker would never allow. */
export function clampWindowMs(
  minutes: number | undefined,
  explicit: { startMs?: number; endMs?: number } | undefined,
  nowMs: number,
): { startMs: number; endMs: number } {
  const maxMs = MAX_WINDOW_MIN * 60_000;
  if (
    typeof explicit?.startMs === 'number' &&
    typeof explicit.endMs === 'number' &&
    explicit.startMs < explicit.endMs
  ) {
    return { startMs: Math.max(explicit.startMs, explicit.endMs - maxMs), endMs: explicit.endMs };
  }
  const m =
    Number.isFinite(minutes) && (minutes as number) > 0
      ? Math.min(MAX_WINDOW_MIN, Math.round(minutes as number))
      : DEFAULT_WINDOW_MIN;
  return { startMs: nowMs - m * 60_000, endMs: nowMs };
}

/** Render the resolved window into OAP-server-local SECOND strings. Sending
 *  bare browser-local strings would be read by OAP as OAP-local and miss the
 *  data by the TZ delta. */
function resolveWindow(
  offsetMinutes: number,
  minutes?: number,
  explicit?: { startMs?: number; endMs?: number },
): { start: string; end: string } {
  const { startMs, endMs } = clampWindowMs(minutes, explicit, Date.now());
  return { start: fmtSecond(startMs, offsetMinutes), end: fmtSecond(endMs, offsetMinutes) };
}

const QUERY_EVENTS = /* GraphQL */ `
  query QueryEvents($condition: EventQueryCondition) {
    data: queryEvents(condition: $condition) {
      events {
        uuid
        source { service serviceInstance endpoint }
        name
        type
        message
        parameters { key value }
        startTime
        endTime
        layer
      }
    }
  }
`;

export interface OapEventRow {
  uuid: string;
  source: { service?: string | null; serviceInstance?: string | null; endpoint?: string | null } | null;
  name: string;
  type: EventType;
  message?: string | null;
  parameters?: { key: string; value: string }[] | null;
  startTime: number;
  endTime?: number | null;
  layer: string;
}

/** The entity scope an event filter targets. All fields verbatim — events
 *  store + match on the literal service / instance / endpoint NAME. */
export interface EventScope {
  layer?: string;
  service?: string;
  serviceInstance?: string;
  endpoint?: string;
  type?: EventType;
  name?: string;
}

/** Build the `EventQueryCondition` sent to OAP. `source` is omitted entirely
 *  when no entity field is set; `type` / `name` / `layer` appear only when
 *  present; time is always SECOND precision (+ `coldStage` when asked). */
export function buildEventsCondition(
  scope: EventScope,
  window: { start: string; end: string },
  order: EventOrder,
  paging: { pageNum: number; pageSize: number },
  coldStage: boolean,
): Record<string, unknown> {
  const source =
    scope.service || scope.serviceInstance || scope.endpoint
      ? {
          ...(scope.service ? { service: scope.service } : {}),
          ...(scope.serviceInstance ? { serviceInstance: scope.serviceInstance } : {}),
          ...(scope.endpoint ? { endpoint: scope.endpoint } : {}),
        }
      : undefined;
  return {
    ...(scope.layer ? { layer: scope.layer } : {}),
    ...(source ? { source } : {}),
    ...(scope.type ? { type: scope.type } : {}),
    ...(scope.name ? { name: scope.name } : {}),
    order,
    time: { start: window.start, end: window.end, step: 'SECOND', ...(coldStage ? { coldStage: true } : {}) },
    paging,
  };
}

/** Map OAP rows to {@link EventRow} (endTime `0` → `null`) and re-sort to a
 *  strict order — BanyanDB concatenates per-segment results, so a multi-segment
 *  response is not globally ordered. `ts` mirrors OAP's own timestamp
 *  definition (endTime if finished, else startTime). */
export function mapAndSortEvents(rows: OapEventRow[], order: EventOrder): EventRow[] {
  const events: EventRow[] = rows.map((r) => ({
    uuid: r.uuid,
    source: {
      service: r.source?.service ?? '',
      serviceInstance: r.source?.serviceInstance ?? '',
      endpoint: r.source?.endpoint ?? '',
    },
    name: r.name,
    type: r.type,
    message: r.message ?? null,
    parameters: (r.parameters ?? []).map((p) => ({ key: p.key, value: p.value })),
    startTime: r.startTime,
    endTime: r.endTime && r.endTime > 0 ? r.endTime : null,
    layer: r.layer,
  }));
  const ts = (e: EventRow): number => (e.endTime && e.endTime > 0 ? e.endTime : e.startTime);
  events.sort((a, b) => (order === 'ASC' ? ts(a) - ts(b) : ts(b) - ts(a)));
  return events;
}

/** Run OAP's `queryEvents` for a scope + SECOND-precision window + page.
 *  Soft-fails to `reachable: false` on any OAP error. */
async function fetchEvents(
  opts: GraphqlOptions,
  scope: EventScope,
  window: { start: string; end: string },
  order: EventOrder,
  paging: { pageNum: number; pageSize: number },
  coldStage: boolean,
): Promise<{ events: EventRow[]; reachable: boolean; error?: string }> {
  try {
    const env = await graphqlPost<{ data: { events: OapEventRow[] } }>(opts, QUERY_EVENTS, {
      condition: buildEventsCondition(scope, window, order, paging, coldStage),
    });
    return { events: mapAndSortEvents(env.data?.events ?? [], order), reachable: true };
  } catch (err) {
    return { events: [], reachable: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function registerEventsRoute(app: FastifyInstance, deps: EventsRouteDeps): void {
  const auth = requireAuth(deps);
  app.post('/api/events', { preHandler: auth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as EventsQueryRequest;
    const opts = buildOapOpts(deps.config.current, deps.fetch);
    const offset = await getServerOffsetMinutes(deps.config, deps.fetch);
    const window = resolveWindow(offset, body.windowMinutes, { startMs: body.startMs, endMs: body.endMs });
    const order: EventOrder = body.order === 'ASC' ? 'ASC' : 'DES';
    const pageSize = clampPageSize(body.pageSize, 200, deps.config.current.performance.limits.maxPageSize.events);

    const res = await fetchEvents(
      opts,
      {
        layer: body.layer ? body.layer.toUpperCase() : undefined,
        service: body.service,
        serviceInstance: body.serviceInstance,
        endpoint: body.endpoint,
        type: body.type,
        name: body.name,
      },
      window,
      order,
      { pageNum: Math.max(1, Math.round(body.page ?? 1)), pageSize },
      !!req.coldStage,
    );

    return reply.send({
      generatedAt: Date.now(),
      query: body,
      total: res.events.length,
      pageSize,
      events: res.events,
      reachable: res.reachable,
      ...(res.error ? { error: res.error } : {}),
    } satisfies EventsResponse);
  });
}
