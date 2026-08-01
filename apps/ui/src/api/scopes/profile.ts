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
  ProfileAnalyzationResponse,
  ProfileAnalyzeQuery,
  ProfileSegmentsResponse,
  ProfileTaskCreationRequest,
  ProfileTaskCreationResponse,
  ProfileTaskListResponse,
  ProfileTaskLogsResponse,
} from '@skywalking-horizon-ui/api-client';
import type { BffClient } from '../client';

/** `bff.profile` — agent-side trace profiling: list / create tasks,
 *  fetch sampled segments + per-instance op logs, resolve into trees. */
export class ProfileApi {
  constructor(private readonly bff: BffClient) {}

  /** `serviceId` is the OAP id, not a name — the BFF trusts it as an id and
   *  skips the roster lookup a name would need. */
  tasks(
    layerKey: string,
    serviceId: string,
    endpoint = '',
  ): Promise<ProfileTaskListResponse> {
    const qs = new URLSearchParams({ serviceId });
    if (endpoint) qs.set('endpoint', endpoint);
    return this.bff.request<ProfileTaskListResponse>(
      'GET',
      `/api/layer/${encodeURIComponent(layerKey)}/profile/tasks?${qs.toString()}`,
    );
  }

  create(
    layerKey: string,
    body: ProfileTaskCreationRequest,
  ): Promise<ProfileTaskCreationResponse> {
    return this.bff.request<ProfileTaskCreationResponse>(
      'POST',
      `/api/layer/${encodeURIComponent(layerKey)}/profile/tasks`,
      body,
    );
  }

  segments(taskId: string): Promise<ProfileSegmentsResponse> {
    return this.bff.request<ProfileSegmentsResponse>(
      'GET',
      `/api/profile/tasks/${encodeURIComponent(taskId)}/segments`,
    );
  }

  logs(taskId: string): Promise<ProfileTaskLogsResponse> {
    return this.bff.request<ProfileTaskLogsResponse>(
      'GET',
      `/api/profile/tasks/${encodeURIComponent(taskId)}/logs`,
    );
  }

  analyze(queries: ProfileAnalyzeQuery[]): Promise<ProfileAnalyzationResponse> {
    return this.bff.request<ProfileAnalyzationResponse>('POST', '/api/profile/analyze', {
      queries,
    });
  }
}
