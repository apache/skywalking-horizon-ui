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
 * Async profiler (Java) + pprof (Go) routes.
 *
 *   GET  /api/layer/:key/async/tasks?service=
 *   POST /api/layer/:key/async/tasks
 *   GET  /api/async/tasks/:taskId/progress
 *   POST /api/async/analyze
 *
 *   GET  /api/layer/:key/pprof/tasks?service=
 *   POST /api/layer/:key/pprof/tasks
 *   GET  /api/pprof/tasks/:taskId/progress
 *   POST /api/pprof/analyze
 *
 * The two clients use distinct OAP entry points (`queryAsyncProfilerTask*`
 * vs `queryPprofTask*`) but share request/response *shape*, so the route
 * implementations are mostly templated.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  AsyncProfilingAnalyzeResponse,
  AsyncProfilingEvent,
  AsyncProfilingProgressResponse,
  AsyncProfilingTaskCreationRequest,
  AsyncProfilingTaskCreationResponse,
  AsyncProfilingTaskListResponse,
  FetchLike,
  PprofAnalyzeResponse,
  PprofProgressResponse,
  PprofTaskCreationRequest,
  PprofTaskCreationResponse,
  PprofTaskListResponse,
} from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import { graphqlPost, buildOapOpts } from '../../client/graphql.js';

export interface AsyncProfileRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
}

/** Bound the per-service task-list page. Default 500 is enough for the
 *  Profiling tab's "recent tasks" rail; large fleets can opt up to 5000
 *  via `?limit=`. The OAP query carries no built-in cap, so an unbounded
 *  default would page-fault the BFF on services with years of history. */
const DEFAULT_TASK_LIST_LIMIT = 500;
const MAX_TASK_LIST_LIMIT = 5000;
function clampTaskListLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_TASK_LIST_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TASK_LIST_LIMIT;
  return Math.min(Math.floor(n), MAX_TASK_LIST_LIMIT);
}

/** Per-task caps for async-profiler / pprof bodies. OAP itself only
 *  rejects `duration <= 0`, so without these a caller with `profile:enable`
 *  could submit an hours-long profile that pegs the target instance's
 *  CPU. Caps match the booster-ui defaults: 600s = 10 min duration; up
 *  to 32 target instances per task; up to 8 event types. */
const MAX_ASYNC_DURATION_SEC = 600;
const MAX_PPROF_DURATION_SEC = 600;
const MAX_PPROF_DUMP_PERIOD_SEC = 60;
const MAX_TARGET_INSTANCES = 32;
const MAX_EVENTS_PER_TASK = 8;
const MAX_EXEC_ARGS_LEN = 256;

function clampPositiveInt(v: unknown, max: number, fallback: number | null): number | null {
  if (v == null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(max, Math.round(v));
}

function clampInstanceIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return ids
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .slice(0, MAX_TARGET_INSTANCES);
}

function clampEvents<E extends string>(events: unknown): E[] {
  if (Array.isArray(events)) {
    return events.filter((s): s is E => typeof s === 'string').slice(0, MAX_EVENTS_PER_TASK);
  }
  if (typeof events === 'string') return [events as E];
  return [];
}

function clampExecArgs(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  return v.slice(0, MAX_EXEC_ARGS_LEN);
}

const LIST_SERVICES_FOR_RESOLVE = /* GraphQL */ `
  query ListServicesForAsyncResolve($layer: String!) {
    services: listServices(layer: $layer) {
      id
      name
      normal
    }
  }
`;

const GET_ASYNC_TASK_LIST = /* GraphQL */ `
  query GetAsyncTaskList($request: AsyncProfilerTaskListRequest!) {
    asyncTaskList: queryAsyncProfilerTaskList(request: $request) {
      errorReason
      tasks {
        id
        serviceId
        serviceInstanceIds
        createTime
        events
        duration
        execArgs
      }
    }
  }
`;

