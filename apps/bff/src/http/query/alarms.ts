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
 * `/api/alarms/*` query routes — alarm list, count probe, and the
 * cascading-filter service-list helper.
 *
 *   GET  /api/alarms                  — paged alarm list (dual-mode:
 *                                       queryAlarms when available,
 *                                       getAlarm otherwise).
 *   GET  /api/alarms/count            — total + firing tally for the
 *                                       topbar badge.
 *   GET  /api/alarms/services?layer=  — service roster for the alarms
 *                                       filter cascade.
 *
 * Wire-time notes:
 *   - `startTime` / `endTime` are ms epoch. OAP's `Duration` expects
 *     `yyyy-MM-dd HHmmss` strings in OAP-server-TZ; conversion uses
 *     the timezone advertised by `getTimeInfo` (cached upstream).
 *   - The window is hard-capped at 4 hours. Alarms are
 *     second-precision events with no chunking; allowing larger
 *     windows pulls thousands of rows and starves the page on slow
 *     storage backends. The UI's picker enforces the same cap; this
 *     server-side guard is defence-in-depth.
 *   - `pageSize` is capped at 500 so the header KPIs + frontend pager
 *     can work from a single fetch. The COUNT route uses a 200 cap
 *     since it skips the snapshot payload.
 *   - Layer tagging on each row uses the cached service-name → layer
 *     index. Entries the index can't resolve (e.g. instance-scope
 *     alarms whose name doesn't carry a service prefix) get
 *     `layerKey: null` and the UI groups them under "Other".
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { z } from 'zod';
import { requireAuth } from '../../user/middleware.js';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { badRequest } from '../../errors.js';
import { buildOapOpts, graphqlPost } from '../../client/graphql.js';
import { getOapCapabilities } from '../../logic/oap/capabilities.js';
import type { ServiceLayerCatalog } from '../../logic/services/service-layer-catalog.js';

export interface AlarmsQueryRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  /** Server-global service-by-layer index (shared with config/alarms.ts +
   *  the sidebar menu). A config save invalidates it so the next list call
   *  picks up newly-pinned layers. */
  serviceLayer: ServiceLayerCatalog;
  fetch?: FetchLike;
}

// ── Wire types (mirror alarm.graphqls) ───────────────────────────────

export interface MqeKeyValue {
  key: string;
  value: string;
}

export interface MqeValueRow {
  id?: string | null;
  value: string | null;
  traceID?: string | null;
}

export interface MqeValuesGroup {
  metric?: { labels?: MqeKeyValue[] } | null;
  values: MqeValueRow[];
}

export interface MqeMetric {
  name: string;
  results: MqeValuesGroup[];
}

export interface AlarmSnapshot {
  expression: string;
  metrics: MqeMetric[];
}

export type AlarmScope =
  | 'All'
  | 'Service'
  | 'ServiceInstance'
  | 'Endpoint'
  | 'Process'
  | 'ServiceRelation'
  | 'ServiceInstanceRelation'
  | 'EndpointRelation'
  | 'ProcessRelation'
  | null;

export interface AlarmMessage {
  id: string;
  /** ms epoch */
  startTime: number;
  /** ms epoch, null = still firing */
  recoveryTime: number | null;
  scope: AlarmScope;
  name: string;
  message: string;
  tags: MqeKeyValue[];
  events?: Array<Record<string, unknown>>;
  snapshot: AlarmSnapshot;
  /** Best-effort layer tag derived from the service-layer catalog. Null when
   *  the entity isn't a known service (instance / endpoint / etc.
   *  fall through if their service prefix doesn't match). */
  layerKey: string | null;
}

export interface AlarmsResponse {
  /** Rows returned for this page. The list route does not page through
   *  the OAP response; the UI pages this client-side. */
  total: number;
  pageNum: number;
  pageSize: number;
  /** True when `total === pageSize`, meaning OAP may have more rows
   *  than we fetched. The UI shows a "Nrows+" hint to nudge the
   *  operator to tighten the window. */
  truncated: boolean;
  generatedAt: number;
  msgs: AlarmMessage[];
}

