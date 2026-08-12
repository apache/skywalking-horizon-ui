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
 * Shared MQE plumbing for the topology-family map builders (service topology,
 * deployment, instance topology, endpoint dependency). Each builder aliases
 * one `execExpression` per (node|edge)×metric, fans them out via
 * `fetchAliasedChunks`, then folds the responses back with `aggregateMqe`
 * (scalar for the pill/header) and `seriesFromMqe` (per-bucket series for the
 * edge detail sparklines). The fragment builders below emit the Service /
 * ServiceRelation entity shapes; the instance/endpoint variants live with
 * their own builders.
 */

import type { TopologyMetricDef } from '@skywalking-horizon-ui/api-client';
import type { Window } from '../../util/window.js';

interface MqeValueRow {
  value: string | number | null;
}
interface MqeResult {
  values?: MqeValueRow[];
}
export interface MqeShape {
  type?: string;
  error?: string | null;
  results?: MqeResult[];
}

export function nodeFragment(
  alias: string,
  m: TopologyMetricDef,
  serviceName: string,
  normal: boolean,
  w: Window,
  coldStage: boolean,
): string {
  const coldFrag = coldStage ? ', coldStage: true' : '';
  return (
    `${alias}: execExpression(\n` +
    `      expression: ${JSON.stringify(m.mqe)},\n` +
    `      entity: { scope: Service, serviceName: ${JSON.stringify(serviceName)},` +
    ` normal: ${normal ? 'true' : 'false'} },\n` +
    `      duration: { start: ${JSON.stringify(w.start)}, end: ${JSON.stringify(w.end)}, step: ${w.step}${coldFrag} }\n` +
    `    ) { type error results { values { value } } }`
  );
}

/** Per-instance fragment under `{ scope: ServiceInstance }` — shared by the
 *  deployment + instance-topology builders (their node MQE is identical; only
 *  the relation fragments differ). Takes any metric def with an `mqe`. */
export function instanceNodeFragment(
  alias: string,
  m: { mqe: string },
  serviceName: string,
  instanceName: string,
  normal: boolean,
  w: Window,
  coldStage: boolean,
): string {
  const coldFrag = coldStage ? ', coldStage: true' : '';
  return (
    `${alias}: execExpression(\n` +
    `      expression: ${JSON.stringify(m.mqe)},\n` +
    `      entity: { scope: ServiceInstance, serviceName: ${JSON.stringify(serviceName)},` +
    ` normal: ${normal ? 'true' : 'false'}, serviceInstanceName: ${JSON.stringify(instanceName)} },\n` +
    `      duration: { start: ${JSON.stringify(w.start)}, end: ${JSON.stringify(w.end)}, step: ${w.step}${coldFrag} }\n` +
    `    ) { type error results { values { value } } }`
  );
}

/**
 * ServiceRelation entity fragment. Booster-ui's hooks build the same
 * shape — notice we do NOT set `scope` here. OAP infers scope from
 * the MQE metric name (`service_relation_server_*` → ServiceRelation
 * server, `service_relation_client_*` → ServiceRelation client),
 * and forcing the scope explicitly empties the result on some OAP
 * versions. Booster's hook fills `sourceNormal` / `destNormal` from
 * `isReal || normal`, so we accept that pre-resolved value verbatim
 * (route handler picks the right thing per node).
 */
export function relationFragment(
  alias: string,
  m: TopologyMetricDef,
  sourceName: string,
  sourceNormal: boolean,
  destName: string,
  destNormal: boolean,
  w: Window,
  coldStage: boolean,
): string {
  const coldFrag = coldStage ? ', coldStage: true' : '';
  return (
    `${alias}: execExpression(\n` +
    `      expression: ${JSON.stringify(m.mqe)},\n` +
    `      entity: {` +
    ` serviceName: ${JSON.stringify(sourceName)},` +
    ` normal: ${sourceNormal ? 'true' : 'false'},` +
    ` destServiceName: ${JSON.stringify(destName)},` +
    ` destNormal: ${destNormal ? 'true' : 'false'} },\n` +
    `      duration: { start: ${JSON.stringify(w.start)}, end: ${JSON.stringify(w.end)}, step: ${w.step}${coldFrag} }\n` +
    `    ) { type error results { values { value } } }`
  );
}

export function aggregateMqe(env: MqeShape | undefined, kind: 'avg' | 'sum'): number | null {
  if (!env || env.error) return null;
  const values = env.results?.[0]?.values ?? [];
  const nums: number[] = [];
  for (const v of values) {
    if (v.value === null || v.value === undefined) continue;
    const n = Number(v.value);
    if (Number.isFinite(n)) nums.push(n);
  }
  if (nums.length === 0) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return kind === 'sum' ? sum : sum / nums.length;
}

/**
 * Series extractor — same MQE response, returns the per-bucket values
 * as a `(number | null)[]`. Used for the edge detail panel's twin
 * sparkline chart (client | server) so the operator sees the trend
 * shape over the duration window rather than a single scalar.
 */
export function seriesFromMqe(env: MqeShape | undefined): Array<number | null> | null {
  if (!env || env.error) return null;
  const values = env.results?.[0]?.values ?? [];
  if (values.length === 0) return null;
  return values.map((v) => {
    if (v.value === null || v.value === undefined) return null;
    const n = Number(v.value);
    return Number.isFinite(n) ? n : null;
  });
}
