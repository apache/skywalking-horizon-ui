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
  LogFacetsResponse,
  LogQueryRequest,
  LogsResponse,
  TraceLogsRequest,
  TraceLogsResponse,
} from '@skywalking-horizon-ui/api-client';
import type { BffClient } from '../client';

/** `bff.log` — log query + facets + tag autocomplete. */
export class LogApi {
  constructor(private readonly bff: BffClient) {}

  list(
    layerKey: string,
    body: LogQueryRequest & { service?: string } = {},
  ): Promise<LogsResponse> {
    return this.bff.request<LogsResponse>(
      'POST',
      `/api/layer/${encodeURIComponent(layerKey)}/logs`,
      body,
    );
  }

  facets(
    layerKey: string,
    body: LogQueryRequest & { service?: string; sampleSize?: number } = {},
  ): Promise<LogFacetsResponse> {
    return this.bff.request<LogFacetsResponse>(
      'POST',
      `/api/layer/${encodeURIComponent(layerKey)}/logs/facets`,
      body,
    );
  }

  /** The log lines carrying a trace's id — or one span's: a native span by its
   *  segment and span id, an OTLP or Zipkin span by its hex id — read around
   *  the trace's own span range. */
  forTrace(traceId: string, req: TraceLogsRequest, signal?: AbortSignal): Promise<TraceLogsResponse> {
    const q = new URLSearchParams({ startMs: String(req.startMs), endMs: String(req.endMs) });
    if (req.segmentId) q.set('segmentId', req.segmentId);
    if (req.spanId !== undefined) q.set('spanId', String(req.spanId));
    if (req.otlpSpanId) q.set('otlpSpanId', req.otlpSpanId);
    if (req.altTraceId) q.set('altTraceId', req.altTraceId);
    if (req.page) q.set('page', String(req.page));
    if (req.pageSize) q.set('pageSize', String(req.pageSize));
    return this.bff.request<TraceLogsResponse>(
      'GET',
      `/api/trace/${encodeURIComponent(traceId)}/logs?${q.toString()}`,
      undefined,
      undefined,
      signal,
    );
  }

  tagKeys(windowMinutes = 30): Promise<{ keys: string[]; generatedAt: number; error?: string }> {
    return this.bff.request('GET', `/api/log-tags/keys?windowMinutes=${windowMinutes}`);
  }
  tagValues(
    key: string,
    windowMinutes = 30,
  ): Promise<{ key: string; values: string[]; generatedAt: number; error?: string }> {
    return this.bff.request(
      'GET',
      `/api/log-tags/values?key=${encodeURIComponent(key)}&windowMinutes=${windowMinutes}`,
    );
  }

  // ── On-demand pod logs (live tail) ───────────────────────────────

  /** List a pod's containers. `errorReason` is non-null when the pod
   *  can't be resolved (stale instance) or the OAP feature is off. */
  podContainers(layerKey: string, instanceId: string): Promise<PodContainersResponse> {
    return this.bff.request<PodContainersResponse>(
      'GET',
      `/api/layer/${encodeURIComponent(layerKey)}/pod-logs/containers?instance=${encodeURIComponent(instanceId)}`,
    );
  }

  /** Tail one container's logs over a rolling SECOND window. */
  podLogs(layerKey: string, body: PodLogsRequest): Promise<PodLogsResponse> {
    return this.bff.request<PodLogsResponse>(
      'POST',
      `/api/layer/${encodeURIComponent(layerKey)}/pod-logs`,
      body,
    );
  }
}

export interface PodContainersResponse {
  containers: string[];
  errorReason: string | null;
  reachable: boolean;
  error?: string;
  generatedAt: number;
}

export interface PodLogsRequest {
  serviceInstanceId: string;
  container: string;
  windowSeconds?: number;
  keywordsOfContent?: string[];
  excludingKeywordsOfContent?: string[];
}

export interface PodLogLine {
  content: string;
  /** ms epoch (BFF converts OAP's epoch-seconds), or null. */
  timestamp: number | null;
}

export interface PodLogsResponse {
  lines: PodLogLine[];
  errorReason: string | null;
  reachable: boolean;
  error?: string;
  generatedAt: number;
  window: { start: string; end: string; step: 'SECOND' };
}
