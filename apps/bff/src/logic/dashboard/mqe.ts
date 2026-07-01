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
 * MQE (`execExpression`) wire-shape types + the per-widget GraphQL fragment
 * builder shared by the dashboard query route and its parsers.
 */

import type { Window } from '../../util/window.js';

interface MqeOwner {
  scope?: string | null;
  serviceName?: string | null;
  serviceInstanceName?: string | null;
  endpointName?: string | null;
}
interface MqeValueShape {
  id?: string | null;
  value?: string | null;
  /** Trace id of a RECORD_LIST sample (slow SQL / slow statements) —
   *  powers the jump-to-trace icon on a `record` widget. Null on
   *  non-record results. */
  traceID?: string | null;
  owner?: MqeOwner | null;
}
interface MqeLabelShape {
  key: string;
  value: string;
}
interface MqeMetadataShape {
  labels?: MqeLabelShape[] | null;
}
interface MqeValuesShape {
  metric?: MqeMetadataShape | null;
  values?: MqeValueShape[];
}
export interface MqeResultShape {
  type: string;
  error?: string | null;
  results?: MqeValuesShape[];
}

/** Build one aliased `execExpression` GraphQL fragment for a single
 *  widget expression. The entity scope flips based on opts:
 *    - `serviceInstanceName` set → ServiceInstance scope
 *    - `endpointName` set → Endpoint scope
 *    - otherwise → Service scope with the supplied serviceName
 *
 *  Exported for unit testing (see dashboard.test.ts). */
export function buildFragment(
  alias: string,
  expression: string,
  serviceName: string,
  normal: boolean,
  w: Window,
  opts: {
    serviceInstanceName?: string | null;
    endpointName?: string | null;
    /** When true, splice `coldStage: true` into the Duration literal.
     *  OAP ignores it for non-BanyanDB backends, so callers can pass it
     *  unconditionally when the request asked for cold-stage data. */
    coldStage?: boolean;
  } = {},
): string {
  // The selection set fetches metric.labels (multi-series Line widgets —
  // relabels() returns one labeled result per percentile) and value.id /
  // owner.endpointName (TopList widgets — top_n() returns a sorted list of
  // entities + values).
  let entity: string;
  if (opts.serviceInstanceName) {
    entity =
      `{ scope: ServiceInstance, serviceName: ${JSON.stringify(serviceName)},` +
      ` serviceInstanceName: ${JSON.stringify(opts.serviceInstanceName)},` +
      ` normal: ${normal ? 'true' : 'false'} }`;
  } else if (opts.endpointName) {
    entity =
      `{ scope: Endpoint, serviceName: ${JSON.stringify(serviceName)},` +
      ` endpointName: ${JSON.stringify(opts.endpointName)},` +
      ` normal: ${normal ? 'true' : 'false'} }`;
  } else {
    entity = `{ scope: Service, serviceName: ${JSON.stringify(serviceName)}, normal: ${normal ? 'true' : 'false'} }`;
  }
  const coldFrag = opts.coldStage ? ', coldStage: true' : '';
  return (
    `${alias}: execExpression(\n` +
    `      expression: ${JSON.stringify(expression)},\n` +
    `      entity: ${entity},\n` +
    `      duration: { start: ${JSON.stringify(w.start)}, end: ${JSON.stringify(w.end)}, step: ${w.step}${coldFrag} }\n` +
    `    ) {\n` +
    `      type error\n` +
    `      results {\n` +
    `        metric { labels { key value } }\n` +
    `        values { id value traceID owner { scope serviceName serviceInstanceName endpointName } }\n` +
    `      }\n` +
    `    }`
  );
}
