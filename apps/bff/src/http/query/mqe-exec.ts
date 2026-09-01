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
 * `POST /api/mqe/exec` — run ONE MQE expression and hand back OAP's
 * `ExpressionResult` untouched.
 *
 * The read path behind the template editor's "run this expression" panel:
 * an author needs to know whether the MQE they just typed returns anything,
 * and every other surface in the product answers that only after a push.
 *
 * Deliberately NOT the dashboard route: that one collapses each result into
 * a widget shape (scalar / series / rows) and can express only Service,
 * ServiceInstance and Endpoint entities, so it can neither show the raw
 * answer nor reach the relation metrics half this editor's fields carry.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  ExpressionResult,
  FetchLike,
  MqeEntity,
  MqeExecResponse,
} from '@skywalking-horizon-ui/api-client';
import type { AuthDeps } from '../../user/middleware.js';
import { requireAuth } from '../../user/middleware.js';
import { graphqlPost, buildOapOpts, GraphqlError } from '../../client/graphql.js';
import { clientGone } from '../client-gone.js';
import { withColdStage } from '../../util/duration.js';
import { getServerOffsetMinutes, windowFromRange } from '../../util/window.js';
import { expressionForServiceMetricSeries } from '../../util/mqe-catalog.js';

export interface MqeExecRouteDeps extends AuthDeps {
  fetch?: FetchLike;
}

/** The full `ExpressionResult` selection set — the point of this route is
 *  that nothing is dropped, so it asks for every field OAP exposes.
 *  `debuggingTrace` is deliberately absent: it only populates under
 *  `debug: true`, which nothing here sets. */
const EXEC_QUERY = /* GraphQL */ `
  query HorizonMqeExec($expression: String!, $entity: Entity!, $duration: Duration!) {
    execExpression(expression: $expression, entity: $entity, duration: $duration) {
      type
      error
      results {
        metric { labels { key value } }
        values {
          id
          value
          traceID
          owner {
            scope
            serviceID
            serviceName
            normal
            serviceInstanceID
            serviceInstanceName
            endpointID
            endpointName
          }
        }
      }
    }
  }
`;

/** A generous ceiling rather than a business rule — MQE expressions are
 *  single-line and the longest in the shipped bundle is well under 500
 *  characters. Bounds an unbounded string reaching OAP. */
const MAX_EXPRESSION_LEN = 4000;
const MAX_EPOCH_MS = 253_402_300_799_999; // 9999-12-31T23:59:59.999Z

/** OAP entity names are optional because layer-wide MQE omits them, but a
 *  present blank is not omission: OAP silently addresses `_blank` instead. */
const entityName = z.string().trim().min(1).max(4000);

/** Entity fields OAP's `Entity` input accepts. `scope` is optional and
 *  deprecated upstream (9.4.0) — a relation metric MUST omit it, because
 *  forcing it explicitly empties the result on some OAP versions. Unknown
 *  keys are stripped rather than forwarded, so a typo fails visibly here
 *  instead of silently widening the query.
 *
 *  Exported for unit testing (see mqe-exec.test.ts). */
export const entitySchema = z
  .object({
    scope: z.string().trim().min(1).max(128).optional(),
    serviceName: entityName.optional(),
    normal: z.boolean().optional(),
    serviceInstanceName: entityName.optional(),
    endpointName: entityName.optional(),
    processName: entityName.optional(),
    destServiceName: entityName.optional(),
    destNormal: z.boolean().optional(),
    destServiceInstanceName: entityName.optional(),
    destEndpointName: entityName.optional(),
    destProcessName: entityName.optional(),
  })
  .strict();

/** Exported for unit testing (see mqe-exec.test.ts). */
export const bodySchema = z
  .object({
    expression: z.string().max(MAX_EXPRESSION_LEN).optional(),
    metric: z.string().max(256).optional(),
    layer: z.string().max(128).optional(),
    entity: entitySchema,
    step: z.enum(['MINUTE', 'HOUR', 'DAY']),
    startMs: z.number().int().positive().max(MAX_EPOCH_MS),
    endMs: z.number().int().positive().max(MAX_EPOCH_MS),
  })
  .strict();

/* The window is bounded at both ends and must run forwards, and nothing more.
 *
 * The per-step length caps are the query protocol's, and the time picker is
 * where they are enforced — it couples window to step, so no metrics window
 * reaches a route uncoupled. Restating them here duplicated that rule in a
 * third place and made this the only metrics route to refuse a window by
 * length; `dashboard` and `landing` bound none. For a caller that is not the
 * picker, OAP is the authority, and this panel relays what it answers. */

export function registerMqeExecRoute(app: FastifyInstance, deps: MqeExecRouteDeps): void {
  const auth = requireAuth(deps);
  app.post(
    '/api/mqe/exec',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = bodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.flatten() });
      }
      const { entity, step, startMs, endMs } = parsed.data;

      // A blank field is not a blank query: a service-list column with no
      // `mqe` runs the catalog default derived from its metric id + layer,
      // and that default is exactly what an author with an empty box needs
      // to see. Resolution lives here because the catalog is BFF-side.
      const typed = (parsed.data.expression ?? '').trim();
      let expression = typed;
      let resolvedFromCatalog = false;
      if (!expression) {
        const metric = (parsed.data.metric ?? '').trim();
        const layer = (parsed.data.layer ?? '').trim();
        if (!metric || !layer) {
          return reply.code(400).send({
            error: 'missing_expression',
            detail: 'send `expression`, or `metric` + `layer` to resolve the catalog default',
          });
        }
        const fromCatalog = expressionForServiceMetricSeries(metric, layer);
        if (!fromCatalog) {
          return reply.code(404).send({ error: 'no_catalog_default', metric, layer });
        }
        expression = fromCatalog;
        resolvedFromCatalog = true;
      }

      const signal = clientGone(reply);
      const opts = buildOapOpts(deps.config.current, deps.fetch, signal);
      // OAP reads Duration strings in ITS OWN local time; the caller sends
      // epoch ms so nothing client-side has to know the server's offset.
      const offset = await getServerOffsetMinutes(deps.config, deps.fetch, signal);
      const window = windowFromRange(step, startMs, endMs, offset);
      if (!window) {
        return reply.code(400).send({ error: 'invalid_range', detail: 'endMs must be after startMs' });
      }

      const coldStage = !!req.coldStage;
      let result: ExpressionResult;
      try {
        const data = await graphqlPost<{ execExpression: ExpressionResult }>(opts, EXEC_QUERY, {
          expression,
          entity: entity as MqeEntity,
          duration: withColdStage(
            { coldStage },
            { start: window.start, end: window.end, step: window.step },
          ),
        });
        result = data.execExpression;
      } catch (err) {
        // Parse failures are returned by OAP as `type: UNKNOWN` inside a 200.
        // GraphQL errors escape from duration/storage/resolver work instead,
        // so calling them author syntax would hide a real upstream failure.
        return reply.code(502).send({
          error: err instanceof GraphqlError ? 'oap_query_failed' : 'oap_unreachable',
          detail: err instanceof GraphqlError && err.errors
            ? err.errors.map((e) => e.message).join('; ')
            : err instanceof Error ? err.message : String(err),
        });
      }

      const body: MqeExecResponse = {
        expression,
        resolvedFromCatalog,
        window: { start: window.start, end: window.end, step: window.step },
        coldStage,
        result,
      };
      return reply.send(body);
    },
  );
}
