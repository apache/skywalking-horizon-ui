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
 * `POST /api/mqe/exec` — run ONE MQE expression and return OAP's
 * `ExpressionResult` untouched.
 *
 * This is the read path behind the template editor's "run this expression"
 * panel. It differs from `POST /api/inspect/exec` in three ways that matter
 * to a dashboard author rather than to a platform operator:
 *
 *   - the window arrives as epoch ms and the BFF formats it to OAP-local
 *     time, so no caller has to know the server's timezone;
 *   - a blank expression is resolved from `metric` + `layer` through the
 *     same catalog the service-list columns use, so an unfilled `mqe` field
 *     can be explored;
 *   - it is a `metrics:read` route, not `inspect:read` — testing your own
 *     expression is not a platform-internals action.
 *
 * The entity is passed through verbatim. Its `scope` is optional on purpose:
 * relation metrics must be queried WITHOUT one (see {@link MqeEntity}).
 */

import type { ExpressionResult, MqeEntity } from './inspect.js';

export type MqeExecStep = 'MINUTE' | 'HOUR' | 'DAY';

export interface MqeExecRequest {
  /** The expression to run. Omit (or send empty) together with `metric` +
   *  `layer` to have the BFF resolve the catalog default instead. */
  expression?: string;
  /** Service-list column id, used only to resolve a blank `expression`. */
  metric?: string;
  /** Layer key the expression belongs to — required to resolve `metric` and
   *  already known by the caller when it shows what was queried. */
  layer?: string;
  /** Entity to evaluate against. `scope` omitted ⇒ OAP senses it from the
   *  metric name, which is REQUIRED for relation metrics. */
  entity: MqeEntity;
  step: MqeExecStep;
  startMs: number;
  endMs: number;
}

export interface MqeExecResponse {
  /** The expression actually sent to OAP — the caller's, or the catalog
   *  default when it asked for one. Never blank on a 200. */
  expression: string;
  /** True when `expression` came from the metric catalog rather than the
   *  request, so the panel can say so. */
  resolvedFromCatalog: boolean;
  /** The OAP-local window the query used, formatted for its step. */
  window: { start: string; end: string; step: MqeExecStep };
  /** Whether cold-stage data was requested (from the global header). */
  coldStage: boolean;
  /** OAP's answer, verbatim. `type: 'UNKNOWN'` carries `error`. */
  result: ExpressionResult;
}
