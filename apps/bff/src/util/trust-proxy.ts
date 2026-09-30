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

import type { FastifyServerOptions } from 'fastify';

/**
 * `server.trustProxy` as the value Fastify is constructed with.
 *
 * Fastify ≥ 5.12.1 (GHSA-3m5p-2c4r-xxw2) treats a numeric `trustProxy` as
 * "trust nothing", so a hop count passed through as-is would silently record
 * the proxy. A number is handed over as the rule Fastify ≤ 5.11 built from it,
 * `hop < N`, which keeps the hop count's meaning — including that it believes
 * the forwarded headers from a caller that reaches Horizon directly.
 */
export function toFastifyTrustProxy(value: boolean | number | string): FastifyServerOptions['trustProxy'] {
  if (typeof value === 'number') return (_address: string, hop: number) => hop < value;
  return value;
}