const GET_ASYNC_PROGRESS = /* GraphQL */ `
  query GetAsyncProgress($taskId: String!) {
    taskProgress: queryAsyncProfilerTaskProgress(taskId: $taskId) {
      logs { id instanceId instanceName operationType operationTime }
      errorInstanceIds
      successInstanceIds
    }
  }
`;

const CREATE_ASYNC_TASK = /* GraphQL */ `
  mutation CreateAsyncTask($asyncProfilerTaskCreationRequest: AsyncProfilerTaskCreationRequest!) {
    task: createAsyncProfilerTask(asyncProfilerTaskCreationRequest: $asyncProfilerTaskCreationRequest) {
      id
      errorReason
      code
    }
  }
`;

const GET_ASYNC_ANALYZE = /* GraphQL */ `
  query GetAsyncAnalyze($request: AsyncProfilerAnalyzationRequest!) {
    analysisResult: queryAsyncProfilerAnalyze(request: $request) {
      tree {
        type
        elements { id parentId symbol: codeSignature dumpCount: total self }
      }
    }
  }
`;

// pprof queries: same shape as async, different OAP entry points.
const GET_PPROF_TASK_LIST = /* GraphQL */ `
  query GetPprofTaskList($request: PprofTaskListRequest!) {
    pprofTaskList: queryPprofTaskList(request: $request) {
      errorReason
      tasks {
        id
        serviceId
        serviceInstanceIds
        createTime
        events
        duration
        dumpPeriod
      }
    }
  }
`;

const GET_PPROF_PROGRESS = /* GraphQL */ `
  query GetPprofProgress($taskId: String!) {
    taskProgress: queryPprofTaskProgress(taskId: $taskId) {
      logs { id instanceId instanceName operationType operationTime }
      errorInstanceIds
      successInstanceIds
    }
  }
`;

const CREATE_PPROF_TASK = /* GraphQL */ `
  mutation CreatePprofTask($pprofTaskCreationRequest: PprofTaskCreationRequest!) {
    task: createPprofTask(pprofTaskCreationRequest: $pprofTaskCreationRequest) {
      id
      errorReason
      code
    }
  }
`;

const GET_PPROF_ANALYZE = /* GraphQL */ `
  query GetPprofAnalyze($request: PprofAnalyzationRequest!) {
    analysisResult: queryPprofAnalyze(request: $request) {
      tree {
        elements { id parentId symbol: codeSignature dumpCount: total self }
      }
    }
  }
`;