export interface AlarmsCountResponse {
  /** Total individual events returned by OAP — capped at
   *  COUNT_FETCH_CAP. */
  total: number;
  /** Events with `recoveryTime === null`. */
  firing: number;
  /** Distinct (entity, rule) groups across `total` — one per OAP id.
   *  This is the "real" incident count regardless of re-firings. */
  incidents: number;
  /** Subset of `incidents` whose LATEST event is still firing. The
   *  topbar badge displays this — a fully-recovered incident counts
   *  as "no alarm" per the page spec. */
  activeIncidents: number;
  truncated: boolean;
  startTime: number;
  endTime: number;
  generatedAt: number;
}

// ── Helpers ──────────────────────────────────────────────────────────

interface ServerTzInfo {
  /** Minutes from UTC (e.g. 480 for UTC+8). 0 fallback. */
  offsetMinutes: number;
  fetchedAt: number;
}
let tzCache: ServerTzInfo | null = null;
const TZ_TTL_MS = 60_000;

const TIME_INFO_QUERY = /* GraphQL */ `
  query HorizonAlarmsTime {
    time: getTimeInfo {
      timezone
      currentTimestamp
    }
  }
`;

async function getServerOffsetMinutes(
  config: ConfigSource,
  fetchImpl?: FetchLike,
): Promise<number> {
  const now = Date.now();
  if (tzCache && now - tzCache.fetchedAt < TZ_TTL_MS) return tzCache.offsetMinutes;
  try {
    const got = await graphqlPost<{ time?: { timezone?: string | null } | null }>(
      buildOapOpts(config.current, fetchImpl),
      TIME_INFO_QUERY,
    );
    const raw = got.time?.timezone ?? '+0000';
    const m = /^([+-])(\d{2})(\d{2})$/.exec(raw);
    if (m) {
      const sign = m[1] === '-' ? -1 : 1;
      const h = parseInt(m[2], 10);
      const mi = parseInt(m[3], 10);
      const offset = sign * (h * 60 + mi);
      tzCache = { offsetMinutes: offset, fetchedAt: now };
      return offset;
    }
  } catch {
    /* fall through to 0 */
  }
  tzCache = { offsetMinutes: 0, fetchedAt: now };
  return 0;
}

/** Format an epoch-ms into OAP's `yyyy-MM-dd HHmmss` (SECOND
 *  granularity), in the server's timezone. */
function fmtSecond(epochMs: number, offsetMinutes: number): string {
  const shifted = new Date(epochMs + offsetMinutes * 60_000);
  const y = shifted.getUTCFullYear();
  const mo = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  const h = String(shifted.getUTCHours()).padStart(2, '0');
  const mi = String(shifted.getUTCMinutes()).padStart(2, '0');
  const s = String(shifted.getUTCSeconds()).padStart(2, '0');
  return `${y}-${mo}-${d} ${h}${mi}${s}`;
}

// ── GraphQL queries ──────────────────────────────────────────────────

/* `events` is deliberately OMITTED — demo OAP (and some storage
 *  backends) throw `java.io.IOException: fail to query stream` when
 *  events stream per-row alongside a 30+ row page. The snapshot
 *  already carries everything the detail panel needs (expression +
 *  the MQE values that crossed threshold). */
const GET_ALARM_QUERY = /* GraphQL */ `
  query HorizonGetAlarm(
    $duration: Duration!
    $scope: Scope
    $keyword: String
    $paging: Pagination!
    $tags: [AlarmTag]
  ) {
    getAlarm(duration: $duration, scope: $scope, keyword: $keyword, paging: $paging, tags: $tags) {
      msgs {
        id startTime recoveryTime scope name message
        tags { key value }
        snapshot {
          expression
          metrics {
            name
            results {
              metric { labels { key value } }
              values { id value traceID }
            }
          }
        }
      }
    }
  }
`;
const QUERY_ALARMS_QUERY = /* GraphQL */ `
  query HorizonQueryAlarms($condition: AlarmQueryCondition!) {
    queryAlarms(condition: $condition) {
      msgs {
        id startTime recoveryTime scope name message
        tags { key value }
        snapshot {
          expression
          metrics {
            name
            results {
              metric { labels { key value } }
              values { id value traceID }
            }
          }
        }
      }
    }
  }
`;
/* Lightweight selection for the topbar badge — count primitives + a
 * startTime so the incident merger can pick the latest event per
 * (entity, rule) group. Snapshot / tags / message stay omitted to
 * keep the payload cheap (target: < 5kB per poll at the 200-row
 * cap). */
