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

import { describe, expect, it, vi } from 'vitest';
import '../client';
import { ZipkinApi } from './zipkin';
import type { BffClient } from '../client';

function api(): { api: ZipkinApi; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn().mockResolvedValue({ source: 'zipkin', traceId: 'abc', spans: [], reachable: true });
  const bff = { request } as unknown as BffClient;
  return { api: new ZipkinApi(bff), request };
}

describe('bff.zipkin.trace', () => {
  it('carries the window the trace was listed in, so a cold-stage lookup is bounded there', async () => {
    const { api: a, request } = api();
    await a.trace('abc', { endTs: 1700000000000, lookback: 86400000 });
    expect(request).toHaveBeenCalledWith('GET', '/api/zipkin/trace/abc?endTs=1700000000000&lookback=86400000');
  });

  it('keeps an explicit zero lookback, which OAP would otherwise widen to its default', async () => {
    const { api: a, request } = api();
    await a.trace('abc', { endTs: 1700000000000, lookback: 0 });
    expect(request).toHaveBeenCalledWith('GET', '/api/zipkin/trace/abc?endTs=1700000000000&lookback=0');
  });

  it('asks for nothing but the id when it has no window', async () => {
    const { api: a, request } = api();
    await a.trace('abc');
    await a.trace('abc', { endTs: null, lookback: null });
    expect(request).toHaveBeenNthCalledWith(1, 'GET', '/api/zipkin/trace/abc');
    expect(request).toHaveBeenNthCalledWith(2, 'GET', '/api/zipkin/trace/abc');
  });
});
