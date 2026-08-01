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
  EBPFAnalyzeRequest,
  EBPFAnalyzeResponse,
  EBPFSchedulesResponse,
  EBPFTaskCreationRequest,
  EBPFTaskCreationResponse,
  EBPFTaskListResponse,
} from '@skywalking-horizon-ui/api-client';
import type { BffClient } from '../client';

/** `bff.ebpf` — fixed-time eBPF profiling (ON_CPU / OFF_CPU). */
export class EbpfApi {
  constructor(private readonly bff: BffClient) {}

  /** `serviceId` is the OAP id, not a name — the BFF trusts it as an id and
   *  skips the roster lookup a name would need. */
  tasks(layerKey: string, serviceId: string): Promise<EBPFTaskListResponse> {
    const qs = new URLSearchParams({ serviceId });
    return this.bff.request<EBPFTaskListResponse>(
      'GET',
      `/api/layer/${encodeURIComponent(layerKey)}/ebpf/tasks?${qs.toString()}`,
    );
  }
  create(
    layerKey: string,
    body: EBPFTaskCreationRequest,
  ): Promise<EBPFTaskCreationResponse> {
    return this.bff.request<EBPFTaskCreationResponse>(
      'POST',
      `/api/layer/${encodeURIComponent(layerKey)}/ebpf/tasks`,
      body,
    );
  }
  schedules(taskId: string): Promise<EBPFSchedulesResponse> {
    return this.bff.request<EBPFSchedulesResponse>(
      'GET',
      `/api/ebpf/tasks/${encodeURIComponent(taskId)}/schedules`,
    );
  }
  analyze(body: EBPFAnalyzeRequest): Promise<EBPFAnalyzeResponse> {
    return this.bff.request<EBPFAnalyzeResponse>('POST', '/api/ebpf/analyze', body);
  }
}