const COUNT_GET_ALARM_QUERY = /* GraphQL */ `
  query HorizonCountGetAlarm($duration: Duration!, $paging: Pagination!) {
    getAlarm(duration: $duration, paging: $paging) { msgs { id startTime recoveryTime } }
  }
`;
const COUNT_QUERY_ALARMS_QUERY = /* GraphQL */ `
  query HorizonCountQueryAlarms($condition: AlarmQueryCondition!) {
    queryAlarms(condition: $condition) { msgs { id startTime recoveryTime } }
  }
`;
const LIST_SERVICES_QUERY = /* GraphQL */ `
  query HorizonAlarmServices($layer: String!) {
    listServices(layer: $layer) { name normal }
  }
`;

interface GetAlarmRaw {
  getAlarm?: { msgs?: AlarmMessage[] } | null;
}
interface QueryAlarmsRaw {
  queryAlarms?: { msgs?: AlarmMessage[] } | null;
}
interface ListServicesRaw {
  listServices: Array<{ name: string; normal: boolean | null }>;
}

// ── Schemas + caps ───────────────────────────────────────────────────

/** Window cap for `/api/alarms` and `/api/alarms/count`. Defence-in-
 *  depth — the UI picker already enforces this, but a hand-crafted
 *  URL shouldn't pull a 24h fan-out from OAP. */
const WINDOW_CAP_MS = 4 * 60 * 60_000;
const LIST_PAGE_SIZE_CAP = 500;
const COUNT_FETCH_CAP = 200;

const alarmsQuerySchema = z.object({
  startTime: z.coerce.number().int().positive(),
  endTime: z.coerce.number().int().positive(),
  /** Legacy-mode only. Ignored in new mode (use `layer` + entity
   *  fields instead). */
  scope: z.string().optional(),
  keyword: z.string().optional(),
  pageNum: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(LIST_PAGE_SIZE_CAP).default(LIST_PAGE_SIZE_CAP),
  /** New-mode only. Maps to `condition.layer` (a single String on the
   *  OAP side — an alarm record is persisted with one layer). */
  layer: z.string().optional(),
  /** New-mode only. Combined with `instance` / `endpoint` to build a
   *  single `Entity` filter. When absent, no entity narrowing. */
  service: z.string().optional(),
  instance: z.string().optional(),
  endpoint: z.string().optional(),
});

const countQuerySchema = z.object({
  startTime: z.coerce.number().int().positive(),
  endTime: z.coerce.number().int().positive(),
});

// ── Entity builder (new mode) ────────────────────────────────────────

/* Translate the cascade fields (`layer`, `service`, `instance`,
 * `endpoint`) into the smallest precise `Entity` that the
 * queryAlarms `condition.entities` filter accepts. Scope is inferred
 * from which name fields are populated — same convention OAP itself
 * uses (see alarm.graphqls comment on `entities`).
 *
 * Returns null when no entity narrowing is requested. The caller then
 * omits `entities` from the condition entirely, leaving `layers`
 * as the only entity-side filter (or no entity filter at all when
 * `layer` is also blank).
 */
interface EntityFilter {
  scope: string;
  serviceName?: string;
  normal?: boolean;
  serviceInstanceName?: string;
  endpointName?: string;
}
function buildEntity(q: {
  service?: string;
  instance?: string;
  endpoint?: string;
}): EntityFilter | null {
  if (!q.service) return null;
  const base: EntityFilter = { scope: 'Service', serviceName: q.service, normal: true };
  if (q.endpoint && !q.instance) {
    return { ...base, scope: 'Endpoint', endpointName: q.endpoint };
  }
  if (q.instance) {
    return { ...base, scope: 'ServiceInstance', serviceInstanceName: q.instance };
  }
  return base;
}

// ── Row tagging ──────────────────────────────────────────────────────

