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
 *                                       filter cascade; with `page`, only
 *                                       the services that page's pins cover.
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
 *   - `pageSize` is capped at 500 so one fetch holds every row the
 *     page's header KPIs and list draw. The COUNT route uses a 200 cap
 *     since it skips the snapshot payload.
 *   - The entity filter is name-scoped: `alarm.graphqls` has no id
 *     form, so a service id has nowhere to go on this route. What the
 *     filter needs alongside the name is the picked roster row's
 *     `normal` flag, because that is part of the OAP service id
 *     (`base64(name).1` normal / `.0` virtual, `IDManager.ServiceID`)
 *     that instance and endpoint ids are built on. Filtering a VIRTUAL
 *     (conjectural) service with the wrong flag asks for an id nothing
 *     was stored under, so OAP answers with an empty page. Name and
 *     flag both arrive with the request — the roster row the operator
 *     picked — so nothing is looked up or guessed here.
 *   - A service picked WITHOUT an instance or endpoint is not sent to
 *     OAP: a Service entity matches only the service's own id, which
 *     drops its instances', endpoints' and their relations' alarms. The
 *     window is read whole and the rows that concern the service are
 *     kept (`alarmConcernsService`). An instance or endpoint is sent as
 *     the exact entity.
 *   - Each row is tagged with the layers of the services it belongs to
 *     (`layerKeys`, see logic/alarms/owners.ts): the owner service read
 *     from the entity id, and for a relation both ends. A row no known
 *     service owns gets none, and the UI counts it under "Other".
 *     `ownerKeys` carries the same services as `LAYER~group` pairs.
 *   - `layer` may be a split menu entry's `<LAYER>~<group>` key, which an
 *     overview widget is bound to: it keeps the rows of that group's
 *     services, by `ownerKeys`. It narrows what the caller may read; it
 *     grants nothing.
 *   - A caller who does not hold `alarms:read` on every layer gets, from
 *     a read that names no service, only the rows of services they may
 *     read (logic/alarms/readable.ts), filtered here because OAP cannot.
 *     The count counts those rows alone.
 *   - `page` names an alarm page (logic/alarms/pages.ts): only the rows
 *     one of its pins covers are kept, the pins narrowed to the caller as
 *     `/api/alarms/pages` serves them. A page not served to the caller is
 *     404; an unreachable template store is 503, never the bundle.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ALERT_DEFAULT_PAGE_ID,
  alarmPinMatches,
  formatAlarmPin,
  layerFilterPin,
  type AlarmPin,
  type FetchLike,
  type UITemplateClient,
} from '@skywalking-horizon-ui/api-client';
import { z } from 'zod';
import type { AuthDeps } from '../../user/middleware.js';
import { requireAuth } from '../../user/middleware.js';
import { badRequest } from '../../errors.js';
import { buildOapOpts, graphqlPost } from '../../client/graphql.js';
import { clientGone } from '../client-gone.js';
import { getOapCapabilities } from '../../logic/oap/capabilities.js';
import { pageOffset, readFilteredPage, readPageWith, readPrefixPage, type OapPaging, type PageResult } from '../../logic/paging/read-page.js';
import { fmtSecond, getServerOffsetMinutes } from '../../util/window.js';
import { alarmsQuerySchema } from './alarms-request.js';
import type {
  ServiceCatalog,
  ServiceLayerCatalog,
} from '../../logic/services/service-layer-catalog.js';
import { readsByNameOnly } from '../../rbac/request-access.js';
import { ServiceLookupUnavailable, catalogIndex, entityServiceName, serviceIdOf, type Index } from '../../logic/services/service-identity.js';
import { alarmConcernsService, alarmIncidentKey, alarmLayers, alarmOwnerKeys } from '../../logic/alarms/owners.js';
import { namedPagePins, pinReachOf, readStoredAlarmPages } from '../../logic/alarms/pages.js';
import { AlarmRowAccess, keepAll, readsEveryAlarm, type DecidedRow } from '../../logic/alarms/readable.js';
import { canonicalLayerKey } from '../../logic/templates/identity.js';

