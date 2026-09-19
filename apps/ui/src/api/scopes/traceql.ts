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
  TraceQLDatasource,
  TraceQLSourceStatus,
  TraceQLTagsResponse,
  TraceQLTagValuesResponse,
  TraceQLTraceDetailResponse,
  TraceQLTraceListResponse,
} from '@skywalking-horizon-ui/api-client';
import type { BffClient } from '../client';

export interface TraceQLWindow {
  startMs: number;
  endMs: number;
}

/** `bff.traceql` — OAP's Tempo API, one datasource per call. Trace ids are
 *  the real ones throughout; the hex wire form never reaches the browser. */
export class TraceQLApi {
  constructor(private readonly bff: BffClient) {}

  sources(signal?: AbortSignal): Promise<TraceQLSourceStatus[]> {
    return this.bff.request('GET', '/api/traceql/sources', undefined, undefined, signal);
  }

  search(
    ds: TraceQLDatasource,
    q: string,
    window: TraceQLWindow,
    limit: number,
    signal?: AbortSignal,
  ): Promise<TraceQLTraceListResponse> {
    const p = new URLSearchParams({
      startMs: String(window.startMs),
      endMs: String(window.endMs),
      limit: String(limit),
    });
    if (q.trim()) p.set('q', q.trim());
    return this.bff.request('GET', `/api/traceql/${ds}/search?${p.toString()}`, undefined, undefined, signal);
  }

  /** Omitting the window is the "no time range" lookup this API answers by
   *  searching its whole history. */
  trace(
    ds: TraceQLDatasource,
    traceId: string,
    window?: TraceQLWindow,
    signal?: AbortSignal,
  ): Promise<TraceQLTraceDetailResponse> {
    const p = new URLSearchParams();
    if (window) {
      p.set('startMs', String(window.startMs));
      p.set('endMs', String(window.endMs));
    }
    const qs = p.toString();
    return this.bff.request(
      'GET',
      `/api/traceql/${ds}/trace/${encodeURIComponent(traceId)}${qs ? '?' + qs : ''}`,
      undefined,
      undefined,
      signal,
    );
  }

  tags(ds: TraceQLDatasource, window: TraceQLWindow, signal?: AbortSignal): Promise<TraceQLTagsResponse> {
    const p = new URLSearchParams({ startMs: String(window.startMs), endMs: String(window.endMs) });
    return this.bff.request('GET', `/api/traceql/${ds}/tags?${p.toString()}`, undefined, undefined, signal);
  }

  /** `layer` lets the BFF apply that layer's service filter — the Tempo API
   *  has no notion of a layer, so the picker is narrowed here or nowhere. */
  tagValues(
    ds: TraceQLDatasource,
    tag: string,
    window: TraceQLWindow,
    opts: { q?: string; layer?: string; previewConfig?: string; signal?: AbortSignal } = {},
  ): Promise<TraceQLTagValuesResponse> {
    const p = new URLSearchParams({
      tag,
      startMs: String(window.startMs),
      endMs: String(window.endMs),
    });
    if (opts.q) p.set('q', opts.q);
    if (opts.layer) p.set('layer', opts.layer);
    if (opts.previewConfig) p.set('previewConfig', opts.previewConfig);
    return this.bff.request('GET', `/api/traceql/${ds}/tag-values?${p.toString()}`, undefined, undefined, opts.signal);
  }
}