async function tagWithLayer(
  msgsRaw: AlarmMessage[],
  serviceLayer: ServiceLayerCatalog,
): Promise<AlarmMessage[]> {
  const layerIdx = await serviceLayer.get();
  return msgsRaw.map((m) => {
    /* Entity name on Service scope is the service name directly; on
     * ServiceInstance / Endpoint the wire packs the service name as
     * a prefix before a separator. Try the literal first, then strip
     * after common separators. */
    const candidates = [m.name, m.name.split('::')[0], m.name.split(' ')[0]];
    let layerKey: string | null = null;
    for (const cand of candidates) {
      const hit = layerIdx.byName.get(cand.toLowerCase());
      if (hit) {
        layerKey = hit;
        break;
      }
    }
    return { ...m, layerKey };
  });
}

// ── Routes ───────────────────────────────────────────────────────────

export function registerAlarmsQueryRoutes(app: FastifyInstance, deps: AlarmsQueryRouteDeps): void {
  const auth = requireAuth(deps);
  const serviceLayer = deps.serviceLayer;

  // ── GET /api/alarms ────────────────────────────────────────────────
  app.get('/api/alarms', { preHandler: auth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = alarmsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', detail: parsed.error.flatten() });
    }
    const q = parsed.data;
    if (q.endTime <= q.startTime) return badRequest('endTime must be greater than startTime');
    if (q.endTime - q.startTime > WINDOW_CAP_MS) {
      return badRequest(`window exceeds ${WINDOW_CAP_MS / 60_000}m cap`);
    }

    const offset = await getServerOffsetMinutes(deps.config, deps.fetch);
    const start = fmtSecond(q.startTime, offset);
    const end = fmtSecond(q.endTime, offset);

    const opts = buildOapOpts(deps.config.current, deps.fetch);
    const caps = await getOapCapabilities(deps.config.current, deps.fetch);

    let msgsRaw: AlarmMessage[];
    try {
      if (caps.queryAlarms) {
        /* New-mode condition. `entities` + `layer` ride server-side;
         * `scope` is intentionally ignored here because it's a
         * legacy-only coarse filter and `entities` + `layer` cover
         * its use-cases more precisely. NOTE: the OAP field is
         * `layer: String` (singular scalar), NOT `layers: [String]`.
         * An alarm record is persisted with exactly one layer, so the
         * filter is a single value. Sending `layers` silently no-ops —
         * OAP ignores the unknown field and returns every layer's
         * alarms, which looked like "the per-layer filter doesn't
         * work". */
        const condition: Record<string, unknown> = {
          duration: { start, end, step: 'SECOND' },
          paging: { pageNum: q.pageNum, pageSize: q.pageSize },
        };
        if (q.keyword) condition.keyword = q.keyword;
        if (q.layer) condition.layer = q.layer;
        const entity = buildEntity(q);
        if (entity) condition.entities = [entity];
        const raw = await graphqlPost<QueryAlarmsRaw>(opts, QUERY_ALARMS_QUERY, { condition });
        msgsRaw = raw.queryAlarms?.msgs ?? [];
      } else {
        /* Legacy mode: scope + keyword + tags only. The UI hides the
         * layer / cascade filter row in this mode, so `layer` /
         * `service` / `instance` / `endpoint` query params should
         * not be present — but if they are (operator hand-rolled a
         * URL), the BFF silently ignores them rather than 400-ing,
         * matching the spirit of the spec's "drop fake filters". */
        const variables: Record<string, unknown> = {
          duration: { start, end, step: 'SECOND' },
          paging: { pageNum: q.pageNum, pageSize: q.pageSize },
        };
        if (q.scope) variables.scope = q.scope;
        if (q.keyword) variables.keyword = q.keyword;
        const raw = await graphqlPost<GetAlarmRaw>(opts, GET_ALARM_QUERY, variables);
        msgsRaw = raw.getAlarm?.msgs ?? [];
      }
    } catch (err) {
      return reply.code(502).send({
        error: 'oap_unreachable',
        message: err instanceof Error ? err.message : String(err),
      });
    }

    const tagged = await tagWithLayer(msgsRaw, serviceLayer);

    const body: AlarmsResponse = {
      total: tagged.length,
      pageNum: q.pageNum,
      pageSize: q.pageSize,
      truncated: tagged.length >= q.pageSize,
      generatedAt: Date.now(),
      msgs: tagged,
    };
    return reply.send(body);
  });

  // ── GET /api/alarms/count ──────────────────────────────────────────
  app.get(
    '/api/alarms/count',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = countQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_query', detail: parsed.error.flatten() });
      }
      const q = parsed.data;
      if (q.endTime <= q.startTime) return badRequest('endTime must be greater than startTime');
      if (q.endTime - q.startTime > WINDOW_CAP_MS) {
        return badRequest(`window exceeds ${WINDOW_CAP_MS / 60_000}m cap`);
      }

      const offset = await getServerOffsetMinutes(deps.config, deps.fetch);
      const start = fmtSecond(q.startTime, offset);
      const end = fmtSecond(q.endTime, offset);

      const opts = buildOapOpts(deps.config.current, deps.fetch);
      const caps = await getOapCapabilities(deps.config.current, deps.fetch);

      let rows: Array<{ id: string; startTime: number; recoveryTime: number | null }>;
      try {
        if (caps.queryAlarms) {
          const condition = {
            duration: { start, end, step: 'SECOND' },
            paging: { pageNum: 1, pageSize: COUNT_FETCH_CAP },
          };
          const raw = await graphqlPost<QueryAlarmsRaw>(opts, COUNT_QUERY_ALARMS_QUERY, { condition });
          rows = (raw.queryAlarms?.msgs ?? []).map((m) => ({
            id: m.id,
            startTime: m.startTime,
            recoveryTime: m.recoveryTime,
          }));
        } else {
          const variables = {
            duration: { start, end, step: 'SECOND' },
            paging: { pageNum: 1, pageSize: COUNT_FETCH_CAP },
          };
          const raw = await graphqlPost<GetAlarmRaw>(opts, COUNT_GET_ALARM_QUERY, variables);
          rows = (raw.getAlarm?.msgs ?? []).map((m) => ({
            id: m.id,
            startTime: m.startTime,
            recoveryTime: m.recoveryTime,
          }));
        }
      } catch (err) {
        return reply.code(502).send({
          error: 'oap_unreachable',
          message: err instanceof Error ? err.message : String(err),
        });
      }

      const total = rows.length;
      const firing = rows.reduce((n, r) => n + (r.recoveryTime === null ? 1 : 0), 0);

      /* Group by OAP id (= entity.rule key); the incident's state is
       * the LATEST event's state. Matches the UI's `mergeIncidents`
       * semantics — keep both implementations in lock-step. */
      const latestByGroup = new Map<string, { startTime: number; recoveryTime: number | null }>();
      for (const r of rows) {
        const cur = latestByGroup.get(r.id);
        if (!cur || r.startTime > cur.startTime) {
          latestByGroup.set(r.id, { startTime: r.startTime, recoveryTime: r.recoveryTime });
        }
      }
      const incidents = latestByGroup.size;
      let activeIncidents = 0;
      for (const v of latestByGroup.values()) {
        if (v.recoveryTime === null) activeIncidents += 1;
      }

      const body: AlarmsCountResponse = {
        total,
        firing,
        incidents,
        activeIncidents,
        truncated: total >= COUNT_FETCH_CAP,
        startTime: q.startTime,
        endTime: q.endTime,
        generatedAt: Date.now(),
      };
      return reply.send(body);
    },
  );

  // ── GET /api/alarms/services?layer=X ──────────────────────────────
  /* Cascading-filter helper. Returns the service roster for one OAP
   * layer in alpha order so the UI populates a dropdown without
   * re-implementing the listServices wire. The instance + endpoint
   * pickers reuse the existing /api/layer/:key/instances and
   * /api/layer/:key/endpoints endpoints. */
  app.get(
    '/api/alarms/services',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const layer = (req.query as { layer?: string } | undefined)?.layer;
      if (!layer || typeof layer !== 'string') {
        return reply.code(400).send({ error: 'missing_layer' });
      }
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      try {
        const got = await graphqlPost<ListServicesRaw>(opts, LIST_SERVICES_QUERY, { layer });
        const services = (got.listServices ?? [])
          .filter((s) => typeof s?.name === 'string' && s.name.length > 0)
          .sort((a, b) => a.name.localeCompare(b.name));
        return reply.send({ layer, services });
      } catch (err) {
        return reply.code(502).send({
          error: 'oap_unreachable',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
}
