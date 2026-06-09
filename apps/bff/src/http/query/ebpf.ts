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
 * eBPF profiling (kernel-level ON_CPU / OFF_CPU) routes.
 *
 *   GET  /api/layer/:key/ebpf/tasks?service=
 *        — list tasks + queryPrepareCreateEBPFProfilingTaskData metadata.
 *   POST /api/layer/:key/ebpf/tasks
 *        — create a fixed-time eBPF task.
 *   GET  /api/ebpf/tasks/:taskId/schedules
 *        — list per-process schedules captured by a task.
 *   POST /api/ebpf/analyze
 *        — resolve schedule + time-range data into stack trees.
 *
 * Network-profiling routes live alongside in {@link registerNetworkProfilingRoutes}.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  EBPFAnalyzeRequest,
  EBPFAnalyzeResponse,
  EBPFSchedulesResponse,
  EBPFTaskCreationRequest,
  EBPFTaskCreationResponse,
  EBPFTaskListResponse,
  FetchLike,
  NetworkProfilingCreateRequest,
  NetworkProfilingCreateResponse,
  NetworkProfilingKeepAliveResponse,
  ProcessRelationEndpointRef,
  ProcessRelationMetric,
  ProcessRelationMetricsResponse,
  ProcessTopologyResponse,
  TopologyMetricDef,
  UITemplateClient,
} from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import { graphqlPost, buildOapOpts } from '../../client/graphql.js';
import { withColdStage } from '../../util/duration.js';
import { fmtMinute, getServerOffsetMinutes } from '../../util/window.js';
import { processTopologyConfigFor, type ProcessTopologyConfig } from '../../logic/layers/loader.js';
import { parsePreviewProcessTopology } from '../../logic/layers/preview.js';
import { resolveEffectiveLayer } from '../../logic/layers/effective.js';

export interface EBPFRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
  /** OAP UI-template client — serve the in-use (remote-or-bundled) config. */
  uiTemplateClient?: () => UITemplateClient;
}

const LIST_SERVICES_FOR_RESOLVE = /* GraphQL */ `
  query ListServicesForEBPFResolve($layer: String!) {
    services: listServices(layer: $layer) {
      id
      name
      normal
    }
  }
`;

const QUERY_CREATE_TASK_DATA = /* GraphQL */ `
  query queryCreateTaskData($serviceId: ID!) {
    createTaskData: queryPrepareCreateEBPFProfilingTaskData(serviceId: $serviceId) {
      couldProfiling
      processLabels
    }
  }
`;

const QUERY_EBPF_TASKS = /* GraphQL */ `
  query queryEBPFTasks(
    $serviceId: ID
    $serviceInstanceId: ID
    $targets: [EBPFProfilingTargetType!]
    $triggerType: EBPFProfilingTriggerType
  ) {
    queryEBPFTasks: queryEBPFProfilingTasks(
      serviceId: $serviceId
      serviceInstanceId: $serviceInstanceId
      targets: $targets
      triggerType: $triggerType
    ) {
      taskId
      serviceName
      serviceId
      serviceInstanceId
      serviceInstanceName
      processLabels
      processName
      processId
      taskStartTime
      triggerType
      fixedTriggerDuration
      targetType
      createTime
      continuousProfilingCauses {
        type
        singleValue { threshold current }
        uri { uriRegex uriPath threshold current }
        message
      }
    }
  }
`;

const QUERY_EBPF_SCHEDULES = /* GraphQL */ `
  query queryEBPFSchedules($taskId: ID!) {
    eBPFSchedules: queryEBPFProfilingSchedules(taskId: $taskId) {
      scheduleId
      taskId
      process {
        id
        name
        serviceId
        serviceName
        instanceId
        instanceName
        agentId
        detectType
        attributes { name value }
        labels
      }
      startTime
      endTime
    }
  }
`;

const ANALYSIS_EBPF_RESULT = /* GraphQL */ `
  query analysisEBPF(
    $scheduleIdList: [ID!]!
    $timeRanges: [EBPFProfilingAnalyzeTimeRange!]!
    $aggregateType: EBPFProfilingAnalyzeAggregateType
  ) {
    analysisEBPFResult: analysisEBPFProfilingResult(
      scheduleIdList: $scheduleIdList
      timeRanges: $timeRanges
      aggregateType: $aggregateType
    ) {
      tip
      trees {
        elements { id parentId symbol stackType dumpCount }
      }
    }
  }
`;

