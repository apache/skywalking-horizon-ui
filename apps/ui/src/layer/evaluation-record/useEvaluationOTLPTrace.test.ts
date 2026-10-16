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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readEvaluationOTLPTrace } from './useEvaluationOTLPTrace';

const api = vi.hoisted(() => ({ sources: vi.fn(), otlp: vi.fn(), zipkin: vi.fn() }));
vi.mock('@/api/client', () => ({ bffClient: {
  traceql: { sources: api.sources, trace: api.otlp }, zipkin: { trace: api.zipkin },
} }));
const window = { startMs: 1000, endMs: 5000 };
beforeEach(() => {
  vi.resetAllMocks();
  api.sources.mockResolvedValue([{ ds: 'otlp', configured: true, reachable: true }]);
  api.otlp.mockResolvedValue({ ds: 'otlp', traceId: 'trace', reachable: true, notFound: false, spans: [{ spanId: 'span' }] });
  api.zipkin.mockResolvedValue({ traceId: 'trace', reachable: true, spans: [{ id: 'legacy-span' }] });
});

describe('evaluation OTLP storage selection', () => {
  it('reads native OTLP directly, preserving the window and cancellation signal', async () => {
    const signal = new AbortController().signal;
    const result = await readEvaluationOTLPTrace('trace', window, signal);
    expect(result.source).toBe('otlp');
    expect(api.otlp).toHaveBeenCalledWith('otlp', 'trace', window, signal);
    expect(api.zipkin).not.toHaveBeenCalled();
  });

  it.each([
    { configured: false, reachable: false },
    { configured: true, reachable: false, served: false },
  ])('supports legacy Zipkin when OTLP is explicitly unavailable: %j', async (status) => {
    api.sources.mockResolvedValue([{ ds: 'otlp', ...status }]);
    expect((await readEvaluationOTLPTrace('trace', window)).source).toBe('zipkin');
    expect(api.otlp).not.toHaveBeenCalled();
    expect(api.zipkin).toHaveBeenCalledWith('trace', { endTs: 5000, lookback: 4000 });
  });

  it('looks for a legacy trace after a successful native miss', async () => {
    api.otlp.mockResolvedValue({ reachable: true, notFound: true, spans: [] });
    expect((await readEvaluationOTLPTrace('trace', null)).source).toBe('zipkin');
    expect(api.zipkin).toHaveBeenCalledWith('trace', { endTs: null, lookback: null });
  });

  it('keeps a successful empty native answer available for retry instead of querying legacy storage', async () => {
    api.otlp.mockResolvedValue({ reachable: true, notFound: false, spans: [] });
    expect((await readEvaluationOTLPTrace('trace', window)).source).toBe('otlp');
    expect(api.zipkin).not.toHaveBeenCalled();
  });

  it('keeps a native query failure instead of trying Zipkin', async () => {
    api.otlp.mockResolvedValue({ reachable: false, notFound: false, spans: [], error: 'timeout' });
    const result = await readEvaluationOTLPTrace('trace', window);
    expect(result.source).toBe('otlp');
    expect(result.detail.error).toBe('timeout');
    expect(api.zipkin).not.toHaveBeenCalled();
  });

  it('does not mistake a failed probe for a disabled datasource', async () => {
    api.sources.mockResolvedValue([{ ds: 'otlp', configured: true, reachable: false, error: 'timeout' }]);
    api.otlp.mockResolvedValue({ reachable: false, notFound: false, spans: [], error: 'timeout' });
    expect((await readEvaluationOTLPTrace('trace', window)).source).toBe('otlp');
    expect(api.zipkin).not.toHaveBeenCalled();
  });

  it.each(['sources', 'otlp'] as const)('propagates a refused or failed %s request', async (method) => {
    api[method].mockRejectedValue(new Error('permission_denied'));
    await expect(readEvaluationOTLPTrace('trace', window)).rejects.toThrow('permission_denied');
    expect(api.zipkin).not.toHaveBeenCalled();
  });

  it('rejects an incomplete source-status response', async () => {
    api.sources.mockResolvedValue([]);
    await expect(readEvaluationOTLPTrace('trace', window)).rejects.toThrow('source status is missing');
    expect(api.zipkin).not.toHaveBeenCalled();
  });
});
