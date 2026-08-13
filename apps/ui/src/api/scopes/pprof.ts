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
  PprofAnalyzeResponse,
  PprofProgressResponse,
  PprofTaskCreationRequest,
  PprofTaskCreationResponse,
  PprofTaskListResponse,
} from '@skywalking-horizon-ui/api-client';
import type { BffClient } from '../client';
import { serviceRefFields, type ServiceRef } from '@/utils/serviceRef';

/** `bff.pprof` — Go pprof profiling tasks. */
export class PprofApi {
  constructor(private readonly bff: BffClient) {}

  /** Scoped by the roster row the screen picked — id and name together. */
  tasks(layerKey: string, service: ServiceRef): Promise<PprofTaskListResponse> {
    return this.bff.request<PprofTaskListResponse>(
      'GET',
      `/api/layer/${encodeURIComponent(layerKey)}/pprof/tasks?${new URLSearchParams(serviceRefFields(service)).toString()}`,
    );
  }
  create(
    layerKey: string,
    body: PprofTaskCreationRequest,
  ): Promise<PprofTaskCreationResponse> {
    return this.bff.request<PprofTaskCreationResponse>(
      'POST',
      `/api/layer/${encodeURIComponent(layerKey)}/pprof/tasks`,
      body,
    );
  }
  progress(taskId: string): Promise<PprofProgressResponse> {
    return this.bff.request<PprofProgressResponse>(
      'GET',
      `/api/pprof/tasks/${encodeURIComponent(taskId)}/progress`,
    );
  }
  analyze(body: {
    taskId: string;
    instanceIds: string[];
  }): Promise<PprofAnalyzeResponse> {
    return this.bff.request<PprofAnalyzeResponse>('POST', '/api/pprof/analyze', body);
  }
}
