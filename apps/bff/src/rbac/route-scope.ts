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
 * Which layer and which services each data route reads, so the gate can check
 * them before the handler runs.
 *
 * `ROUTE_POLICY` says WHAT a route needs (a verb). This table says WHERE: the
 * URL's layer, and every request field that names a service or something a
 * service owns. The gate resolves each one and asks {@link RequestAccess}
 * whether the caller may read it with the route's verb. Every route whose verb
 * can carry a layer (`LAYER_SCOPED_VERBS`) must have an entry — registration
 * throws otherwise, the same contract `ROUTE_POLICY` holds — so a new data
 * route cannot ship without saying what it reads.
 *
 * What the gate cannot see from the request is the handler's to check, and
 * the entry says so in `handler`: rosters it filters, trace ids it resolves.
 */

import type { FastifyRequest } from 'fastify';
import { isExactIdentity } from './request-access.js';

type Where = 'query' | 'body' | 'params';

interface Field {
  at: Where;
  name: string;
}

/** A request field that names a service, or something one service owns. */
export type IdSpec =
  /** An OAP service id. */
  | { serviceId: Field }
  /** Comma-separated service ids (topology seeds). */
  | { serviceIds: Field }
  /** A service name; `normal` names the field carrying its flag, if any. */
  | { serviceName: Field; normal?: Field }
  /** Either a service id or a name. */
  | { serviceIdOrName: Field }
  /** An instance / endpoint / browser-version / page-path id — `<serviceId>_…`. */
  | { childId: Field }
  /** An array of such ids. */
  | { childIds: Field }
  /** A trace / async / pprof profiling task id — `<createTime>_<serviceId>`. */
  | { taskId: Field }
  /** An MQE `Entity` object: its service, and its `dest*` side. */
  | { entity: Field }
  /** A list of `{ name, normal }` services (the 3D map). */
  | { serviceList: Field }
  /** `{ serviceName, normal? }` objects (process-relation ends); `normal` defaults to true. */
  | { processEnd: Field }
  /** A service id, or when it is absent an id-or-name — the one the handler
   *  queries when a request carries both. */
  | { serviceIdElse: Field; idOrName: Field };

export interface ScopeRule {
  /** The route's URL carries the layer as `:key`; the caller must reach it. */
  layer?: boolean;
  /** The layer the data belongs to whatever the URL names; the caller must
   *  reach it too. */
  fixedLayer?: string;
  /** Every identity present must be readable by the caller. */
  ids?: readonly IdSpec[];
  /** Two ends of one relation: reading either end is enough. */
  relation?: readonly IdSpec[];
  /** With no service named, the OAP query reads EVERY service. A caller
   *  whose verb is layer-limited must name one. A function decides it per
   *  request, for a route where only some request shapes read every service. */
  requireService?: boolean | ((req: FastifyRequest) => boolean);
  /** Request shapes a layer-limited caller may not use: a store with no
   *  service scoping, or an id the BFF cannot attribute to a service. */
  limitedDenied?: (req: FastifyRequest) => string | null;
  /** A field carrying a draft template to evaluate — the editor's preview.
   *  Running it needs `layer-template:write`, whoever else may read. */
  preview?: Field;
  /** What the handler checks itself with `req.access`. Documentation for the
   *  reader; the gate does nothing with it. */
  handler?: string;
}

const q = (name: string): Field => ({ at: 'query', name });
const b = (name: string): Field => ({ at: 'body', name });
const p = (name: string): Field => ({ at: 'params', name });

/** The `serviceId` a service picker sends. Its `service` name rides along as
 *  an echo these handlers never query by, so it is not checked: a name can
 *  mean both a real and a conjectured service, and checking it would refuse a
 *  caller the one service the request actually reads. */
const byId = (at: (n: string) => Field): IdSpec[] => [{ serviceId: at('serviceId') }];

const evaluationEnds: IdSpec[] = [
  { serviceId: b('providerId') },
  { childId: b('modelId') },
  // The handler reads `service` only when `serviceId` is absent.
  { serviceIdElse: b('serviceId'), idOrName: b('service') },
];

function bodyOf(req: FastifyRequest): Record<string, unknown> {
  return req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
}

function queryOf(req: FastifyRequest): Record<string, unknown> {
  return req.query && typeof req.query === 'object' ? (req.query as Record<string, unknown>) : {};
}

