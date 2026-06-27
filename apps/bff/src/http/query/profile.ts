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
 * Trace-driven (agent) profiling routes.
 *
 *   GET  /api/layer/:key/profile/tasks?service=&endpoint=
 *        — list profile tasks for a service (+ optional endpoint filter).
 *   POST /api/layer/:key/profile/tasks
 *        — create a new profile task.
 *   GET  /api/profile/tasks/:taskId/segments
 *        — list sampled trace segments collected for a task (incl. spans).
 *   GET  /api/profile/tasks/:taskId/logs
 *        — list operation logs for a task (instance-side state changes).
 *   POST /api/profile/analyze
 *        — analyze profiled span time-ranges into call trees.
 *
 * Wraps OAP's GraphQL profile fragment. Service-id resolution mirrors the
 * pattern in `endpoint-routes.ts` so the UI can pass a service name OR id.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  FetchLike,
  ProfileAnalyzationResponse,
  ProfileAnalyzeQuery,
  ProfileSegmentsResponse,
  ProfileTaskCreationRequest,
  ProfileTaskCreationResponse,
  ProfileTaskListResponse,
  ProfileTaskLogsResponse,
} from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import { graphqlPost, buildOapOpts } from '../../client/graphql.js';

export interface ProfileRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
}

const LIST_SERVICES_FOR_RESOLVE = /* GraphQL */ `
  query ListServicesForProfileResolve($layer: String!) {
    services: listServices(layer: $layer) {
      id
      name
      normal
    }
  }
`;

const GET_PROFILE_TASK_LIST = /* GraphQL */ `
  query getProfileTaskList($endpointName: String, $serviceId: ID) {
    taskList: getProfileTaskList(endpointName: $endpointName, serviceId: $serviceId) {
      id
      serviceId
      endpointName
      startTime
      duration
      minDurationThreshold
      dumpPeriod
      maxSamplingCount
      logs {
        id
        instanceId
        instanceName
        operationType
        operationTime
      }
    }
  }
`;

const GET_PROFILE_TASK_SEGMENTS = /* GraphQL */ `
  query getProfileTaskSegmentList($taskID: ID!) {
    segmentList: getProfileTaskSegments(taskID: $taskID) {
      traceId
      instanceId
      instanceName
      endpointNames
      duration
      start
      spans {
        spanId
        parentSpanId
        segmentId
        refs { traceId parentSegmentId parentSpanId type }
        serviceCode
        serviceInstanceName
        startTime
        endTime
        endpointName
        type
        peer
        component
        isError
        layer
        tags { key value }
        logs { time data { key value } }
        profiled
      }
    }
  }
`;

const GET_PROFILE_TASK_LOGS = /* GraphQL */ `
  query profileTaskLogs($taskID: String) {
    taskLogs: getProfileTaskLogs(taskID: $taskID) {
      id
      instanceId
      instanceName
      operationTime
      operationType
    }
  }
`;

const GET_PROFILE_ANALYZE = /* GraphQL */ `
  query getProfileAnalyze($queries: [SegmentProfileAnalyzeQuery!]!) {
    analyze: getSegmentsProfileAnalyze(queries: $queries) {
      tip
      trees {
        elements {
          id
          parentId
          codeSignature
          duration
          durationChildExcluded
          count
        }
      }
    }
  }
`;

const CREATE_PROFILE_TASK = /* GraphQL */ `
  mutation createProfileTask($creationRequest: ProfileTaskCreationRequest) {
    task: createProfileTask(creationRequest: $creationRequest) {
      id
      errorReason
    }
  }
`;

function softError<T extends { reachable: boolean; error?: string }>(payload: T, err: unknown): T {
  payload.reachable = false;
  payload.error = err instanceof Error ? err.message : String(err);
  return payload;
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
  const match =
    data.services.find((s) => s.name === serviceArg) ??
    data.services.find((s) => s.id === serviceArg) ??
    null;
  return match?.id ?? null;
}

export function registerProfileRoutes(app: FastifyInstance, deps: ProfileRouteDeps): void {
  const auth = requireAuth(deps);

  app.get(
    '/api/layer/:key/profile/tasks',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const layerKey = params.key;
      const q = req.query as { service?: string; endpoint?: string };
      const serviceArg = (q.service ?? '').trim();
      const endpointName = (q.endpoint ?? '').trim();
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      const payload: ProfileTaskListResponse = { tasks: [], reachable: true };

      if (!serviceArg) return reply.send(payload);
      try {
        const serviceId = await resolveServiceId(opts, layerKey, serviceArg);
        if (!serviceId) return reply.send(payload);
        const data = await graphqlPost<{ taskList: ProfileTaskListResponse['tasks'] }>(
          opts,
          GET_PROFILE_TASK_LIST,
          { serviceId, endpointName: endpointName || '' },
        );
        payload.tasks = data.taskList ?? [];
        return reply.send(payload);
      } catch (err) {
        return reply.send(softError(payload, err));
      }
    },
  );

  app.post(
    '/api/layer/:key/profile/tasks',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as ProfileTaskCreationRequest | undefined;
      const payload: ProfileTaskCreationResponse = { reachable: true };
      if (!body || !body.serviceId) {
        payload.errorReason = 'missing serviceId';
        return reply.send(payload);
      }
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      try {
        const data = await graphqlPost<{ task: { id?: string; errorReason?: string } }>(
          opts,
          CREATE_PROFILE_TASK,
          { creationRequest: body },
        );
        payload.id = data.task?.id;
        payload.errorReason = data.task?.errorReason;
        return reply.send(payload);
      } catch (err) {
        return reply.send(softError(payload, err));
      }
    },
  );

  app.get(
    '/api/profile/tasks/:taskId/segments',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { taskId: string };
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      const payload: ProfileSegmentsResponse = { segments: [], reachable: true };
      try {
        const data = await graphqlPost<{ segmentList: ProfileSegmentsResponse['segments'] }>(
          opts,
          GET_PROFILE_TASK_SEGMENTS,
          { taskID: params.taskId },
        );
        payload.segments = data.segmentList ?? [];
        return reply.send(payload);
      } catch (err) {
        return reply.send(softError(payload, err));
      }
    },
  );

  app.get(
    '/api/profile/tasks/:taskId/logs',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { taskId: string };
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      const payload: ProfileTaskLogsResponse = { logs: [], reachable: true };
      try {
        const data = await graphqlPost<{ taskLogs: ProfileTaskLogsResponse['logs'] }>(
          opts,
          GET_PROFILE_TASK_LOGS,
          { taskID: params.taskId },
        );
        payload.logs = data.taskLogs ?? [];
        return reply.send(payload);
      } catch (err) {
        return reply.send(softError(payload, err));
      }
    },
  );

  app.post(
    '/api/profile/analyze',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as { queries?: ProfileAnalyzeQuery[] } | undefined;
      const payload: ProfileAnalyzationResponse = {
        tip: null,
        trees: [],
        reachable: true,
      };
      const queries = body?.queries ?? [];
      if (!queries.length) return reply.send(payload);
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      try {
        const data = await graphqlPost<{
          analyze: { tip: string | null; trees: ProfileAnalyzationResponse['trees'] };
        }>(opts, GET_PROFILE_ANALYZE, { queries });
        payload.tip = data.analyze?.tip ?? null;
        payload.trees = data.analyze?.trees ?? [];
        return reply.send(payload);
      } catch (err) {
        return reply.send(softError(payload, err));
      }
    },
  );
}
