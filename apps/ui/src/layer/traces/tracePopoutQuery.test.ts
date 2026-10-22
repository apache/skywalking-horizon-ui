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
import { clearTraceAddress, traceLink, traceStoreOf, withTraceFocus } from './tracePopoutQuery';

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

  it('clears the whole trace address and keeps the preview source', () => {
    const query = clearTraceAddress({
      source: 'remote', traceId: 'abc', traceType: 'zipkin', traceAt: '1', traceEnd: '2', traceLookback: '3',
      traceSegmentId: 'seg', traceSpanIndex: '0', traceSpanId: 's', service: 'db',
    });
    expect(query).toEqual({ source: 'remote', service: 'db' });
  });

  it('names a trace source only for the names layer templates use', () => {
    for (const type of ['native', 'zipkin', 'traceql-native', 'traceql-zipkin', 'traceql-otlp']) {
      expect(traceStoreOf({ traceType: type })).toBe(type);
    }
    expect(traceStoreOf({ traceType: 'ZIPKIN' })).toBeNull();
    expect(traceStoreOf({ traceType: 'otlp' })).toBeNull();
    expect(traceStoreOf({ source: 'zipkin' })).toBeNull();
  });

  it('links a trace from the current page, dropping the address of another trace', () => {
    const url = traceLink('http://ui/layer/general/service?service=db&traceId=old&traceAt=1&traceSpanId=s', 'new', 'traceql-native');
    expect(Object.fromEntries(url.searchParams)).toEqual({ service: 'db', traceId: 'new', traceType: 'traceql-native' });
    expect(url.pathname).toBe('/layer/general/service');
  });

  it('keeps the span and window the page carries for the same trace', () => {
    const url = traceLink('http://ui/x?traceId=t&traceType=traceql-otlp&traceSpanId=s&traceAt=1&traceSegmentId=g&traceSpanIndex=0', 't', 'traceql-otlp');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      traceId: 't', traceType: 'traceql-otlp', traceSpanId: 's', traceAt: '1', traceSegmentId: 'g', traceSpanIndex: '0',
    });
  });
});
