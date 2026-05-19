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
 * MQE fire — `POST /api/inspect/exec` forwards to OAP's GraphQL
 * `mutation execExpression(expression, entity, duration)` and returns
 * the `ExpressionResult` payload to the SPA.
 *
 * The Inspect API deliberately punts value queries off the admin port
 * so that MQE auth / quotas / observability stay on a single surface.
 * The BFF resolves that surface via `MqeTargetCache` and is the
 * single egress point for MQE traffic from Studio.
 *
 * The handler validates inbound shape, builds the GraphQL request,
 * folds GraphQL errors into the BFF's envelope (`mqe_error`), and
 * returns `data.execExpression` verbatim on success. The SPA does not
 * need GraphQL knowledge.
 */

import type { FastifyReply } from 'fastify';
import type { FetchLike, ExpressionResult, MqeEntity } from '@skywalking-horizon-ui/api-client';
import { INSPECT_STEPS, isInspectDate, type InspectStep } from '@skywalking-horizon-ui/api-client';
import type { MqeTarget } from '../../util/mqe-target.js';

interface DurationInput {
  start: string;
  end: string;
  step: InspectStep;
  coldStage?: boolean;
}

interface ExecBody {
  expression: string;
  entity: MqeEntity;
  duration: DurationInput;
  debug?: boolean;
}

export interface ExecDeps {
  fetch: FetchLike;
  /** Per-call timeout (ms). 0 disables. */
  timeoutMs: number;
}

/* SkyWalking's MQE entry point is on `Query`, not `Mutation`
 * (see oap-server/.../metrics-v3.graphqls — `extend type Query`). */
const GRAPHQL_QUERY =
  'query Exec($expression: String!, $entity: Entity!, $duration: Duration!, $debug: Boolean) {\n' +
  '  execExpression(expression: $expression, entity: $entity, duration: $duration, debug: $debug) {\n' +
  '    type\n' +
  '    error\n' +
  '    results {\n' +
  '      metric { labels { key value } }\n' +
  '      values { id value traceID owner { scope serviceID serviceName normal serviceInstanceID serviceInstanceName endpointID endpointName } }\n' +
  '    }\n' +
  '  }\n' +
  '}\n';

/** Validate the request body and either send a 400 / return null, or
 *  return the parsed body for execution. */
export function parseExecBody(body: unknown, reply: FastifyReply): ExecBody | null {
  if (typeof body !== 'object' || body === null) {
    reply.code(400).send({ error: 'invalid_body' });
    return null;
  }
  const b = body as Partial<ExecBody>;
  if (typeof b.expression !== 'string' || b.expression.length === 0) {
    reply.code(400).send({ error: 'missing_expression' });
    return null;
  }
  if (typeof b.entity !== 'object' || b.entity === null) {
    reply.code(400).send({ error: 'missing_entity' });
    return null;
  }
  if (typeof (b.entity as MqeEntity).scope !== 'string') {
    reply.code(400).send({ error: 'invalid_entity', detail: 'scope is required' });
    return null;
  }
  if (typeof b.duration !== 'object' || b.duration === null) {
    reply.code(400).send({ error: 'missing_duration' });
    return null;
  }
  const d = b.duration as DurationInput;
  if (typeof d.start !== 'string' || typeof d.end !== 'string') {
    reply.code(400).send({ error: 'invalid_duration', detail: 'start and end must be strings' });
    return null;
  }
  if (typeof d.step !== 'string' || !INSPECT_STEPS.includes(d.step.toUpperCase() as InspectStep)) {
    reply.code(400).send({
      error: 'invalid_duration',
      detail: `step must be one of ${INSPECT_STEPS.join(', ')}`,
    });
    return null;
  }
  const step = d.step.toUpperCase() as InspectStep;
  if (!isInspectDate(d.start, step)) {
    reply
      .code(400)
      .send({ error: 'invalid_duration', detail: `start does not match ${step} format` });
    return null;
  }
  if (!isInspectDate(d.end, step)) {
    reply
      .code(400)
      .send({ error: 'invalid_duration', detail: `end does not match ${step} format` });
    return null;
  }
  return {
    expression: b.expression,
    entity: b.entity as MqeEntity,
    duration: {
      start: d.start,
      end: d.end,
      step,
      ...(d.coldStage !== undefined ? { coldStage: !!d.coldStage } : {}),
    },
    ...(b.debug !== undefined ? { debug: !!b.debug } : {}),
  };
}

interface GraphQlEnvelope {
  data?: { execExpression?: ExpressionResult };
  errors?: { message: string; path?: string[] }[];
}

/** Fire the MQE mutation against the resolved base. Returns the
 *  `ExpressionResult` on success. Throws a {@link MqeFireError} with
 *  the GraphQL error array attached on failure. */
export async function fireMqe(
  target: MqeTarget,
  req: ExecBody,
  deps: ExecDeps,
): Promise<ExpressionResult> {
  const url = `${target.baseUrl.replace(/\/$/, '')}/graphql`;
  const payload = {
    query: GRAPHQL_QUERY,
    variables: {
      expression: req.expression,
      entity: req.entity,
      duration: req.duration,
      debug: req.debug ?? false,
    },
  };
  let init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (deps.timeoutMs > 0) {
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), deps.timeoutMs);
    init = { ...init, signal: ctrl.signal };
  }
  try {
    const res = await deps.fetch(url, init);
    if (!res.ok) {
      const text = await res.text();
      throw new MqeFireError(`MQE HTTP ${res.status}: ${text.slice(0, 200)}`, []);
    }
    const env = (await res.json()) as GraphQlEnvelope;
    if (env.errors && env.errors.length > 0) {
      const msg = env.errors.map((e) => e.message).join('; ');
      throw new MqeFireError(`MQE error: ${msg}`, env.errors);
    }
    if (!env.data || !env.data.execExpression) {
      throw new MqeFireError('MQE response missing data.execExpression', []);
    }
    return env.data.execExpression;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class MqeFireError extends Error {
  constructor(
    message: string,
    public readonly graphqlErrors: { message: string; path?: string[] }[],
  ) {
    super(message);
    this.name = 'MqeFireError';
  }
}
