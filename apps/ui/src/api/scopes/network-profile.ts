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
  EBPFTaskListResponse,
  NetworkProfilingCreateRequest,
  NetworkProfilingCreateResponse,
  NetworkProfilingKeepAliveResponse,
  ProcessRelationEndpointRef,
  ProcessRelationMetricsResponse,
  ProcessTopologyResponse,
} from '@skywalking-horizon-ui/api-client';
import type { BffClient } from '../client';

/** `bff.networkProfile` — eBPF continuous-network profiling
 *  (NETWORK + CONTINUOUS_PROFILING task families). */
export class NetworkProfileApi {
  constructor(private readonly bff: BffClient) {}

  tasks(
    layerKey: string,
    args: { service?: string; serviceInstance?: string },
  ): Promise<EBPFTaskListResponse> {
    const qs = new URLSearchParams();
    if (args.service) qs.set('service', args.service);
    if (args.serviceInstance) qs.set('serviceInstance', args.serviceInstance);
    return this.bff.request<EBPFTaskListResponse>(
      'GET',
      `/api/layer/${encodeURIComponent(layerKey)}/ebpf/network/tasks?${qs.toString()}`,
    );
  }

  /** Process topology for an instance. Pass an explicit `startTime`/
   *  `endTime` (ms epoch) to pin the view to a finished task's capture
   *  window — the task's instance only reported eBPF processes during
   *  that window. Omit them for the rolling live view (`windowMinutes`). */
  topology(
    serviceInstance: string,
    opts: { windowMinutes?: number; startTime?: number; endTime?: number } = {},
  ): Promise<ProcessTopologyResponse> {
    const qs = new URLSearchParams({ serviceInstance });
    if (opts.startTime !== undefined && opts.endTime !== undefined) {
      qs.set('startTime', String(opts.startTime));
      qs.set('endTime', String(opts.endTime));
    } else {
      qs.set('windowMinutes', String(opts.windowMinutes ?? 30));
    }
    return this.bff.request<ProcessTopologyResponse>(
      'GET',
      `/api/ebpf/network/topology?${qs.toString()}`,
    );
  }

  create(body: NetworkProfilingCreateRequest): Promise<NetworkProfilingCreateResponse> {
    return this.bff.request<NetworkProfilingCreateResponse>(
      'POST',
      '/api/ebpf/network/tasks',
      body,
    );
  }

  keepAlive(taskId: string): Promise<NetworkProfilingKeepAliveResponse> {
    return this.bff.request<NetworkProfilingKeepAliveResponse>(
      'POST',
      `/api/ebpf/network/tasks/${encodeURIComponent(taskId)}/keep-alive`,
    );
  }

  /** Process-relation (edge) metrics for a clicked process→process call.
   *  `layerKey` selects the processTopology MQE config; source/dest are
   *  identified by service / instance / process NAME. */
  relationMetrics(
    layerKey: string,
    body: {
      source: ProcessRelationEndpointRef;
      dest: ProcessRelationEndpointRef;
      /** Profiling-task window (ms epoch); preferred over windowMinutes. */
      startTime?: number;
      endTime?: number;
      windowMinutes?: number;
      /** Admin preview: the operator's draft `processTopology` block. */
      previewConfig?: string;
    },
  ): Promise<ProcessRelationMetricsResponse> {
    return this.bff.request<ProcessRelationMetricsResponse>(
      'POST',
      `/api/layer/${encodeURIComponent(layerKey)}/ebpf/network/process-relation-metrics`,
      body,
    );
  }
}
