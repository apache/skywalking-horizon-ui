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
 * The TraceQL detail's own reading of OTLP spans: the order they are drawn in,
 * and the words put on a span kind.
 *
 * The tree cases are the ones a real trace produces and a naive walk loses —
 * a span whose parent is not in the set, a self-parent, a cycle. Every span
 * must appear exactly once, because the header counts them all and a view that
 * quietly drops some is worse than one that draws them oddly.
 */

import { describe, expect, it } from 'vitest';
import type { TraceQLSpan } from '@skywalking-horizon-ui/api-client';
import { buildSpanTree, kindLabel, otlpKindName, rootSpanOf, spanStatus, statusColor } from './traceqlDetailShared';

function span(spanId: string, parentSpanId: string, startUs = 0, durationUs = 10): TraceQLSpan {
  return {
    spanId,
    parentSpanId,
    name: spanId,
    kind: 'SPAN_KIND_INTERNAL',
    service: 'svc',
    startUs,
    durationUs,
    status: 'unset',
    attributes: [],
    resourceAttributes: [],
    events: [],
  };
}

const ids = (rows: ReturnType<typeof buildSpanTree>) => rows.map((r) => r.span.spanId);

describe('span tree', () => {
  it('walks parents before children, siblings by start time', () => {
    const rows = buildSpanTree([span('b', 'a', 20), span('a', '', 0), span('c', 'a', 10)]);
    expect(ids(rows)).toEqual(['a', 'c', 'b']);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1]);
    // Offsets are measured from the trace's earliest span.
    expect(rows.map((r) => r.offsetUs)).toEqual([0, 10, 20]);
  });

  it('treats a span whose parent is absent as a root', () => {
    // A partial trace: the parent was sampled away or is in another store.
    const rows = buildSpanTree([span('child', 'missing-parent', 5)]);
    expect(ids(rows)).toEqual(['child']);
    expect(rows[0]!.depth).toBe(0);
  });

  it('keeps every span when the parentage is a cycle', () => {
    // A → B → A has no root at all; walking only from roots loses both.
    const rows = buildSpanTree([span('a', 'b', 0), span('b', 'a', 5)]);
    expect(ids(rows).sort()).toEqual(['a', 'b']);
    expect(rows).toHaveLength(2);
  });

  it('keeps a span that is its own parent', () => {
    const rows = buildSpanTree([span('root', '', 0), span('self', 'self', 5)]);
    expect(ids(rows).sort()).toEqual(['root', 'self']);
  });

  it('keeps both records of a shared Zipkin span id', () => {
    // A Zipkin client and server span carry ONE span id, and OAP's converter
    // keeps both records. Keying identity on the id loses the second.
    const rows = buildSpanTree([
      span('root', '', 0),
      span('shared', 'root', 5),
      { ...span('shared', 'root', 6), name: 'server side' },
      span('leaf', 'shared', 8),
    ]);
    expect(rows).toHaveLength(4);
    expect(ids(rows)).toEqual(['root', 'shared', 'leaf', 'shared']);
    // The subtree is drawn once, under the first record with that id.
    expect(rows.filter((r) => r.span.spanId === 'leaf')).toHaveLength(1);
  });

  it('draws nothing for no spans', () => {
    expect(buildSpanTree([])).toEqual([]);
  });

  it('finds the trace root, or the earliest span when there is none', () => {
    expect(rootSpanOf([span('b', 'a', 5), span('a', '', 0)])?.spanId).toBe('a');
    expect(rootSpanOf([span('a', 'b', 0), span('b', 'a', 5)])?.spanId).toBe('a');
    expect(rootSpanOf([])).toBeNull();
  });
});

describe('span kind', () => {
  it('reads OTLP kinds in SkyWalking’s vocabulary', () => {
    // A server call and a consumed message both ENTER this service; a client
    // call and a produced message both leave it.
    expect(kindLabel('SPAN_KIND_SERVER')).toBe('Entry');
    expect(kindLabel('SPAN_KIND_CONSUMER')).toBe('Entry');
    expect(kindLabel('SPAN_KIND_CLIENT')).toBe('Exit');
    expect(kindLabel('SPAN_KIND_PRODUCER')).toBe('Exit');
    expect(kindLabel('SPAN_KIND_INTERNAL')).toBe('Local');
    expect(kindLabel('SPAN_KIND_UNSPECIFIED')).toBe('Unspecified');
    expect(kindLabel('')).toBe('Unspecified');
  });

  it('keeps the protocol’s own word available beside it', () => {
    expect(otlpKindName('SPAN_KIND_CONSUMER')).toBe('consumer');
    expect(otlpKindName('')).toBe('unspecified');
  });
});

describe('span status colour', () => {
  it('paints unset apart from ok, because it is not a success', () => {
    expect(statusColor('error')).toBe('var(--sw-err)');
    expect(statusColor('ok')).toBe('var(--sw-ok)');
    expect(statusColor('unset')).toBe('var(--sw-fg-3)');
  });
});

describe('the status a span is shown as', () => {
  const withAttrs = (status: TraceQLSpan['status'], a: Record<string, string>): TraceQLSpan =>
    ({ ...span('s', ''), status, attributes: Object.entries(a).map(([key, value]) => ({ key, value })) });

  it('reads a marker when OTLP left the field unset', () => {
    // OAP's Zipkin converter sets no status, so the whole store read `unset`
    // while every span said plainly what it did.
    expect(spanStatus(withAttrs('unset', { 'http.status_code': '500' }))).toBe('error');
    expect(spanStatus(withAttrs('unset', { 'http.status_code': '200' }))).toBe('ok');
  });

  it('keeps unset when nothing reports either way', () => {
    expect(spanStatus(span('s', ''))).toBe('unset');
    expect(spanStatus(withAttrs('unset', { 'http.method': 'GET' }))).toBe('unset');
  });

  it('does not let a marker overturn the span\'s own status', () => {
    expect(spanStatus(withAttrs('error', { 'http.status_code': '200' }))).toBe('error');
  });
});