export interface AlarmsQueryRouteDeps extends AuthDeps {
  /** Server-global service-by-layer index (shared with config/alarms.ts +
   *  the sidebar menu). A config save invalidates it so the next list call
   *  picks up newly-pinned layers. */
  serviceLayer: ServiceLayerCatalog;
  /** The template store `page` is resolved from, as `/api/alarms/pages` reads it. */
  uiTemplateClient: () => UITemplateClient;
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
  /** Every layer of the services the alarm belongs to — its entity's owner
   *  service, and for a relation both ends. Empty when none is a service the
   *  catalog knows. */
  layerKeys: string[];
  /** The first of `layerKeys`, for readers that take one. */
  layerKey: string | null;
  /** The same services as `LAYER~group` pairs (`alarmOwnerKey`), a
   *  destination the name fits to several services adding only the pairs
   *  all of them share. */
  ownerKeys: string[];
}

export interface AlarmsResponse {
  /** Rows returned for this page. NOT a cross-page total — `Alarms` carries
   *  exactly one field (`msgs`) and no count. */
  returned: number;
  pageNum: number;
  pageSize: number;
  /** OAP held at least one more row than the fetch allowed — proven by an
   *  over-fetched read, so a result that exactly fills `pageSize` is NOT
   *  flagged. The UI nudges the operator to tighten the window. */
  truncated: boolean;
  generatedAt: number;
  msgs: AlarmMessage[];
  /** With `page`: the pins these rows were read by, as served to the caller,
   *  so the page draws the tiles its rows were chosen by. */
  pinnedLayers?: string[];
}

