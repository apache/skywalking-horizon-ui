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
  ZipkinTraceDetailResponse,
  ZipkinTraceListResponse,
} from '@skywalking-horizon-ui/api-client';
import type { BffClient, ZipkinTraceQuery } from '../client';

/** `bff.zipkin` — Zipkin v2 REST passthrough (services / spans / traces
 *  / annotation-autocomplete). Used by mesh-layer trace views that
 *  consume Envoy-emitted Zipkin spans instead of SW-native segments. */
export class ZipkinApi {
  constructor(private readonly bff: BffClient) {}

  services(): Promise<string[]> {
    return this.bff.request('GET', '/api/zipkin/services');
  }
  spans(serviceName: string): Promise<string[]> {
    return this.bff.request(
      'GET',
      `/api/zipkin/spans?serviceName=${encodeURIComponent(serviceName)}`,
    );
  }
  remoteServices(serviceName: string): Promise<string[]> {
    return this.bff.request(
      'GET',
      `/api/zipkin/remote-services?serviceName=${encodeURIComponent(serviceName)}`,
    );
  }
  traces(q: ZipkinTraceQuery = {}): Promise<ZipkinTraceListResponse> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) {
        if (v.length > 0) params.set(k, v.join(','));
        continue;
      }
      params.set(k, String(v));
    }
    const qs = params.toString();
    return this.bff.request<ZipkinTraceListResponse>(
      'GET',
      `/api/zipkin/traces${qs ? '?' + qs : ''}`,
    );
  }
  /** One trace by id. `window` is the list's `endTs` + `lookback` when the
   *  caller has them: with the Cold pill on, OAP bounds the lookup to a window
   *  and a cold trace is older than the default day. */
  trace(traceId: string, window?: { endTs?: number | null; lookback?: number | null }): Promise<ZipkinTraceDetailResponse> {
    const params = new URLSearchParams();
    const given = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    if (given(window?.endTs)) params.set('endTs', String(window!.endTs));
    if (given(window?.lookback)) params.set('lookback', String(window!.lookback));
    const qs = params.toString();
    return this.bff.request<ZipkinTraceDetailResponse>(
      'GET',
      `/api/zipkin/trace/${encodeURIComponent(traceId)}${qs ? '?' + qs : ''}`,
    );
  }
  autocompleteKeys(): Promise<string[]> {
    return this.bff.request<string[]>('GET', '/api/zipkin/autocomplete/keys');
  }
  autocompleteValues(key: string): Promise<string[]> {
    return this.bff.request<string[]>(
      'GET',
      `/api/zipkin/autocomplete/values?key=${encodeURIComponent(key)}`,
    );
  }
}
