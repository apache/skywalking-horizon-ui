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

/**
 * What the Zipkin list counts as a failed span. Zipkin ships no status field,
 * so the row is always an inference off the tags — and it has to be the SAME
 * inference the waterfall below it and the TraceQL row over the same spans
 * make, or one screen contradicts the other.
 */

import { describe, expect, it } from 'vitest';
import type { ZipkinSpan } from '@skywalking-horizon-ui/api-client';
import { summariseZipkinTrace } from './zipkin.js';

const span = (tags: Record<string, string>, over: Partial<ZipkinSpan> = {}): ZipkinSpan => ({
  traceId: 't1',
  id: over.id ?? 's1',
  name: 'GET /homepage',
  timestamp: 1_700_000_000_000_000,
  duration: 1000,
  tags,
  ...over,
});

const errors = (...spans: ZipkinSpan[]) => summariseZipkinTrace(spans).errorCount;

describe('the Zipkin list row', () => {
  it('counts a failing status code, not only a 5xx', () => {
    // The old rule tested `http.status_code` with startsWith('5'), so a 404
    // was a success on the Zipkin row and a failure on the TraceQL one.
    expect(errors(span({ 'http.status_code': '404' }))).toBe(1);
    expect(errors(span({ 'http.status_code': '500' }))).toBe(1);
    expect(errors(span({ 'http.status_code': '200' }))).toBe(0);
  });

  it('reads the error tag as a value, except that an empty one is still Zipkin\'s signal', () => {
    expect(errors(span({ error: 'connection reset' }))).toBe(1);
    // This counted as a failure under the old `!= null` test, and should not:
    // a span writing `error="false"` is reporting success.
    expect(errors(span({ error: 'false' }))).toBe(0);
    // This one it got right. In Zipkin the tag's PRESENCE is the signal and
    // the value is only the message — a tag map holds nothing the span did
    // not write, so an empty value is a value.
    expect(errors(span({ error: '' }))).toBe(1);
  });

  it('reads the OpenTelemetry and RPC markers too', () => {
    expect(errors(span({ 'otel.status_code': 'ERROR' }))).toBe(1);
    expect(errors(span({ 'otel.status_code': 'UNSET' }))).toBe(0);
    expect(errors(span({ 'rpc.status_code': '14' }))).toBe(1);
    expect(errors(span({ 'rpc.status_code': '0' }))).toBe(0);
  });

  it('counts each failing span, and none when nothing reports one', () => {
    expect(errors(
      span({ 'http.status_code': '500' }, { id: 'a' }),
      span({ 'http.status_code': '200' }, { id: 'b' }),
      span({ 'http.status_code': '503' }, { id: 'c' }),
    )).toBe(2);
    expect(errors(span({ 'http.method': 'GET' }))).toBe(0);
    expect(errors(span({}))).toBe(0);
  });

  it('takes its headline fields from the root span', () => {
    const row = summariseZipkinTrace([
      span({}, { id: 'child', parentId: 'root', timestamp: 2_000 }),
      span({}, { id: 'root', name: '/checkout', timestamp: 1_000, duration: 90, localEndpoint: { serviceName: 'frontend' } }),
    ]);
    expect(row).toMatchObject({ rootName: '/checkout', rootService: 'frontend', duration: 90, spanCount: 2 });
  });
});
