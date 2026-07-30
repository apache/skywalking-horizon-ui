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
 * Layer-wide continuous-profiling policy summary.
 *
 * OAP has no bulk policy read, so answering "which services of this layer are
 * armed, and with what?" means one query per service. That fan-out is why this
 * lives in `logic/` rather than in the route.
 */

import type { ContinuousProfilingTargetType } from '@skywalking-horizon-ui/api-client';
import type { GraphqlOptions } from '../../client/graphql.js';
import { graphqlPost } from '../../client/graphql.js';
import { mapPool } from '../../util/mapPool.js';

/** Bound the fan-out: a layer can carry thousands of services, and the picker
 *  is readable long before that. `checked` vs `total` reports the shortfall so
 *  a capped answer never reads as the whole layer. */
export const SUMMARY_MAX_SERVICES = 120;
const SUMMARY_CONCURRENCY = 8;

const QUERY_POLICY_TYPES = /* GraphQL */ `
  query HorizonContinuousProfilingPolicyTypes($serviceId: ID!) {
    targets: queryContinuousProfilingServiceTargets(serviceId: $serviceId) {
      type
    }
  }
`;

export interface PolicySummaryRow {
  id: string;
  name: string;
  /** `null` when OAP would not answer. NOT the same as `[]` ("armed nothing") —
   *  collapsing the two makes the picker state something OAP never said. */
  targets: ContinuousProfilingTargetType[] | null;
}

export async function policySummaryForServices(
  opts: GraphqlOptions,
  services: ReadonlyArray<{ id: string; name: string }>,
): Promise<{ rows: PolicySummaryRow[]; checked: number; total: number }> {
  const wanted = services.slice(0, SUMMARY_MAX_SERVICES);
  const rows = await mapPool(wanted, SUMMARY_CONCURRENCY, async (r): Promise<PolicySummaryRow> => {
    try {
      const d = await graphqlPost<{ targets: Array<{ type: ContinuousProfilingTargetType }> }>(
        opts,
        QUERY_POLICY_TYPES,
        { serviceId: r.id },
      );
      return { id: r.id, name: r.name, targets: (d.targets ?? []).map((t) => t.type) };
    } catch {
      // One unreadable service must not lose the other 119.
      return { id: r.id, name: r.name, targets: null };
    }
  });
  return { rows, checked: wanted.length, total: services.length };
}
