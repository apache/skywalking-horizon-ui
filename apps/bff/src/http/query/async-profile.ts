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
 *   GET  /api/layer/:key/async/tasks?serviceId=&service=
 *   POST /api/layer/:key/async/tasks
 *   GET  /api/async/tasks/:taskId/progress
 *   POST /api/async/analyze
 *
 *   GET  /api/layer/:key/pprof/tasks?serviceId=&service=
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
import type { AuthDeps } from '../../user/middleware.js';
import { requireAuth } from '../../user/middleware.js';
import { graphqlPost, buildOapOpts } from '../../client/graphql.js';
import { serviceScopeOf } from '../../logic/oap/service-scope.js';
import { overFetchSize, takeOverFetched } from '../../logic/paging/read-page.js';

export interface AsyncProfileRouteDeps extends AuthDeps {
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

/** Per-task caps for async-profiler / pprof bodies.
 *
 *  These two flavours take duration in DIFFERENT units, and only pprof's bound
 *  is OAP's: `PprofMutationService.checkArgumentError` rejects `duration > 15`
 *  with "duration cannot be greater than 15 minutes" (CPU/BLOCK/MUTEX only).
 *  Async is seconds and OAP bounds it only by `duration <= 0`, so the async cap
 *  below is OURS — a route-level guard, since any caller holding `profile:enable`
 *  could otherwise peg a fleet's CPU for hours. Never describe it as OAP's.
 *  900s is booster-ui's own ceiling (NewTask.vue `:max="900"`), so the reference
 *  UI's longest offered task stays acceptable here. */
const MAX_ASYNC_DURATION_SEC = 900;
const MAX_PPROF_DURATION_MIN = 15;
const MAX_TARGET_INSTANCES = 32;
const MAX_EVENTS_PER_TASK = 8;
const MAX_EXEC_ARGS_LEN = 256;

/** `'over'` rather than a clamp when the caller exceeds `max`: an approved
 *  decision card states a duration, and silently running a shorter task leaves
 *  the operator reading a window it never covered. Same rule as
 *  `pickInstanceIds`. */
/** A caller-supplied whole number above zero, with no repair. Used where a
 *  substituted default would be worse than a rejection. */
function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function boundedPositiveInt(v: unknown, max: number): number | 'over' | null {
  if (v == null) return null;
  // No Math.round: a fractional duration is a caller error, not ours to fix.
  // 0.4 rounding to 0 previously forwarded a ZERO-second task as if it were
  // valid; a whole number is required, exactly as the error message already
  // claimed.
  if (!isPositiveInt(v)) return null;
  return v > max ? 'over' : v;
}

/** `null` when the caller asked for more than the guard allows. OAP caps
 *  nothing here, so the cap is ours — and exceeding it must be an error, not a
 *  silent slice that profiles 32 of the 40 instances the card advertised. */
function pickInstanceIds(ids: unknown): string[] | null {
  if (!Array.isArray(ids)) return [];
  const clean = ids.filter((s): s is string => typeof s === 'string' && s.length > 0);
  return clean.length > MAX_TARGET_INSTANCES ? null : clean;
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

export function registerAsyncProfileRoutes(
  app: FastifyInstance,
  deps: AsyncProfileRouteDeps,
): void {
  const auth = requireAuth(deps);

  app.get(
    '/api/layer/:key/async/tasks',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = req.query as { serviceId?: string; service?: string; limit?: string };
      const payload: AsyncProfilingTaskListResponse = { tasks: [], truncated: false, reachable: true };
      // `AsyncProfilerTaskListRequest.serviceId` is `ID!` — required, so a name
      // that arrived without its id has nothing valid to send. Refuse with the
      // reason rather than guess at an id or fire a malformed query.
      const scope = serviceScopeOf(q);
      if (scope.kind === 'incomplete') return reply.send(softErr(payload, scope.message));
      if (scope.kind === 'all') return reply.send(payload);
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      const limit = clampTaskListLimit(q.limit);
      try {
        const data = await graphqlPost<{
          asyncTaskList: { errorReason?: string; tasks: AsyncProfilingTaskListResponse['tasks'] };
        }>(opts, GET_ASYNC_TASK_LIST, {
          request: { serviceId: scope.service.id, limit: overFetchSize(limit) },
        });
        const page = takeOverFetched(data.asyncTaskList?.tasks ?? [], limit);
        payload.tasks = page.rows;
        payload.truncated = page.hasNext;
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
      const duration = boundedPositiveInt(raw.duration, MAX_ASYNC_DURATION_SEC);
      if (duration === null || duration === 'over') {
        payload.errorReason = `duration is required and must be 1..${MAX_ASYNC_DURATION_SEC} seconds`;
        return reply.send(payload);
      }
      const instanceIds = pickInstanceIds(raw.serviceInstanceIds);
      if (instanceIds === null) {
        payload.errorReason = `too many target instances (max ${MAX_TARGET_INSTANCES} per task) — split the fleet across several tasks`;
        return reply.send(payload);
      }
      // Sanitised body — OAP gets exactly the fields it expects, all
      // bounded. Unknown keys are dropped.
      const sanitised: AsyncProfilingTaskCreationRequest = {
        serviceId: raw.serviceId,
        serviceInstanceIds: instanceIds,
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
      const q = req.query as { serviceId?: string; service?: string; limit?: string };
      const payload: PprofTaskListResponse = { tasks: [], truncated: false, reachable: true };
      // `PprofTaskListRequest.serviceId` is nullable — same refusal as async.
      const scope = serviceScopeOf(q);
      if (scope.kind === 'incomplete') return reply.send(softErr(payload, scope.message));
      if (scope.kind === 'all') return reply.send(payload);
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      const limit = clampTaskListLimit(q.limit);
      try {
        const data = await graphqlPost<{
          pprofTaskList: { errorReason?: string; tasks: PprofTaskListResponse['tasks'] };
        }>(opts, GET_PPROF_TASK_LIST, {
          request: { serviceId: scope.service.id, limit: overFetchSize(limit) },
        });
        const page = takeOverFetched(data.pprofTaskList?.tasks ?? [], limit);
        payload.tasks = page.rows;
        payload.truncated = page.hasNext;
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
      const pprofInstanceIds = pickInstanceIds(raw.serviceInstanceIds);
      if (pprofInstanceIds === null) {
        payload.errorReason = `too many target instances (max ${MAX_TARGET_INSTANCES} per task) — split the fleet across several tasks`;
        return reply.send(payload);
      }
      // Genuinely optional here (HEAP / GOROUTINE / ALLOCS / THREADCREATE are
      // point-in-time and carry none), so `undefined` and "invalid" must NOT
      // collapse to the same "omit the field" outcome — a caller who typed 1.6
      // gets refused, not a silently duration-less task.
      const pprofDurationRaw = raw.duration === undefined ? null : boundedPositiveInt(raw.duration, MAX_PPROF_DURATION_MIN);
      if (pprofDurationRaw === 'over') {
        payload.errorReason = `duration cannot be greater than ${MAX_PPROF_DURATION_MIN} minutes`;
        return reply.send(payload);
      }
      if (pprofDurationRaw === null && raw.duration !== undefined) {
        payload.errorReason = `duration must be a whole number of minutes between 1 and ${MAX_PPROF_DURATION_MIN}`;
        return reply.send(payload);
      }
      const pprofDuration = pprofDurationRaw;
      // NOT a period in seconds — OAP defines dumpPeriod as a sampling RATE: for
      // BLOCK, one event per that many nanoseconds spent blocked; for MUTEX, one
      // per that many contentions. LOWER means MORE verbose, so substituting a
      // default for a bad value is the worst possible repair: 1 samples
      // everything. Reject instead, and forward a valid rate untouched — OAP
      // requires only `dumpPeriod > 0` and is the authority on the rest.
      if (raw.dumpPeriod !== undefined && !isPositiveInt(raw.dumpPeriod)) {
        payload.errorReason =
          'dumpPeriod must be a whole number greater than 0 (it is a sampling rate — lower means more samples)';
        return reply.send(payload);
      }
      const sanitised: PprofTaskCreationRequest = {
        serviceId: raw.serviceId,
        serviceInstanceIds: pprofInstanceIds,
        events: typeof raw.events === 'string' ? raw.events : '',
        ...(pprofDuration !== null ? { duration: pprofDuration } : {}),
        ...(raw.dumpPeriod !== undefined ? { dumpPeriod: raw.dumpPeriod as number } : {}),
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
