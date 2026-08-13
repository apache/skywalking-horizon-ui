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
  AsyncProfilingAnalyzeResponse,
  AsyncProfilingProgressResponse,
  AsyncProfilingTaskCreationRequest,
  AsyncProfilingTaskCreationResponse,
  AsyncProfilingTaskListResponse,
} from '@skywalking-horizon-ui/api-client';
import type { BffClient } from '../client';
import { serviceRefFields, type ServiceRef } from '@/utils/serviceRef';

/** `bff.asyncProfile` — Async Profiler (JVM) tasks. */
export class AsyncProfileApi {
  constructor(private readonly bff: BffClient) {}

  /** Scoped by the roster row the screen picked — id and name together. */
  tasks(layerKey: string, service: ServiceRef): Promise<AsyncProfilingTaskListResponse> {
    return this.bff.request<AsyncProfilingTaskListResponse>(
      'GET',
      `/api/layer/${encodeURIComponent(layerKey)}/async/tasks?${new URLSearchParams(serviceRefFields(service)).toString()}`,
    );
  }
  create(
    layerKey: string,
    body: AsyncProfilingTaskCreationRequest,
  ): Promise<AsyncProfilingTaskCreationResponse> {
    return this.bff.request<AsyncProfilingTaskCreationResponse>(
      'POST',
      `/api/layer/${encodeURIComponent(layerKey)}/async/tasks`,
      body,
    );
  }
  progress(taskId: string): Promise<AsyncProfilingProgressResponse> {
    return this.bff.request<AsyncProfilingProgressResponse>(
      'GET',
      `/api/async/tasks/${encodeURIComponent(taskId)}/progress`,
    );
  }
  analyze(body: {
    taskId: string;
    instanceIds: string[];
    eventType: string;
  }): Promise<AsyncProfilingAnalyzeResponse> {
    return this.bff.request<AsyncProfilingAnalyzeResponse>('POST', '/api/async/analyze', body);
  }
}