function softErr<T extends { reachable: boolean; error?: string }>(p: T, e: unknown): T {
  p.reachable = false;
  p.error = e instanceof Error ? e.message : String(e);
  return p;
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

export function registerAsyncProfileRoutes(
  app: FastifyInstance,
  deps: AsyncProfileRouteDeps,
): void {
  const auth = requireAuth(deps);

  app.get(
    '/api/layer/:key/async/tasks',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const q = req.query as { service?: string; limit?: string };
      const serviceArg = (q.service ?? '').trim();
      const payload: AsyncProfilingTaskListResponse = { tasks: [], reachable: true };
      if (!serviceArg) return reply.send(payload);
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      const limit = clampTaskListLimit(q.limit);
      try {
        const serviceId = await resolveServiceId(opts, params.key, serviceArg);
        if (!serviceId) return reply.send(payload);
        const data = await graphqlPost<{
          asyncTaskList: { errorReason?: string; tasks: AsyncProfilingTaskListResponse['tasks'] };
        }>(opts, GET_ASYNC_TASK_LIST, { request: { serviceId, limit } });
        payload.tasks = data.asyncTaskList?.tasks ?? [];
        payload.errorReason = data.asyncTaskList?.errorReason;
        return reply.send(payload);
      } catch (err) {
        return reply.send(softErr(payload, err));
      }
    },
  );
  app.post(
    '/api/layer/:key/async/tasks',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const raw = (req.body ?? {}) as Partial<AsyncProfilingTaskCreationRequest>;
      const payload: AsyncProfilingTaskCreationResponse = { reachable: true };
      if (typeof raw.serviceId !== 'string' || !raw.serviceId) {
        payload.errorReason = 'missing serviceId';
        return reply.send(payload);
      }
      const duration = clampPositiveInt(raw.duration, MAX_ASYNC_DURATION_SEC, null);
      if (duration === null) {
        payload.errorReason = `duration is required and must be 1..${MAX_ASYNC_DURATION_SEC} seconds`;
        return reply.send(payload);
      }
      // Sanitised body — OAP gets exactly the fields it expects, all
      // bounded. Unknown keys are dropped.
      const sanitised: AsyncProfilingTaskCreationRequest = {
        serviceId: raw.serviceId,
        serviceInstanceIds: clampInstanceIds(raw.serviceInstanceIds),
        duration,
        events: clampEvents<AsyncProfilingEvent>(raw.events),
        ...(clampExecArgs(raw.execArgs) !== undefined ? { execArgs: clampExecArgs(raw.execArgs)! } : {}),
      };
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      try {
        const data = await graphqlPost<{
          task: { id?: string; errorReason?: string; code?: string };
        }>(opts, CREATE_ASYNC_TASK, { asyncProfilerTaskCreationRequest: sanitised });
        payload.id = data.task?.id;
        payload.code = data.task?.code;
        payload.errorReason = data.task?.errorReason;
        return reply.send(payload);
      } catch (err) {
        return reply.send(softErr(payload, err));
      }
    },
  );
  app.get(
    '/api/async/tasks/:taskId/progress',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { taskId: string };
      const payload: AsyncProfilingProgressResponse = { progress: null, reachable: true };
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      try {
        const data = await graphqlPost<{
          taskProgress: AsyncProfilingProgressResponse['progress'];
        }>(opts, GET_ASYNC_PROGRESS, { taskId: params.taskId });
        payload.progress = data.taskProgress ?? null;
        return reply.send(payload);
      } catch (err) {
        return reply.send(softErr(payload, err));
      }
    },
  );
  app.post(
    '/api/async/analyze',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as
        | { taskId: string; instanceIds: string[]; eventType: string }
        | undefined;
      const payload: AsyncProfilingAnalyzeResponse = { tree: null, reachable: true };
      if (!body?.taskId || !body.instanceIds?.length) return reply.send(payload);
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      try {
        const data = await graphqlPost<{
          analysisResult: { tree: AsyncProfilingAnalyzeResponse['tree'] } | null;
        }>(opts, GET_ASYNC_ANALYZE, { request: body });
        payload.tree = data.analysisResult?.tree ?? null;
        return reply.send(payload);
      } catch (err) {
        return reply.send(softErr(payload, err));
      }
    },
  );

  app.get(
    '/api/layer/:key/pprof/tasks',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const q = req.query as { service?: string; limit?: string };
      const serviceArg = (q.service ?? '').trim();
      const payload: PprofTaskListResponse = { tasks: [], reachable: true };
      if (!serviceArg) return reply.send(payload);
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      const limit = clampTaskListLimit(q.limit);
      try {
        const serviceId = await resolveServiceId(opts, params.key, serviceArg);
        if (!serviceId) return reply.send(payload);
        const data = await graphqlPost<{
          pprofTaskList: { errorReason?: string; tasks: PprofTaskListResponse['tasks'] };
        }>(opts, GET_PPROF_TASK_LIST, { request: { serviceId, limit } });
        payload.tasks = data.pprofTaskList?.tasks ?? [];
        payload.errorReason = data.pprofTaskList?.errorReason;
        return reply.send(payload);
      } catch (err) {
        return reply.send(softErr(payload, err));
      }
    },
  );
  app.post(
    '/api/layer/:key/pprof/tasks',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const raw = (req.body ?? {}) as Partial<PprofTaskCreationRequest>;
      const payload: PprofTaskCreationResponse = { reachable: true };
      if (typeof raw.serviceId !== 'string' || !raw.serviceId) {
        payload.errorReason = 'missing serviceId';
        return reply.send(payload);
      }
      // pprof events that require a duration: CPU / BLOCK / MUTEX. Other
      // events (HEAP / GOROUTINE / ALLOCS / THREADCREATE) are point-in-
      // time and don't carry duration. Forward whatever the caller sent,
      // clamped when present so the same upper bound applies.
      const sanitised: PprofTaskCreationRequest = {
        serviceId: raw.serviceId,
        serviceInstanceIds: clampInstanceIds(raw.serviceInstanceIds),
        events: typeof raw.events === 'string' ? raw.events : '',
        ...(raw.duration !== undefined
          ? { duration: clampPositiveInt(raw.duration, MAX_PPROF_DURATION_SEC, null) ?? 0 }
          : {}),
        ...(raw.dumpPeriod !== undefined
          ? {
              dumpPeriod:
                clampPositiveInt(raw.dumpPeriod, MAX_PPROF_DUMP_PERIOD_SEC, null) ?? 1,
            }
          : {}),
      };
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      try {
        const data = await graphqlPost<{
          task: { id?: string; errorReason?: string; code?: string };
        }>(opts, CREATE_PPROF_TASK, { pprofTaskCreationRequest: sanitised });
        payload.id = data.task?.id;
        payload.code = data.task?.code;
        payload.errorReason = data.task?.errorReason;
        return reply.send(payload);
      } catch (err) {
        return reply.send(softErr(payload, err));
      }
    },
  );
  app.get(
    '/api/pprof/tasks/:taskId/progress',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { taskId: string };
      const payload: PprofProgressResponse = { progress: null, reachable: true };
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      try {
        const data = await graphqlPost<{ taskProgress: PprofProgressResponse['progress'] }>(
          opts,
          GET_PPROF_PROGRESS,
          { taskId: params.taskId },
        );
        payload.progress = data.taskProgress ?? null;
        return reply.send(payload);
      } catch (err) {
        return reply.send(softErr(payload, err));
      }
    },
  );
  app.post(
    '/api/pprof/analyze',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as
        | { taskId: string; instanceIds: string[] }
        | undefined;
      const payload: PprofAnalyzeResponse = { tree: null, reachable: true };
      if (!body?.taskId || !body.instanceIds?.length) return reply.send(payload);
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      try {
        // PprofAnalyzationRequest is taskId + instanceIds only — pprof
        // tasks are single-event, so there's no eventType selector here.
        const request = { taskId: body.taskId, instanceIds: body.instanceIds };
        const data = await graphqlPost<{
          analysisResult: { tree: PprofAnalyzeResponse['tree'] } | null;
        }>(opts, GET_PPROF_ANALYZE, { request });
        payload.tree = data.analysisResult?.tree ?? null;
        return reply.send(payload);
      } catch (err) {
        return reply.send(softErr(payload, err));
      }
    },
  );
}

// Keep eventType-from-event mapping for the UI: CPU/WALL/CTIMER/ITIMER
// all roll up into EXECUTION_SAMPLE; LOCK and TLAB allocs keep their
// own enum. The UI uses this to choose which `tree` to show after an
// async analyze (the result graph contains one tree per JFR type).
export const EVENT_TO_JFR: Record<AsyncProfilingEvent, string> = {
  CPU: 'EXECUTION_SAMPLE',
  WALL: 'EXECUTION_SAMPLE',
  CTIMER: 'EXECUTION_SAMPLE',
  ITIMER: 'EXECUTION_SAMPLE',
  LOCK: 'LOCK',
  ALLOC: 'OBJECT_ALLOCATION_IN_NEW_TLAB',
};