const GET_PROCESS_TOPOLOGY = /* GraphQL */ `
  query getProcessTopology($serviceInstanceId: ID!, $duration: Duration!) {
    topology: getProcessTopology(serviceInstanceId: $serviceInstanceId, duration: $duration) {
      nodes {
        id
        name
        isReal
        serviceName
        serviceId
        serviceInstanceId
        serviceInstanceName
      }
      calls {
        id
        source
        target
        detectPoints
        sourceComponents
        targetComponents
      }
    }
  }
`;

const NEW_NETWORK_PROFILING = /* GraphQL */ `
  mutation newNetworkProfiling($request: EBPFProfilingNetworkTaskRequest!) {
    createEBPFNetworkProfiling(request: $request) {
      status
      errorReason
      id
    }
  }
`;

const KEEP_ALIVE_NETWORK_PROFILING = /* GraphQL */ `
  mutation aliveNetworkProfiling($taskId: ID!) {
    keepEBPFNetworkProfiling(taskId: $taskId) {
      status
      errorReason
    }
  }
`;

const CREATE_EBPF_FIXED_TASK = /* GraphQL */ `
  mutation createEBPFFixedTask($request: EBPFProfilingTaskFixedTimeCreationRequest!) {
    createTaskData: createEBPFProfilingFixedTimeTask(request: $request) {
      status
      errorReason
      id
    }
  }
`;

function softErr<T extends { reachable: boolean; error?: string }>(p: T, e: unknown): T {
  p.reachable = false;
  p.error = e instanceof Error ? e.message : String(e);
  return p;
}

/* ── Task-creation body caps ────────────────────────────────────────
 *
 * OAP's `EBPFProfilingMutationService.java` only enforces a *minimum*
 * duration (~5 min); without a server-side maximum a caller with
 * `profile:enable` could submit a 24-hour profile that pegs the target
 * instance's CPU. The bounds below match the booster-ui defaults and
 * the order of magnitude eBPF profiling is intended for.
 *
 *   eBPF fixed-time task     — duration in SECONDS, capped at 30 min.
 *   Network profiling samples — bounded list (max 8 entries), each
 *                               with optional size caps clamped to 64
 *                               KiB so a stray large value can't blow
 *                               OAP's serializer.
 */
const MAX_EBPF_DURATION_SEC = 30 * 60;
const MAX_PROCESS_LABELS = 32;
const MAX_LABEL_LEN = 128;
const VALID_EBPF_TARGETS = new Set(['ON_CPU', 'OFF_CPU', 'NETWORK']);

const MAX_NETWORK_SAMPLINGS = 8;
const MAX_URI_REGEX_LEN = 256;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_MIN_DURATION_MS = 60 * 60 * 1000;

function clampPositiveInt(v: unknown, max: number, fallback: number | null): number | null {
  if (v == null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(max, Math.round(v));
}

function clampNonNegativeInt(v: unknown, max: number): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
  return Math.min(max, Math.round(v));
}

function sanitiseProcessLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .map((s) => s.slice(0, MAX_LABEL_LEN))
    .slice(0, MAX_PROCESS_LABELS);
}

function sanitiseNetworkSamplings(
  raw: unknown,
): NetworkProfilingCreateRequest['samplings'] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_NETWORK_SAMPLINGS).map((entry) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const s = (e.settings ?? {}) as Record<string, unknown>;
    const settings: NetworkProfilingCreateRequest['samplings'][number]['settings'] = {
      requireCompleteRequest: s.requireCompleteRequest === true,
      requireCompleteResponse: s.requireCompleteResponse === true,
    };
    const maxReq = clampNonNegativeInt(s.maxRequestSize, MAX_PAYLOAD_BYTES);
    if (maxReq !== undefined) settings.maxRequestSize = maxReq;
    const maxResp = clampNonNegativeInt(s.maxResponseSize, MAX_PAYLOAD_BYTES);
    if (maxResp !== undefined) settings.maxResponseSize = maxResp;
    const out: NetworkProfilingCreateRequest['samplings'][number] = { settings };
    if (typeof e.uriRegex === 'string') {
      out.uriRegex = (e.uriRegex as string).slice(0, MAX_URI_REGEX_LEN);
    }
    if (typeof e.when4xx === 'boolean') out.when4xx = e.when4xx;
    if (typeof e.when5xx === 'boolean') out.when5xx = e.when5xx;
    const minDur = clampNonNegativeInt(e.minDuration, MAX_MIN_DURATION_MS);
    if (minDur !== undefined) out.minDuration = minDur;
    return out;
  });
}

