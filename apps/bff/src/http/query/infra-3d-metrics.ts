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
 * `POST /api/infra-3d/metrics` — batched per-service MQE fetch used by
 * the 3D infra map's stage-5 traffic-ring pipeline.
 *
 * Body:
 *   {
 *     services: Array<{ name, layer, normal, mqe }>,  // up to MAX_SERVICES per call
 *     window?: { startMs, endMs, step }                // optional; defaults to last 10m MINUTE
 *   }
 *
 * Response:
 *   { values: Record<string, number | null>,           // key = `${layer}::${name}` upper-case
 *     errors: Record<string, string> }                  // same key on per-service OAP errors
 *
 * Implementation: one GraphQL trip with N aliased `execExpression`
 * fragments — same shape as the landing route, just keyed at the 3D
 * map's level (entity.serviceName + per-service MQE). The caller (UI)
 * chunks the full service set into `pipeline.metricChunkSize` slices
 * and dispatches them sequentially so the timeline drawer can report
 * "K / T chunks complete". OAP's per-request complexity cap is shared
 * with the landing route (6 services × N fragments has been stable
 * across showcase backends).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import { graphqlPost, buildOapOpts } from '../../client/graphql.js';
import {
  defaultMinuteWindow,
  getServerOffsetMinutes,
  windowFromRange,
  type Window,
} from '../../util/window.js';

export interface Infra3dMetricsDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
}

/** Hard cap matching the landing / dashboard routes — OAP GraphQL
 *  complexity throws 5xx beyond this on busy backends. The UI is
 *  expected to honour the same number (passed through
 *  `infraConfig.pipeline.metricChunkSize`). */
const MAX_SERVICES = 12;
const DEFAULT_WINDOW_MIN = 10;

const bodySchema = z
  .object({
    services: z
      .array(
        z
          .object({
            name: z.string().min(1),
            layer: z.string().min(1),
            normal: z.boolean(),
            mqe: z.string().min(1),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_SERVICES),
    window: z
      .object({
        startMs: z.number(),
        endMs: z.number(),
        step: z.enum(['SECOND', 'MINUTE', 'HOUR', 'DAY']),
      })
      .strict()
      .optional(),
  })
  .strict();

interface ValueRow {
  id?: string | null;
  value?: string | null;
}
interface MqeValuesShape {
  metric?: { labels?: Array<{ key: string; value: string }> | null };
  values?: ValueRow[];
}
interface MqeResultShape {
  type: string;
  error?: string | null;
  results?: MqeValuesShape[];
}

function buildFragment(
  alias: string,
  s: { name: string; normal: boolean; mqe: string },
  w: Window,
  coldStage: boolean,
): string {
  const cold = coldStage ? ', coldStage: true' : '';
  return (
    `${alias}: execExpression(\n` +
    `      expression: ${JSON.stringify(s.mqe)},\n` +
    `      entity: { scope: Service, serviceName: ${JSON.stringify(s.name)}, normal: ${s.normal ? 'true' : 'false'} },\n` +
    `      duration: { start: ${JSON.stringify(w.start)}, end: ${JSON.stringify(w.end)}, step: ${w.step}${cold} }\n` +
    `    ) { type error results { values { value } } }`
  );
}

/** Reduce a single service's MQE result to one scalar. Series-shaped
 *  responses are averaged (operators read the traffic ring as "what's
 *  the recent load", not an instantaneous tick); the OAP-side error
 *  surfaces verbatim. Empty result → null. */
function reduceToScalar(result: MqeResultShape | undefined): number | null {
  if (!result) return null;
  if (result.error) return null;
  const series = result.results?.[0]?.values ?? [];
  if (series.length === 0) return null;
  let sum = 0;
  let count = 0;
  for (const v of series) {
    const n = typeof v.value === 'string' ? Number(v.value) : Number(v.value ?? NaN);
    if (Number.isFinite(n)) {
      sum += n;
      count++;
    }
  }
  return count === 0 ? null : sum / count;
}

export function registerInfra3dMetricsRoute(app: FastifyInstance, deps: Infra3dMetricsDeps): void {
  const auth = requireAuth(deps);
  app.post(
    '/api/infra-3d/metrics',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.flatten() });
      }
      const { services, window: w } = parsed.data;
      const opts = buildOapOpts(deps.config.current, deps.fetch);
      const offset = await getServerOffsetMinutes(deps.config, deps.fetch);
      const win: Window = w
        ? windowFromRange(w.step, w.startMs, w.endMs, offset) ??
          defaultMinuteWindow(offset, DEFAULT_WINDOW_MIN)
        : defaultMinuteWindow(offset, DEFAULT_WINDOW_MIN);

      // Aliases must be valid GraphQL identifiers; index-based is the
      // only safe scheme because service names contain `::` / `.` etc.
      const fragments = services.map((s, i) =>
        buildFragment(`s${i}`, s, win, !!req.coldStage),
      );
      const query = `query Infra3dMetrics {\n${fragments.join('\n')}\n}`;

      const values: Record<string, number | null> = {};
      const errors: Record<string, string> = {};

      try {
        const data = await graphqlPost<Record<string, MqeResultShape>>(opts, query, {});
        services.forEach((s, i) => {
          const key = `${s.layer.toUpperCase()}::${s.name}`;
          const r = data[`s${i}`];
          if (r?.error) errors[key] = r.error;
          values[key] = reduceToScalar(r);
        });
      } catch (err) {
        // Whole-trip failure — every service slot stays null and the
        // error is surfaced once. The UI shows a warn on this chunk
        // and continues to the next; one bad chunk doesn't blank the
        // whole map.
        services.forEach((s) => {
          const key = `${s.layer.toUpperCase()}::${s.name}`;
          values[key] = null;
          errors[key] = err instanceof Error ? err.message : String(err);
        });
      }

      return reply.send({
        values,
        errors,
        generatedAt: Date.now(),
        window: { start: win.start, end: win.end, step: win.step },
      });
    },
  );
}