export const ROUTE_SCOPE: Record<string, ScopeRule> = {
  // ── Navigation ──
  'GET /api/menu': { handler: 'drops layers and group entries the caller cannot reach' },

  // ── Traces ──
  // A trace crosses services and layers by nature, so the BFF narrows no trace
  // store and no lookup by id: only the native list's picked service — the
  // page's own service — is checked, and a Zipkin service name is Zipkin's.
  'POST /api/layer/:key/traces': {
    layer: true,
    ids: [{ serviceId: b('serviceId') }, { childId: b('instanceId') }, { childId: b('endpointId') }],
    // Only the native `traceId` narrows the native query; `traceIds` is the
    // Zipkin half's, and the native half ignores it. OAP drops a blank trace
    // id and lists every service's traces, so only an exact one counts.
    requireService: (req) => {
      const body = bodyOf(req);
      return body.source !== 'zipkin' && !(typeof body.traceId === 'string' && isExactIdentity(body.traceId));
    },
    preview: b('previewConfig'),
  },
  'GET /api/trace/:traceId': {},

  // ── Logs ──
  'POST /api/layer/:key/logs': {
    layer: true,
    ids: [...byId(b), { childId: b('serviceInstanceId') }, { childId: b('endpointId') }],
    requireService: true,
  },
  'POST /api/layer/:key/logs/facets': {
    layer: true,
    ids: [...byId(b), { childId: b('serviceInstanceId') }, { childId: b('endpointId') }],
    requireService: true,
  },
  'GET /api/layer/:key/pod-logs/containers': { layer: true, ids: [{ childId: q('instance') }], requireService: true },
  'POST /api/layer/:key/pod-logs': { layer: true, ids: [{ childId: b('serviceInstanceId') }], requireService: true },
  // A record is one call from an application service to a GenAI provider: the
  // provider's owner reads all its callers, a caller's owner its own calls.
  'POST /api/layer/:key/evaluation-records': {
    layer: true,
    fixedLayer: 'VIRTUAL_GENAI',
    relation: evaluationEnds,
    requireService: true,
  },
  'POST /api/layer/:key/evaluation-records/facets': {
    layer: true,
    fixedLayer: 'VIRTUAL_GENAI',
    relation: evaluationEnds,
    requireService: true,
  },
  'GET /api/evaluation-record/caller-services': { handler: 'keeps the services the caller may read' },

  // ── Browser errors ──
  'POST /api/layer/:key/browser-errors': {
    layer: true,
    ids: [...byId(b), { childId: b('serviceVersionId') }, { childId: b('pagePathId') }],
    requireService: true,
  },

  // ── Events, alarms ──
  'POST /api/events': { ids: [{ serviceName: b('service') }], requireService: true },
  // OAP cannot narrow an alarm read to a set of services, so a read that
  // names none reads every alarm and the handler keeps the caller's rows. A
  // service named alone is read the same way, the handler keeping its rows.
  'GET /api/alarms': {
    ids: [{ serviceName: q('service'), normal: q('normal') }],
    handler:
      'with no service, keeps the alarms of services the caller may read; with a service alone, the alarms that concern it; ' +
      'with a page, only those its pins, as served to the caller, cover',
  },
  'GET /api/alarms/count': { handler: 'counts only the alarms of services the caller may read' },
  'GET /api/alarms/services': { handler: 'keeps the services of the layer the caller may read' },
  'GET /api/alarms/pages': { handler: 'lists the alarm pages whose pins the caller reaches, each narrowed to them' },

  // ── AI agent conversations ──
  'POST /api/layer/:key/ai-conversations': { layer: true, ids: [{ serviceName: b('service') }], requireService: true },
  'GET /api/ai-conversation/:conversation/view': { ids: [{ serviceName: q('service') }], requireService: true },
  'GET /api/ai-conversation/:conversation/files': { ids: [{ serviceName: q('service') }], requireService: true },

  // ── Metrics ──
  'POST /api/layer/:key/dashboard': {
    layer: true,
    handler: 'checks the service it picks from this layer\'s roster, by name, id or default',
  },
  'POST /api/mqe/exec': {
    ids: [{ entity: b('entity') }],
    handler: 'an expression with no service reads every service: needs inspect:read',
  },
  'GET /api/layer/:key/dashboard/config': { layer: true },
  'POST /api/layer/:key/landing': {
    layer: true,
    handler: 'keeps the caller\'s services; layer-wide totals only for callers who read the whole layer',
  },
  'GET /api/layer/:key/instances': { layer: true, ids: byId(q), requireService: true },
  'GET /api/layer/:key/endpoints': { layer: true, ids: byId(q), requireService: true },
  'GET /api/layer/:key/services': { layer: true, handler: 'keeps the services the caller may read' },

  // ── Topology ──
  'GET /api/layer/:key/topology': {
    layer: true,
    ids: [{ serviceIds: q('serviceId') }],
    preview: q('previewConfig'),
    handler: 'with no service, seeds only the services the caller may read',
  },
  'GET /api/layer/:key/service-hierarchy': { layer: true, ids: [{ serviceId: q('serviceId') }], requireService: true },
  'GET /api/layer/:key/instance-topology': {
    layer: true,
    relation: [{ serviceId: q('client') }, { serviceId: q('server') }],
    requireService: true,
    preview: q('previewConfig'),
  },
  'GET /api/layer/:key/deployment': { layer: true, ids: byId(q), requireService: true, preview: q('previewConfig') },
  'GET /api/layer/:key/endpoint-dependency': {
    layer: true,
    ids: [...byId(q), { childId: q('endpoint') }],
    requireService: true,
    preview: q('previewConfig'),
  },

  // ── Profiling ──
  'GET /api/layer/:key/profile/tasks': { layer: true, ids: byId(q), requireService: true },
  'POST /api/layer/:key/profile/tasks': { layer: true, ids: [{ serviceId: b('serviceId') }], requireService: true },
  'GET /api/profile/tasks/:taskId/segments': { ids: [{ taskId: p('taskId') }], requireService: true },
  'GET /api/profile/tasks/:taskId/logs': { ids: [{ taskId: p('taskId') }], requireService: true },
  'POST /api/profile/analyze': { limitedDenied: () => 'segment_ids_name_no_service' },
  'GET /api/layer/:key/async/tasks': { layer: true, ids: byId(q), requireService: true },
  'POST /api/layer/:key/async/tasks': {
    layer: true,
    ids: [{ serviceId: b('serviceId') }, { childIds: b('serviceInstanceIds') }],
    requireService: true,
  },
  'GET /api/async/tasks/:taskId/progress': { ids: [{ taskId: p('taskId') }], requireService: true },
  'POST /api/async/analyze': {
    ids: [{ taskId: b('taskId') }, { childIds: b('instanceIds') }],
    requireService: true,
  },
  'GET /api/layer/:key/pprof/tasks': { layer: true, ids: byId(q), requireService: true },
  'POST /api/layer/:key/pprof/tasks': {
    layer: true,
    ids: [{ serviceId: b('serviceId') }, { childIds: b('serviceInstanceIds') }],
    requireService: true,
  },
  'GET /api/pprof/tasks/:taskId/progress': { ids: [{ taskId: p('taskId') }], requireService: true },
  'POST /api/pprof/analyze': {
    ids: [{ taskId: b('taskId') }, { childIds: b('instanceIds') }],
    requireService: true,
  },
  'GET /api/layer/:key/ebpf/tasks': { layer: true, ids: byId(q), requireService: true },
  'POST /api/layer/:key/ebpf/tasks': { layer: true, ids: [{ serviceId: b('serviceId') }], requireService: true },
  'GET /api/ebpf/tasks/:taskId/schedules': {
    handler: 'keeps the schedules whose process belongs to a service the caller may read',
  },
  'POST /api/ebpf/analyze': { limitedDenied: () => 'schedule_ids_name_no_service' },
  'GET /api/layer/:key/ebpf/network/tasks': {
    layer: true,
    ids: [...byId(q), { childId: q('serviceInstance') }],
    requireService: true,
  },
  'GET /api/ebpf/network/topology': { ids: [{ childId: q('serviceInstance') }], requireService: true },
  'GET /api/ebpf/network/processes': { ids: [{ childId: q('serviceInstance') }], requireService: true },
  'POST /api/ebpf/network/tasks': { ids: [{ childId: b('instanceId') }], requireService: true },
  'POST /api/ebpf/network/tasks/:taskId/keep-alive': { limitedDenied: () => 'task_id_names_no_service' },
  'POST /api/layer/:key/ebpf/network/process-relation-metrics': {
    layer: true,
    // An edge between two processes opens for a role that reads either end,
    // as the instance map does.
    relation: [{ processEnd: b('source') }, { processEnd: b('dest') }],
    requireService: true,
    preview: b('previewConfig'),
  },
  'GET /api/continuous-profiling/policy-summary': {
    handler: 'summarises only the services of the layer the caller may read',
  },
  'GET /api/continuous-profiling/policies': { ids: byId(q), requireService: true },
  'POST /api/continuous-profiling/policies': { ids: [{ serviceId: b('serviceId') }], requireService: true },
  'GET /api/continuous-profiling/instances': { ids: byId(q), requireService: true },

  // ── The 3D map: its own verb, but its services are still services ──
  'POST /api/infra-3d/metrics': { ids: [{ serviceList: b('services') }] },

  // ── Trace stores and their autocomplete: traces cross layers ──
  ...Object.fromEntries(
    [
      'GET /api/zipkin/services',
      'GET /api/zipkin/spans',
      'GET /api/zipkin/remote-services',
      'GET /api/zipkin/traces',
      'GET /api/zipkin/trace/:traceId',
      'GET /api/zipkin/autocomplete/keys',
      'GET /api/zipkin/autocomplete/values',
      'GET /api/traceql/sources',
      'GET /api/traceql/:ds/search',
      'GET /api/traceql/:ds/trace/:traceId',
      'GET /api/traceql/:ds/tags',
      'GET /api/traceql/:ds/tag-values',
      'GET /api/trace-tags/keys',
      'GET /api/trace-tags/values',
    ].map((route): [string, ScopeRule] => [route, {}]),
  ),

  // ── Reads that name no service the BFF can check: whole-deployment only ──
  ...Object.fromEntries(
    [
      'GET /api/log-tags/keys',
      'GET /api/log-tags/values',
      // Source maps are not attributed to a browser app: a map holds the
      // original source of whichever app it was built from.
      'GET /api/browser-errors/source-maps',
      'POST /api/browser-errors/resolve',
    ].map((route): [string, ScopeRule] => [route, { limitedDenied: () => 'not_attributable_to_a_service' }]),
  ),
};

export function fieldValue(req: FastifyRequest, f: Field): unknown {
  const src = f.at === 'body' ? bodyOf(req) : f.at === 'query' ? queryOf(req) : (req.params as Record<string, unknown>);
  return src?.[f.name];
}