async function resolveServiceId(
  opts: ReturnType<typeof buildOapOpts>,
  layerKey: string,
  serviceArg: string,
): Promise<string | null> {
  if (/^[A-Za-z0-9+/=]+\.\d+$/.test(serviceArg)) return serviceArg;
  const data = await graphqlPost<{
    services: Array<{ id: string; name: string; normal?: boolean }>;
  }>(opts, LIST_SERVICES_FOR_RESOLVE, { layer: layerKey.toUpperCase() });
  return (
    data.services.find((s) => s.name === serviceArg)?.id ??
    data.services.find((s) => s.id === serviceArg)?.id ??
    null
  );
}

// ── Process-relation metrics (network-profiling edge panel) ──────────

interface MqeEnv {
  error?: string | null;
  results?: Array<{ values?: Array<{ value: string | number | null }> }>;
}

/**
 * One `execExpression` fragment for a ProcessRelation metric. Like the
 * service-map relationFragment we deliberately omit `scope` — OAP infers
 * ProcessRelation + side from the metric name (`process_relation_client_*`
 * / `process_relation_server_*`). Names (not ids) key the entity: the
 * source/dest process is identified by service + instance + process name.
 */
function processRelationFragment(
  alias: string,
  expr: string,
  src: ProcessRelationEndpointRef,
  dst: ProcessRelationEndpointRef,
  w: { start: string; end: string },
  coldStage: boolean,
): string {
  const coldFrag = coldStage ? ', coldStage: true' : '';
  return (
    `${alias}: execExpression(\n` +
    `      expression: ${JSON.stringify(expr)},\n` +
    `      entity: {` +
    ` serviceName: ${JSON.stringify(src.serviceName)},` +
    ` normal: ${src.normal === false ? 'false' : 'true'},` +
    ` serviceInstanceName: ${JSON.stringify(src.serviceInstanceName)},` +
    ` processName: ${JSON.stringify(src.processName)},` +
    ` destServiceName: ${JSON.stringify(dst.serviceName)},` +
    ` destNormal: ${dst.normal === false ? 'false' : 'true'},` +
    ` destServiceInstanceName: ${JSON.stringify(dst.serviceInstanceName)},` +
    ` destProcessName: ${JSON.stringify(dst.processName)} },\n` +
    `      duration: { start: ${JSON.stringify(w.start)}, end: ${JSON.stringify(w.end)}, step: MINUTE${coldFrag} }\n` +
    `    ) { error results { values { value } } }`
  );
}

function relationSeries(env: MqeEnv | undefined): Array<number | null> {
  if (!env || env.error) return [];
  const values = env.results?.[0]?.values ?? [];
  return values.map((v) => {
    if (v.value === null || v.value === undefined) return null;
    const n = Number(v.value);
    return Number.isFinite(n) ? n : null;
  });
}

