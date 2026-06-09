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
  TraceDetailResponse,
  TraceListResponse,
  TraceQueryOrder,
  TraceQueryState,
  TraceSource,
} from '@skywalking-horizon-ui/api-client';
import type { BffClient } from '../client';

/** `bff.trace` — native trace list + detail + tag autocomplete. */
export class TraceApi {
  constructor(private readonly bff: BffClient) {}

  list(
    layerKey: string,
    body: {
      source?: TraceSource;
      service?: string;
      serviceId?: string;
      instanceId?: string;
      endpointId?: string;
      traceId?: string;
      traceState?: TraceQueryState;
      queryOrder?: TraceQueryOrder;
      minTraceDuration?: number;
      maxTraceDuration?: number;
      pageNum?: number;
      pageSize?: number;
      tags?: Array<{ key: string; value: string }>;
      windowMinutes?: number;
      start?: string;
      end?: string;
      /** Admin preview: the operator's draft `traces` block (JSON string). */
      previewConfig?: string;
    } = {},
  ): Promise<TraceListResponse> {
    return this.bff.request<TraceListResponse>(
      'POST',
      `/api/layer/${encodeURIComponent(layerKey)}/traces`,
      body,
    );
  }

  detail(
    traceId: string,
    source: 'native' | 'zipkin' = 'native',
    /** Approximate window the trace lives in (epoch ms + OAP step).
     *  Required when the trace is older than ~1 day on BanyanDB —
     *  `queryTrace` defaults to a 1-day search and an older trace ID
     *  returns null without it. Callers without a hint (e.g. directly
     *  pasting a trace ID into the URL) can omit and rely on the
     *  1-day fallback. The BFF converts ms → OAP-server-TZ format. */
    range?: { startMs: number; endMs: number; step: 'MINUTE' | 'HOUR' | 'DAY' },
  ): Promise<TraceDetailResponse> {
    const qs = new URLSearchParams({ source });
    if (range) {
      qs.set('startMs', String(range.startMs));
      qs.set('endMs', String(range.endMs));
      qs.set('step', range.step);
    }
    return this.bff.request<TraceDetailResponse>(
      'GET',
      `/api/trace/${encodeURIComponent(traceId)}?${qs.toString()}`,
    );
  }

  tagKeys(windowMinutes = 30): Promise<{ keys: string[]; generatedAt: number; error?: string }> {
    return this.bff.request('GET', `/api/trace-tags/keys?windowMinutes=${windowMinutes}`);
  }
  tagValues(
    key: string,
    windowMinutes = 30,
  ): Promise<{ key: string; values: string[]; generatedAt: number; error?: string }> {
    return this.bff.request(
      'GET',
      `/api/trace-tags/values?key=${encodeURIComponent(key)}&windowMinutes=${windowMinutes}`,
    );
  }
}
