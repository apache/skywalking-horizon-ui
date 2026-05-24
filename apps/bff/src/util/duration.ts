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
 * Per-request "query cold stage" plumbing.
 *
 * The UI carries the operator's choice in a request header
 * (`X-Horizon-Cold-Stage: 1`) so it threads through every BFF call
 * without each route having to add a query-param. A Fastify `onRequest`
 * hook reads the header once and stashes the boolean on `req.coldStage`;
 * route handlers building OAP `Duration` variables call
 * {@link withColdStage} to splice the flag in. For routes that
 * interpolate Duration inline (e.g. `dashboard.ts`'s aliased fragment
 * builder), the route reads `req.coldStage` directly and emits the
 * `, coldStage: true` literal in its own template.
 *
 * Semantics worth remembering: OAP's `Duration.coldStage: true`
 * REPLACES the hot+warm read with a cold-only read — it doesn't union
 * the two stages. The BFF always honors the header verbatim and does
 * NOT auto-route by time range; the UI carries the operator-discipline
 * burden of only enabling the toggle when the queried window falls
 * inside the cold-stage time window (see `Operate → Time To Live`).
 * BanyanDB-only at the OAP layer — other backends silently ignore the
 * resulting `Duration.coldStage: true`.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

export const COLD_STAGE_HEADER = 'x-horizon-cold-stage';

declare module 'fastify' {
  interface FastifyRequest {
    /** True when the UI asked for cold-stage data to be included.
     *  False / undefined when omitted. Set once per request by the
     *  cold-stage `onRequest` hook. */
    coldStage?: boolean;
  }
}

/** Register the `onRequest` hook that maps the header into `req.coldStage`.
 *  Call once at server boot. The header is treated truthy when it's
 *  `1` / `true` / `yes` (case-insensitive); everything else is false. */
export function registerColdStageHook(app: FastifyInstance): void {
  app.addHook('onRequest', (req, _reply, done) => {
    const v = req.headers[COLD_STAGE_HEADER];
    const raw = Array.isArray(v) ? v[0] : v;
    if (typeof raw === 'string') {
      const norm = raw.trim().toLowerCase();
      req.coldStage = norm === '1' || norm === 'true' || norm === 'yes';
    } else {
      req.coldStage = false;
    }
    done();
  });
}

/** Splice `coldStage: true` into a Duration variable object when the
 *  request asked for it. Returns the input unchanged otherwise so the
 *  wire stays byte-identical for off-state requests (lets the existing
 *  query-protocol golden tests keep passing). */
export function withColdStage<T extends { start: string; end: string; step: string }>(
  req: Pick<FastifyRequest, 'coldStage'>,
  d: T,
): T | (T & { coldStage: true }) {
  return req.coldStage ? { ...d, coldStage: true } : d;
}
