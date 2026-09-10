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

import { describe, expect, it } from 'vitest';
import { clearTraceFocus, withTraceFocus } from './tracePopoutQuery';

describe('trace popout query state', () => {
  it('adds focus fields without changing unrelated preview source', () => {
    const query = withTraceFocus({ source: 'bundled', traceId: 'old' }, {
      segmentId: 'segment-1', spanIndex: 3, spanId: 'span-7',
    });
    expect(query).toMatchObject({
      source: 'bundled', traceId: 'old', traceSegmentId: 'segment-1', traceSpanIndex: '3', traceSpanId: 'span-7',
    });
  });

  it('replaces stale focus fields when the next result has no focus', () => {
    const query = withTraceFocus({ source: 'local', traceSpanId: 'stale', traceSpanIndex: '2' });
    expect(query).toEqual({ source: 'local' });
  });

  it('preserves a zero span index instead of treating it as absent', () => {
    const query = withTraceFocus({ source: 'local' }, { spanIndex: 0 });
    expect(query.traceSpanIndex).toBe('0');
  });

  it('clears focus fields while retaining trace type and source', () => {
    const query = clearTraceFocus({ source: 'remote', traceType: 'OTLP', traceId: 'abc', traceSpanId: 's' });
    expect(query).toEqual({ source: 'remote', traceType: 'OTLP', traceId: 'abc' });
  });
});