export function registerEBPFRoutes(app: FastifyInstance, deps: EBPFRouteDeps): void {
  const auth = requireAuth(deps);

  // ── list tasks + couldProfiling metadata ──────────────────────────
  app.get(
    '/api/layer/:key/ebpf/tasks',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const q = req.query as { service?: string };
      const serviceArg = (q.service ?? '').trim();
      const payload: EBPFTaskListResponse = {
        tasks: [],
        couldProfiling: false,
        processLabels: [],
        reachable: true,
      };
      if (!serviceArg) return reply.send(payload);
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      try {
        const serviceId = await resolveServiceId(opts, params.key, serviceArg);
        if (!serviceId) return reply.send(payload);

        const [meta, list] = await Promise.all([
          graphqlPost<{ createTaskData: { couldProfiling: boolean; processLabels: string[] } }>(
            opts,
            QUERY_CREATE_TASK_DATA,
            { serviceId },
          ).catch(() => ({ createTaskData: { couldProfiling: false, processLabels: [] } })),
          graphqlPost<{ queryEBPFTasks: EBPFTaskListResponse['tasks'] }>(opts, QUERY_EBPF_TASKS, {
            serviceId,
            targets: ['ON_CPU', 'OFF_CPU'],
            triggerType: 'FIXED_TIME',
          }),
        ]);
        payload.couldProfiling = meta.createTaskData?.couldProfiling ?? false;
        payload.processLabels = meta.createTaskData?.processLabels ?? [];
        payload.tasks = list.queryEBPFTasks ?? [];
        return reply.send(payload);
      } catch (err) {
        return reply.send(softErr(payload, err));
      }
    },
  );

  // ── create task ───────────────────────────────────────────────────
  app.post(
    '/api/layer/:key/ebpf/tasks',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const raw = (req.body ?? {}) as Partial<EBPFTaskCreationRequest>;
      const payload: EBPFTaskCreationResponse = { status: false, reachable: true };
      if (typeof raw.serviceId !== 'string' || !raw.serviceId) {
        payload.errorReason = 'missing serviceId';
        return reply.send(payload);
      }
      const targetType = typeof raw.targetType === 'string' && VALID_EBPF_TARGETS.has(raw.targetType)
        ? (raw.targetType as EBPFTaskCreationRequest['targetType'])
        : null;
      if (!targetType) {
        payload.errorReason = 'targetType must be ON_CPU, OFF_CPU, or NETWORK';
        return reply.send(payload);
      }
      const duration = clampPositiveInt(raw.duration, MAX_EBPF_DURATION_SEC, null);
      if (duration === null) {
        payload.errorReason = `duration is required and must be 1..${MAX_EBPF_DURATION_SEC} seconds`;
        return reply.send(payload);
      }
      const startTime =
        typeof raw.startTime === 'number' && Number.isFinite(raw.startTime) && raw.startTime > 0
          ? Math.round(raw.startTime)
          : Date.now();
      const sanitised: EBPFTaskCreationRequest = {
        serviceId: raw.serviceId,
        processLabels: sanitiseProcessLabels(raw.processLabels),
        startTime,
        duration,
        targetType,
      };
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      try {
        const data = await graphqlPost<{
          createTaskData: { status: boolean; errorReason?: string; id?: string };
        }>(opts, CREATE_EBPF_FIXED_TASK, { request: sanitised });
        payload.status = data.createTaskData?.status ?? false;
        payload.errorReason = data.createTaskData?.errorReason;
        payload.id = data.createTaskData?.id;
        return reply.send(payload);
      } catch (err) {
        return reply.send(softErr(payload, err));
      }
    },
  );

  // ── per-task schedules ────────────────────────────────────────────
  app.get(
    '/api/ebpf/tasks/:taskId/schedules',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { taskId: string };
      const payload: EBPFSchedulesResponse = { schedules: [], reachable: true };
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      try {
        const data = await graphqlPost<{ eBPFSchedules: EBPFSchedulesResponse['schedules'] }>(
          opts,
          QUERY_EBPF_SCHEDULES,
          { taskId: params.taskId },
        );
        payload.schedules = data.eBPFSchedules ?? [];
        return reply.send(payload);
      } catch (err) {
        return reply.send(softErr(payload, err));
      }
    },
  );

  // ── network profiling ─────────────────────────────────────────────
  /** List network-profile tasks for a service. Same OAP entry-point as
   *  ON_CPU/OFF_CPU tasks, with target=NETWORK. OAP stores network tasks
   *  with trigger FIXED_TIME (EBPFProfilingMutationService sets
   *  TriggerType.FIXED_TIME for createEBPFNetworkProfiling), so the
   *  list query must filter on FIXED_TIME — CONTINUOUS_PROFILING returns
   *  nothing and the just-created task never shows up. */
  app.get(
    '/api/layer/:key/ebpf/network/tasks',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const q = req.query as { service?: string; serviceInstance?: string };
      const serviceArg = (q.service ?? '').trim();
      const instanceArg = (q.serviceInstance ?? '').trim();
      const payload: EBPFTaskListResponse = {
        tasks: [],
        couldProfiling: true,
        processLabels: [],
        reachable: true,
      };
      if (!serviceArg && !instanceArg) return reply.send(payload);
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      try {
        const serviceId = serviceArg
          ? await resolveServiceId(opts, params.key, serviceArg)
          : null;
        const data = await graphqlPost<{ queryEBPFTasks: EBPFTaskListResponse['tasks'] }>(
          opts,
          QUERY_EBPF_TASKS,
          {
            serviceId: serviceId ?? undefined,
            serviceInstanceId: instanceArg || undefined,
            targets: ['NETWORK'],
            triggerType: 'FIXED_TIME',
          },
        );
        payload.tasks = data.queryEBPFTasks ?? [];
        return reply.send(payload);
      } catch (err) {
        return reply.send(softErr(payload, err));
      }
    },
  );

  /** Process-level topology for a service instance — the network
   *  profiling view's main visualization. */
  app.get(
    '/api/ebpf/network/topology',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = req.query as {
        serviceInstance?: string;
        windowMinutes?: string;
        startTime?: string;
        endTime?: string;
      };
      const instance = (q.serviceInstance ?? '').trim();
      const payload: ProcessTopologyResponse = { nodes: [], calls: [], reachable: true };
      if (!instance) return reply.send(payload);
      // Explicit start/end (ms epoch) takes precedence — used to pin the
      // topology to a finished task's capture window (the task's
      // instance only had eBPF processes reporting during that window,
      // and may since have been replaced). Falls back to a rolling
      // window for the live view when no task is selected.
      const startMsArg = Number(q.startTime);
      const endMsArg = Number(q.endTime);
      let startMs: number;
      let endMs: number;
      if (Number.isFinite(startMsArg) && Number.isFinite(endMsArg) && endMsArg > startMsArg) {
        startMs = startMsArg;
        endMs = endMsArg;
      } else {
        const minutes = Math.max(5, Math.min(180, Number(q.windowMinutes) || 30));
        endMs = Date.now();
        startMs = endMs - minutes * 60_000;
      }
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      const offset = await getServerOffsetMinutes(deps.config, deps.fetch);
      try {
        const data = await graphqlPost<{
          topology: { nodes: ProcessTopologyResponse['nodes']; calls: ProcessTopologyResponse['calls'] };
        }>(opts, GET_PROCESS_TOPOLOGY, {
          serviceInstanceId: instance,
          duration: withColdStage(req, {
            start: fmtMinute(startMs, offset),
            end: fmtMinute(endMs, offset),
            step: 'MINUTE',
          }),
        });
        payload.nodes = data.topology?.nodes ?? [];
        payload.calls = data.topology?.calls ?? [];
        return reply.send(payload);
      } catch (err) {
        return reply.send(softErr(payload, err));
      }
    },
  );

  /** Create a network-profile task on a specific service instance. */
  app.post(
    '/api/ebpf/network/tasks',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const raw = (req.body ?? {}) as Partial<NetworkProfilingCreateRequest>;
      const payload: NetworkProfilingCreateResponse = { status: false, reachable: true };
      if (typeof raw.instanceId !== 'string' || !raw.instanceId) {
        payload.errorReason = 'missing instanceId';
        return reply.send(payload);
      }
      const sanitised: NetworkProfilingCreateRequest = {
        instanceId: raw.instanceId,
        samplings: sanitiseNetworkSamplings(raw.samplings),
      };
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      try {
        const data = await graphqlPost<{
          createEBPFNetworkProfiling: { status: boolean; errorReason?: string; id?: string };
        }>(opts, NEW_NETWORK_PROFILING, { request: sanitised });
        payload.status = data.createEBPFNetworkProfiling?.status ?? false;
        payload.errorReason = data.createEBPFNetworkProfiling?.errorReason;
        payload.id = data.createEBPFNetworkProfiling?.id;
        return reply.send(payload);
      } catch (err) {
        return reply.send(softErr(payload, err));
      }
    },
  );

  /** Keep-alive ping for a continuous-profiling network task — without
   *  it OAP will close the task after the configured timeout. */
  app.post(
    '/api/ebpf/network/tasks/:taskId/keep-alive',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { taskId: string };
      const payload: NetworkProfilingKeepAliveResponse = { status: false, reachable: true };
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      try {
        const data = await graphqlPost<{
          keepEBPFNetworkProfiling: { status: boolean; errorReason?: string };
        }>(opts, KEEP_ALIVE_NETWORK_PROFILING, { taskId: params.taskId });
        payload.status = data.keepEBPFNetworkProfiling?.status ?? false;
        payload.errorReason = data.keepEBPFNetworkProfiling?.errorReason;
        return reply.send(payload);
      } catch (err) {
        return reply.send(softErr(payload, err));
      }
    },
  );

  // ── analyze ───────────────────────────────────────────────────────
  app.post(
    '/api/ebpf/analyze',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as EBPFAnalyzeRequest | undefined;
      const payload: EBPFAnalyzeResponse = { tip: null, trees: [], reachable: true };
      if (!body || !body.scheduleIdList?.length || !body.timeRanges?.length) {
        return reply.send(payload);
      }
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      try {
        const data = await graphqlPost<{
          analysisEBPFResult: { tip: string | null; trees: EBPFAnalyzeResponse['trees'] };
        }>(opts, ANALYSIS_EBPF_RESULT, {
          scheduleIdList: body.scheduleIdList,
          timeRanges: body.timeRanges,
          aggregateType: body.aggregateType,
        });
        payload.tip = data.analysisEBPFResult?.tip ?? null;
        payload.trees = data.analysisEBPFResult?.trees ?? [];
        return reply.send(payload);
      } catch (err) {
        return reply.send(softErr(payload, err));
      }
    },
  );

  /** Process-relation metrics for a clicked edge in the network-
   *  profiling process topology. Resolves the layer's processTopology
   *  MQE config (operator override or bundled default), evaluates every
   *  client + server metric under the ProcessRelation scope for the
   *  source→dest process pair, and returns the per-bucket series for the
   *  edge detail panel. */
  app.post(
    '/api/layer/:key/ebpf/network/process-relation-metrics',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const body = req.body as
        | {
            source?: ProcessRelationEndpointRef;
            dest?: ProcessRelationEndpointRef;
            /** Profiling-task window (ms epoch). Preferred — the metrics
             *  only exist for the span the task actually ran. */
            startTime?: number;
            endTime?: number;
            /** Fallback when no task window is supplied. */
            windowMinutes?: number;
            /** Admin preview: the operator's draft `processTopology` block. */
            previewConfig?: string;
          }
        | undefined;
      const payload: ProcessRelationMetricsResponse = { client: [], server: [], reachable: true };
      const src = body?.source;
      const dst = body?.dest;
      if (!src?.processName || !dst?.processName) {
        payload.error = 'missing source/dest process';
        return reply.send(payload);
      }

      // Admin Preview: render the draft `processTopology` block (bypasses
      // remote resolve + block); else the remote-or-default config.
      const previewPt = parsePreviewProcessTopology(body?.previewConfig);
      let cfg: ProcessTopologyConfig;
      if (previewPt) {
        cfg = previewPt;
      } else {
        const eff = await resolveEffectiveLayer(deps.uiTemplateClient, params.key);
        if (eff.blocked) {
          // Template store unreachable / layer disabled — block, no defaults.
          return reply.send(payload);
        }
        cfg = processTopologyConfigFor(eff.template);
      }
      // Prefer the profiling-task time range (the data only exists for
      // that span). Fall back to a rolling window when none is given.
      let startMs: number;
      let endMs: number;
      if (body?.startTime && body?.endTime && body.endTime > body.startTime) {
        startMs = body.startTime;
        endMs = body.endTime;
      } else {
        const minutes = Math.max(5, Math.min(180, Number(body?.windowMinutes) || 30));
        endMs = Date.now();
        startMs = endMs - minutes * 60_000;
      }
      // Match the network-topology route's OAP-local formatting so the
      // edge metrics window lines up with the rendered graph window.
      const offset = await getServerOffsetMinutes(deps.config, deps.fetch);
      const w = { start: fmtMinute(startMs, offset), end: fmtMinute(endMs, offset) };

      // Build one aliased execExpression per metric across both sides.
      const aliasMap = new Map<string, { side: 'client' | 'server'; metric: TopologyMetricDef }>();
      const fragments: string[] = [];
      const push = (side: 'client' | 'server', list: TopologyMetricDef[]) => {
        list.forEach((m, i) => {
          const alias = `${side}_${i}`;
          aliasMap.set(alias, { side, metric: m });
          fragments.push(processRelationFragment(alias, m.mqe, src, dst, w, !!req.coldStage));
        });
      };
      push('client', cfg.edgeClientMetrics);
      push('server', cfg.edgeServerMetrics);
      if (fragments.length === 0) return reply.send(payload);

      const query = `query HorizonProcessRelationMetrics {\n  ${fragments.join('\n  ')}\n}`;
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      try {
        const raw = await graphqlPost<Record<string, MqeEnv>>(opts, query);
        for (const [alias, { side, metric }] of aliasMap) {
          const out: ProcessRelationMetric = {
            id: metric.id,
            label: metric.label,
            unit: metric.unit,
            values: relationSeries(raw[alias]),
          };
          if (side === 'client') payload.client.push(out);
          else payload.server.push(out);
        }
        return reply.send(payload);
      } catch (err) {
        return reply.send(softErr(payload, err));
      }
    },
  );
}
