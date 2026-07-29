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

import type {
  ContinuousProfilingInstancesResponse,
  ContinuousProfilingPoliciesResponse,
  ContinuousProfilingPolicyTarget,
  ContinuousProfilingSetResponse,
  ContinuousProfilingTargetType,
} from '@skywalking-horizon-ui/api-client';
import type { BffClient } from '../client';

/** `bff.continuousProfiling` — the auto-trigger policies behind
 *  continuous profiling (as opposed to the on-demand profiling tasks). */
export class ContinuousProfilingApi {
  constructor(private readonly bff: BffClient) {}

  policies(serviceId: string): Promise<ContinuousProfilingPoliciesResponse> {
    return this.bff.request<ContinuousProfilingPoliciesResponse>(
      'GET',
      `/api/continuous-profiling/policies?service=${encodeURIComponent(serviceId)}`,
    );
  }

  /** Replaces the service's WHOLE policy — send every target you want kept,
   *  because OAP treats the omitted ones as deleted. */
  savePolicies(
    serviceId: string,
    targets: ContinuousProfilingPolicyTarget[],
  ): Promise<ContinuousProfilingSetResponse> {
    return this.bff.request<ContinuousProfilingSetResponse>('POST', '/api/continuous-profiling/policies', {
      serviceId,
      targets,
    });
  }

  /** Which targets each service of a layer has armed — so the picker can say
   *  "songs · ON_CPU, NETWORK" instead of a bare name.
   *
   *  `targets: null` means OAP would not answer for that service. It is NOT the
   *  same as `[]` ("armed nothing"), and callers must not filter or label the
   *  two the same way. */
  policySummary(layer: string): Promise<{
    services: Array<{ id: string; name: string; targets: ContinuousProfilingTargetType[] | null }>;
    checked: number;
    total: number;
    reachable: boolean;
    error?: string;
  }> {
    return this.bff.request(
      'GET',
      `/api/continuous-profiling/policy-summary?layer=${encodeURIComponent(layer)}`,
    );
  }

  /** ONE roster for all requested targets. The instance/process list is
   *  target-invariant on OAP's side, so asking per target would ship it N times. */
  instances(
    serviceId: string,
    targets: ContinuousProfilingTargetType[],
  ): Promise<ContinuousProfilingInstancesResponse> {
    const qs = new URLSearchParams({ service: serviceId, targets: targets.join(',') });
    return this.bff.request<ContinuousProfilingInstancesResponse>(
      'GET',
      `/api/continuous-profiling/instances?${qs.toString()}`,
    );
  }
}
