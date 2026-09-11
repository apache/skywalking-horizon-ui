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
import { useResultTracePopout } from './useResultTracePopout';

const popouts = vi.hoisted(() => ({ native: vi.fn(), otlp: vi.fn() }));
vi.mock('./useTracePopout', () => ({ useTracePopout: () => ({ openTrace: popouts.native }) }));
vi.mock('./useZipkinTracePopout', () => ({ useZipkinTracePopout: () => ({ openTrace: popouts.otlp }) }));

const AT = 1788393600000;
beforeEach(() => vi.clearAllMocks());

describe('useResultTracePopout', () => {
  it('opens a native record on the native popout with the record time as the lookup moment', () => {
    useResultTracePopout().openResultTrace({ type: 'SKYWALKING_NATIVE', traceId: 'trace-1', segmentId: 'seg-1', spanIndex: 2 }, AT);
    expect(popouts.native).toHaveBeenCalledWith('trace-1', AT, 'SKYWALKING_NATIVE', { segmentId: 'seg-1', spanIndex: 2, spanId: null });
    expect(popouts.otlp).not.toHaveBeenCalled();
  });

  it('opens an OTLP record on the Zipkin popout and keeps the record time, so an old trace is looked up where it is', () => {
    useResultTracePopout().openResultTrace({ type: 'OTLP', traceId: 'trace-2', spanId: 'span-2' }, AT);
    expect(popouts.otlp).toHaveBeenCalledWith('trace-2', { segmentId: null, spanIndex: null, spanId: 'span-2', at: AT });
  });

  it('ignores a record with no trace', () => {
    useResultTracePopout().openResultTrace({ type: 'OTLP', traceId: '' }, AT);
    expect(popouts.otlp).not.toHaveBeenCalled();
    expect(popouts.native).not.toHaveBeenCalled();
  });
});
