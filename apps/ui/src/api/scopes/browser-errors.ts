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

import type { BffClient } from '../client';
import type {
  BrowserErrorsQueryRequest,
  BrowserErrorsResponse,
  ResolveRequest,
  ResolveResponse,
  SourceMapListResponse,
  SourceMapUploadResponse,
} from '@skywalking-horizon-ui/api-client';

/**
 * BROWSER-layer error logs + their in-memory source-map cache (#6784).
 * `list` is the error feed; the source-map calls manage the BFF-resident
 * maps and `resolve` de-obfuscates a stack against a chosen map.
 */
export class BrowserErrorsApi {
  constructor(private readonly bff: BffClient) {}

  list(
    layerKey: string,
    body: BrowserErrorsQueryRequest & { service?: string } = {},
  ): Promise<BrowserErrorsResponse> {
    return this.bff.request<BrowserErrorsResponse>(
      'POST',
      `/api/layer/${encodeURIComponent(layerKey)}/browser-errors`,
      body,
    );
  }

  listSourceMaps(): Promise<SourceMapListResponse> {
    return this.bff.request<SourceMapListResponse>('GET', '/api/browser-errors/source-maps');
  }

  uploadSourceMap(file: File): Promise<SourceMapUploadResponse> {
    const form = new FormData();
    form.append('file', file, file.name);
    return this.bff.requestForm<SourceMapUploadResponse>('POST', '/api/browser-errors/source-maps', form);
  }

  deleteSourceMap(id: string): Promise<{ ok: boolean }> {
    return this.bff.request<{ ok: boolean }>(
      'DELETE',
      `/api/browser-errors/source-maps/${encodeURIComponent(id)}`,
    );
  }

  resolve(body: ResolveRequest): Promise<ResolveResponse> {
    return this.bff.request<ResolveResponse>('POST', '/api/browser-errors/resolve', body);
  }
}