export interface AlarmsCountResponse {
  /** Individual events counted — capped at COUNT_FETCH_CAP. Only the
   *  events of services the caller may read. */
  total: number;
  /** Events with `recoveryTime === null`. */
  firing: number;
  /** Distinct (entity, rule) groups across `total` — the "real" incident
   *  count regardless of re-firings. */
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
/* Lightweight selection for the topbar badge — what the incident key needs
 * (entity, name, rule expression) plus the state. Metric values, tags and
 * message stay omitted to keep the payload cheap. */
const COUNT_GET_ALARM_QUERY = /* GraphQL */ `
  query HorizonCountGetAlarm($duration: Duration!, $paging: Pagination!) {
    getAlarm(duration: $duration, paging: $paging) {
      msgs { id scope name startTime recoveryTime snapshot { expression } }
    }
  }
`;
const COUNT_QUERY_ALARMS_QUERY = /* GraphQL */ `
  query HorizonCountQueryAlarms($condition: AlarmQueryCondition!) {
    queryAlarms(condition: $condition) {
      msgs { id scope name startTime recoveryTime snapshot { expression } }
    }
  }
`;
const LIST_SERVICES_QUERY = /* GraphQL */ `
  query HorizonAlarmServices($layer: String!) {
    listServices(layer: $layer) { id name normal group }
  }
`;

interface GetAlarmRaw {
  getAlarm?: { msgs?: AlarmMessage[] } | null;
}
interface QueryAlarmsRaw {
  queryAlarms?: { msgs?: AlarmMessage[] } | null;
}
/** One row of the count selection. */
type CountRow = Pick<AlarmMessage, 'id' | 'scope' | 'name' | 'startTime' | 'recoveryTime'> & {
  snapshot?: { expression?: string; metrics?: unknown[] } | null;
};
type CountRaw<F extends 'queryAlarms' | 'getAlarm'> = { [K in F]?: { msgs?: CountRow[] } | null };
interface ListServicesRaw {
  listServices: Array<{ id: string; name: string; normal: boolean | null; group?: string | null }>;
}

/** Window cap for `/api/alarms` and `/api/alarms/count`. Defence-in-
 *  depth — the UI picker already enforces this, but a hand-crafted
 *  URL shouldn't pull a 24h fan-out from OAP. */
const WINDOW_CAP_MS = 4 * 60 * 60_000;
const COUNT_FETCH_CAP = 200;
/** A list page is read as a slice of the window's first rows (see
 *  `readPrefixPage`), so no read goes past `maxRows`; a layer filter starts
 *  at `first` rows and widens until its page is full. */
const ALARM_READ = { first: 500, maxRows: 5_000 };

const countQuerySchema = z.object({
  startTime: z.coerce.number().int().positive(),
  endTime: z.coerce.number().int().positive(),
});

/* Translate the picked service (name + flag) and a picked instance or
 * endpoint into the `Entity` the queryAlarms `condition.entities` filter
 * accepts. Scope is inferred from which name field is populated — same
 * convention OAP itself uses (see alarm.graphqls comment on `entities`).
 * `normal` rides on both: instance and endpoint ids are built on top of
 * the service id, which encodes the flag.
 *
 * A non-relation entity matches `id0 = X OR id1 = X` — the instance's or
 * endpoint's own alarms and the relations it is either end of. A service
 * alone is never sent: its instances' and endpoints' alarms carry their
 * own ids, so a Service entity would drop them.
 */
interface EntityFilter {
  scope: 'ServiceInstance' | 'Endpoint';
  serviceName: string;
  normal: boolean;
  serviceInstanceName?: string;
  endpointName?: string;
}
function buildEntity(
  q: { instance?: string; endpoint?: string },
  service: { name: string; normal: boolean },
): EntityFilter | null {
  const base = { serviceName: service.name, normal: service.normal };
  if (q.instance) return { ...base, scope: 'ServiceInstance', serviceInstanceName: q.instance };
  if (q.endpoint) return { ...base, scope: 'Endpoint', endpointName: q.endpoint };
  return null;
}

function tagWithOwners(msgsRaw: AlarmMessage[], index: Index): AlarmMessage[] {
  return msgsRaw.map((m) => {
    const layerKeys = alarmLayers(m, index);
    return { ...m, layerKeys, layerKey: layerKeys[0] ?? null, ownerKeys: alarmOwnerKeys(m, index) };
  });
}

/** Without the catalog every row looks like it belongs to no layer and no
 *  destination service, so a filter by either would answer for a read it
 *  never made. */
function catalogMissing(catalog: ServiceCatalog): boolean {
  return !!catalog.unreachable && catalog.byLayer.size === 0;
}

function catalogUnavailable(reply: FastifyReply): FastifyReply {
  return reply.code(503).send({
    error: 'catalog_unavailable',
    message: 'The service catalog could not be read, so alarms cannot be told apart by the services they concern',
  });
}

function templateStoreUnreachable(reply: FastifyReply): FastifyReply {
  return reply.code(503).send({
    error: 'template_store_unreachable',
    message: "OAP's ui_template store is unreachable, so the alarm page's pins cannot be read",
  });
}

/** A failed read: OAP could not say whose a service is (503, as the scope
 *  gate answers it), or the alarm query itself failed (502). */
function readFailed(reply: FastifyReply, err: unknown): FastifyReply {
  const message = err instanceof Error ? err.message : String(err);
  return reply.code(err instanceof ServiceLookupUnavailable ? 503 : 502).send({ error: 'oap_unreachable', message });
}

export function registerAlarmsQueryRoutes(app: FastifyInstance, deps: AlarmsQueryRouteDeps): void {
  const auth = requireAuth(deps);
  const serviceLayer = deps.serviceLayer;

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
    if (pageOffset(q.pageNum, q.pageSize) + q.pageSize > ALARM_READ.maxRows) {
      return badRequest(`only the first ${ALARM_READ.maxRows} alarms of a window can be paged; narrow the window or the filter`);
    }
    /* Name AND flag, or no service filter at all — the schema refuses the half
     * pair, so a guessed flag can never narrow the query to an id nothing was
     * stored under. */
    const named = q.service && q.normal !== undefined ? { name: q.service, normal: q.normal } : null;
    const entity = named ? buildEntity(q, named) : null;
    const pageId = q.page && q.page !== ALERT_DEFAULT_PAGE_ID ? q.page : null;

    const signal = clientGone(reply);
    const opts = buildOapOpts(deps.config.current, deps.fetch, signal);
    const [offset, caps, catalog, stored] = await Promise.all([
      getServerOffsetMinutes(deps.config, deps.fetch, signal),
      getOapCapabilities(deps.config.current, deps.fetch, signal),
      serviceLayer.get(),
      pageId ? readStoredAlarmPages(deps.uiTemplateClient) : null,
    ]);
    const start = fmtSecond(q.startTime, offset);
    const end = fmtSecond(q.endTime, offset);

    const duration = { start, end, step: 'SECOND' as const };
    const access = req.access;
    // The legacy query takes no entity filter: a layer-limited caller is
    // refused on it rather than served from a read of every alarm.
    if (!caps.queryAlarms && access?.layerLimited(['alarms:read'])) {
      return reply.code(403).send({ error: 'permission_denied', verb: 'alarms:read', reason: 'alarm_filter_unsupported' });
    }
    let pagePins: AlarmPin[] | null = null;
    if (pageId && stored) {
      if (stored.unreachable) return templateStoreUnreachable(reply);
      pagePins = namedPagePins(stored, pageId, pinReachOf(access));
      if (!pagePins) {
        return reply.code(404).send({ error: 'alarm_page_not_found', message: `No alarm page "${pageId}" is served to this user` });
      }
    }
    // The legacy query ignores a picked service, as it ignores the rest of
    // the cascade.
    const serviceId = named && !entity && caps.queryAlarms ? serviceIdOf(named.name, named.normal) : null;
    const fetchAlarms = async (paging: OapPaging): Promise<AlarmMessage[]> => {
      if (caps.queryAlarms) {
        /* New-mode condition. `scope` is a legacy-only coarse filter
         * that `entities` covers more precisely. OAP's `layer` is one
         * String because an alarm record is persisted with exactly one
         * layer — its entity's first, or none when OAP had not resolved
         * it yet — so it is never sent: beside an entity the service
         * decides, and on its own it is applied below, by the layers the
         * page counts an alarm under. */
        const condition: Record<string, unknown> = { duration, paging };
        if (q.keyword) condition.keyword = q.keyword;
        if (entity) condition.entities = [entity];
        const raw = await graphqlPost<QueryAlarmsRaw>(opts, QUERY_ALARMS_QUERY, { condition });
        return raw.queryAlarms?.msgs ?? [];
      }
      /* Legacy mode: scope + keyword + tags only. The UI hides the
       * layer / cascade filter row in this mode, so `layer` /
       * `service` / `instance` / `endpoint` query params should
       * not be present — but if they are (operator hand-rolled a
       * URL), the BFF silently ignores them rather than 400-ing,
       * matching the spirit of the spec's "drop fake filters". */
      const variables: Record<string, unknown> = { duration, paging };
      if (q.scope) variables.scope = q.scope;
      if (q.keyword) variables.keyword = q.keyword;
      const raw = await graphqlPost<GetAlarmRaw>(opts, GET_ALARM_QUERY, variables);
      return raw.getAlarm?.msgs ?? [];
    };

    const layerPin = q.layer && !named ? layerFilterPin(q.layer, canonicalLayerKey) : null;
    const index = catalogIndex(catalog);
    // Every row a picked service keeps concerns that service, which the gate
    // has checked; the legacy query cannot narrow, so its rows are decided.
    const perRow = access && !readsEveryAlarm(access) && (!named || !caps.queryAlarms) ? new AlarmRowAccess(access, index) : null;
    if ((layerPin || perRow || pagePins || serviceId) && catalogMissing(catalog)) return catalogUnavailable(reply);
    const keep = (d: DecidedRow<AlarmMessage>): boolean =>
      d.kept &&
      (!layerPin || alarmPinMatches(layerPin, d.row)) &&
      (!pagePins || pagePins.some((pin) => alarmPinMatches(pin, d.row))) &&
      (!serviceId || alarmConcernsService(d.row, serviceId, index));
    // Every read starts at row 0 — see readPrefixPage for the OAP offset
    // this avoids.
    const fetchFirst = async (rows: number): Promise<Array<DecidedRow<AlarmMessage>>> => {
      const tagged = tagWithOwners(await fetchAlarms({ pageNum: 1, pageSize: rows }), index);
      return perRow ? perRow.decide(tagged) : keepAll(tagged);
    };
    const paging = { pageNum: q.pageNum, pageSize: q.pageSize };
    let page: PageResult<DecidedRow<AlarmMessage>>;
    let tagged: AlarmMessage[];
    try {
      page = layerPin || perRow || pagePins || serviceId
        ? await readFilteredPage(fetchFirst, keep, paging, ALARM_READ)
        : await readPrefixPage(fetchFirst, paging);
      tagged = page.rows.map((d) => d.row);
    } catch (err) {
      return readFailed(reply, err);
    }

    // A `baseline` in the rule was looked up by the alarm entity's NAME alone,
    // and its values ride in the snapshot: a caller limited to some groups
    // sees them only when every service of that name is readable. Only a
    // Service alarm's name is a service's; the others are composite.
    const byName = (m: AlarmMessage) => readsByNameOnly([m.snapshot?.expression ?? '']);
    if (access?.layerLimited(['alarms:read']) && tagged.some(byName)) {
      const readable = new Map<string, boolean>();
      const keeps = async (m: AlarmMessage): Promise<boolean> => {
        if (m.scope !== 'Service') return false;
        const name = entityServiceName(m.name);
        if (!readable.has(name)) readable.set(name, (await access.decide(['alarms:read'], { name })) === 'allow');
        return readable.get(name)!;
      };
      const out: typeof tagged = [];
      for (const m of tagged) out.push(byName(m) && !(await keeps(m)) ? { ...m, snapshot: { ...m.snapshot, metrics: [] } } : m);
      tagged = out;
    }

    const body: AlarmsResponse = {
      returned: tagged.length,
      pageNum: q.pageNum,
      pageSize: q.pageSize,
      truncated: page.hasNext,
      generatedAt: Date.now(),
      msgs: tagged,
      ...(pagePins ? { pinnedLayers: pagePins.map(formatAlarmPin) } : {}),
    };
    return reply.send(body);
  });

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

      const signal = clientGone(reply);
      const opts = buildOapOpts(deps.config.current, deps.fetch, signal);
      const access = req.access;
      const everything = readsEveryAlarm(access);
      const [offset, caps, catalog] = await Promise.all([
        getServerOffsetMinutes(deps.config, deps.fetch, signal),
        getOapCapabilities(deps.config.current, deps.fetch, signal),
        everything ? null : serviceLayer.get(),
      ]);
      if (catalog && catalogMissing(catalog)) return catalogUnavailable(reply);
      const start = fmtSecond(q.startTime, offset);
      const end = fmtSecond(q.endTime, offset);

      const duration = { start, end, step: 'SECOND' as const };
      const fetchCountRows = async (paging: OapPaging): Promise<CountRow[]> => {
        const msgs = caps.queryAlarms
          ? (await graphqlPost<CountRaw<'queryAlarms'>>(opts, COUNT_QUERY_ALARMS_QUERY, {
              condition: { duration, paging },
            })).queryAlarms?.msgs
          : (await graphqlPost<CountRaw<'getAlarm'>>(opts, COUNT_GET_ALARM_QUERY, { duration, paging }))
              .getAlarm?.msgs;
        return msgs ?? [];
      };

      let capped: { rows: CountRow[]; hasNext: boolean };
      try {
        if (!access || !catalog) {
          capped = await readPageWith(fetchCountRows, { pageNum: 1, pageSize: COUNT_FETCH_CAP });
        } else {
          const rowAccess = new AlarmRowAccess(access, catalogIndex(catalog));
          const page = await readFilteredPage(
            async (rows) => rowAccess.decide(await fetchCountRows({ pageNum: 1, pageSize: rows })),
            (d) => d.kept,
            { pageNum: 1, pageSize: COUNT_FETCH_CAP },
            ALARM_READ,
          );
          capped = { rows: page.rows.map((d) => d.row), hasNext: page.hasNext };
        }
      } catch (err) {
        return readFailed(reply, err);
      }

      const rows = capped.rows;
      const total = rows.length;
      const firing = rows.reduce((n, r) => n + (r.recoveryTime === null ? 1 : 0), 0);

      /* Group by (entity, rule); the incident's state is the LATEST
       * event's state. Matches the UI's `mergeIncidents` — keep both on
       * the same key. */
      const latestByGroup = new Map<string, { startTime: number; recoveryTime: number | null }>();
      for (const r of rows) {
        const key = alarmIncidentKey(r);
        const cur = latestByGroup.get(key);
        if (!cur || r.startTime > cur.startTime) {
          latestByGroup.set(key, { startTime: r.startTime, recoveryTime: r.recoveryTime });
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
        truncated: capped.hasNext,
        startTime: q.startTime,
        endTime: q.endTime,
        generatedAt: Date.now(),
      };
      return reply.send(body);
    },
  );

  /* Cascading-filter helper. Returns the service roster for one OAP
   * layer in alpha order so the UI populates a dropdown without
   * re-implementing the listServices wire. The instance + endpoint
   * pickers reuse the existing /api/layer/:key/instances and
   * /api/layer/:key/endpoints endpoints. */
  app.get(
    '/api/alarms/services',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = req.query as { layer?: unknown; page?: unknown } | undefined;
      const layer = query?.layer;
      if (!layer || typeof layer !== 'string') {
        return reply.code(400).send({ error: 'missing_layer' });
      }
      const pageId = typeof query?.page === 'string' && query.page !== '' && query.page !== ALERT_DEFAULT_PAGE_ID ? query.page : null;
      // A named page's filter offers only what its pins cover, as its list holds only that.
      let pagePins: AlarmPin[] | null = null;
      if (pageId) {
        const stored = await readStoredAlarmPages(deps.uiTemplateClient);
        if (stored.unreachable) return templateStoreUnreachable(reply);
        pagePins = namedPagePins(stored, pageId, pinReachOf(req.access));
        if (!pagePins) {
          return reply.code(404).send({ error: 'alarm_page_not_found', message: `No alarm page "${pageId}" is served to this user` });
        }
      }
      const signal = clientGone(reply);
      const opts = buildOapOpts(deps.config.current, deps.fetch, signal);
      try {
        const got = await graphqlPost<ListServicesRaw>(opts, LIST_SERVICES_QUERY, { layer });
        const listed = (got.listServices ?? [])
          .filter((s) => typeof s?.name === 'string' && s.name.length > 0)
          .sort((a, b) => a.name.localeCompare(b.name));
        const access = req.access;
        const readable = access ? access.filterRoster(['alarms:read'], layer, listed) : listed;
        const onLayer = canonicalLayerKey(layer);
        const services = pagePins
          ? readable.filter((s) => pagePins.some((p) => p.layer === onLayer && (!p.groups || p.groups.includes(s.group ?? ''))))
          : readable;
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
