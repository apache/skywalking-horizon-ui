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
import { serviceRefFields, type ServiceRef } from '@/utils/serviceRef';

/** `bff.ebpf` — fixed-time eBPF profiling (ON_CPU / OFF_CPU). */
export class EbpfApi {
  constructor(private readonly bff: BffClient) {}

  /** Scoped by the roster row the screen picked — id and name together. */
  tasks(layerKey: string, service: ServiceRef): Promise<EBPFTaskListResponse> {
    const qs = new URLSearchParams(serviceRefFields(service));
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
  /** A task's schedules, of the page's layer and service — the task is the
   *  service's it was created for. */
  schedules(layerKey: string, service: ServiceRef, taskId: string): Promise<EBPFSchedulesResponse> {
    const qs = new URLSearchParams({ serviceId: service.id });
    return this.bff.request<EBPFSchedulesResponse>(
      'GET',
      `/api/layer/${encodeURIComponent(layerKey)}/ebpf/tasks/${encodeURIComponent(taskId)}/schedules?${qs.toString()}`,
    );
  }
  /** Analyze schedules of one task, on the page's layer and service: the
   *  schedules must be the task's, on that service's processes. */
  analyze(layerKey: string, service: ServiceRef, taskId: string, body: EBPFAnalyzeRequest): Promise<EBPFAnalyzeResponse> {
    return this.bff.request<EBPFAnalyzeResponse>(
      'POST',
      `/api/layer/${encodeURIComponent(layerKey)}/ebpf/tasks/${encodeURIComponent(taskId)}/analyze`,
      { ...body, serviceId: service.id },
    );
  }
}
