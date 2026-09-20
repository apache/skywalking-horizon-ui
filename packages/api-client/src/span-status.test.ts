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
 * Reading an outcome off a span. Each rule decides whether a span is painted as
 * a FAILURE, so the cases that matter are the ones where a tag is present and
 * says nothing is wrong — a 200, an rpc code of 0, an `error="false"` — which
 * must not turn into a red row, and the ones that say nothing AT ALL, which
 * must not turn into a green one.
 */

import { describe, expect, it } from 'vitest';
import { attributesReportError, attributesReportOutcome, spanOutcome, traceOutcome } from './span-status.js';

const attrs = (o: Record<string, string>) => Object.entries(o).map(([key, value]) => ({ key, value }));

describe('span error markers', () => {
  it('reads an http status code as an outcome, not as presence', () => {
    expect(attributesReportError(attrs({ 'http.status_code': '500' }))).toBe(true);
    expect(attributesReportError(attrs({ 'http.status_code': '404' }))).toBe(true);
    expect(attributesReportError(attrs({ 'http.status_code': '200' }))).toBe(false);
    expect(attributesReportError(attrs({ 'http.status_code': '302' }))).toBe(false);
    // The OTel-conventions spelling means the same thing.
    expect(attributesReportError(attrs({ 'http.response.status_code': '503' }))).toBe(true);
  });

  it('treats rpc codes as gRPC does — 0 and OK are success', () => {
    expect(attributesReportError(attrs({ 'rpc.status_code': '0' }))).toBe(false);
    expect(attributesReportError(attrs({ 'rpc.status_code': 'OK' }))).toBe(false);
    expect(attributesReportError(attrs({ 'rpc.status_code': '14' }))).toBe(true);
    expect(attributesReportError(attrs({ 'rpc.status_code': 'UNAVAILABLE' }))).toBe(true);
    expect(attributesReportError(attrs({ 'grpc.status_code': '2' }))).toBe(true);
  });

  it('honours a marker that says it is NOT a failure', () => {
    // Zipkin writes the message in `error`, but an instrumentation may write a
    // boolean — and `error="false"` is a span reporting success.
    expect(attributesReportError(attrs({ error: 'false' }))).toBe(false);
    expect(attributesReportError(attrs({ error: '0' }))).toBe(false);
    expect(attributesReportError(attrs({ error: 'connection reset' }))).toBe(true);
    expect(attributesReportError(attrs({ error: 'true' }))).toBe(true);
  });

  it('reads an EMPTY error tag the way the source spells absence', () => {
    // In Zipkin the tag's presence is the signal and the value is only the
    // message: DependencyLinker asks `tags().containsKey("error")`, and the
    // protobuf writer keeps `error -> ""` on the wire on purpose.
    expect(attributesReportError(attrs({ error: '' }))).toBe(true);
    // A TraceQL SEARCH response pads every projected key onto every span of a
    // span set, absent ones as "" — there the same value means the span never
    // carried the tag, and reading it as a failure reddens the whole trace.
    expect(attributesReportError(attrs({ error: '' }), { emptyIsAbsent: true })).toBe(false);
  });

  it('reads the OpenTelemetry status attributes', () => {
    expect(attributesReportError(attrs({ 'otel.status_code': 'ERROR' }))).toBe(true);
    expect(attributesReportError(attrs({ 'status.code': 'STATUS_CODE_ERROR' }))).toBe(true);
    expect(attributesReportError(attrs({ 'otel.status_code': 'OK' }))).toBe(false);
    // UNSET is the absence of a verdict, not a failure.
    expect(attributesReportError(attrs({ 'otel.status_code': 'UNSET' }))).toBe(false);
  });

  it('takes an exception marker as a failure by its presence', () => {
    expect(attributesReportError(attrs({ 'exception.type': 'java.io.IOException' }))).toBe(true);
    expect(attributesReportError(attrs({ 'error.kind': 'timeout' }))).toBe(true);
    // Presence is the whole signal, so an empty one counts where the source
    // only writes what the span carried — and not where they are padded on.
    expect(attributesReportError(attrs({ 'exception.type': '' }))).toBe(true);
    expect(attributesReportError(attrs({ 'exception.type': '' }), { emptyIsAbsent: true })).toBe(false);
  });

  it('ignores tags that are not markers at all', () => {
    expect(attributesReportError(attrs({ 'http.method': 'GET', 'db.type': 'sql', 'span.kind': 'SPAN_KIND_SERVER' }))).toBe(false);
    expect(attributesReportError([])).toBe(false);
    // A tag whose NAME merely ends in a marker's is not that marker.
    expect(attributesReportError(attrs({ 'app.error.kind': 'x', 'business_status': 'error' }))).toBe(false);
  });
});

describe('reading an outcome, not just a failure', () => {
  it('lets a marker report success', () => {
    expect(attributesReportOutcome(attrs({ 'http.status_code': '200' }))).toBe('ok');
    expect(attributesReportOutcome(attrs({ 'rpc.status_code': 'OK' }))).toBe('ok');
    expect(attributesReportOutcome(attrs({ error: 'false' }))).toBe('ok');
    expect(attributesReportOutcome(attrs({ 'otel.status_code': 'OK' }))).toBe('ok');
  });

  it('says nothing when nothing said anything', () => {
    expect(attributesReportOutcome([])).toBeNull();
    expect(attributesReportOutcome(attrs({ 'http.method': 'GET' }))).toBeNull();
    // A status code is a number, and an empty string is not one — `Number('')`
    // is 0, which would otherwise have read as a perfectly good success.
    expect(attributesReportOutcome(attrs({ 'http.status_code': '' }))).toBeNull();
    expect(attributesReportOutcome(attrs({ 'rpc.status_code': '' }))).toBeNull();
    // OTel UNSET is the absence of a verdict — not a failure, and not a success.
    expect(attributesReportOutcome(attrs({ 'otel.status_code': 'UNSET' }))).toBeNull();
    expect(attributesReportOutcome(attrs({ 'status.code': '0' }))).toBeNull();
    // A status code that is not a number is not a status code.
    expect(attributesReportOutcome(attrs({ 'http.status_code': 'unknown' }))).toBeNull();
  });

  it('takes failure over success within one span', () => {
    expect(attributesReportOutcome(attrs({ 'http.status_code': '200', 'exception.type': 'java.io.IOException' })))
      .toBe('error');
  });

  it('keeps the two functions in step', () => {
    for (const a of [attrs({ 'http.status_code': '500' }), attrs({ 'http.status_code': '200' }), []]) {
      expect(attributesReportError(a)).toBe(attributesReportOutcome(a) === 'error');
    }
  });
});

const span = (status: 'ok' | 'error' | 'unset', a: Record<string, string> = {}) =>
  ({ status, attributes: attrs(a) });

describe('span and trace outcome', () => {
  it('prefers the span\'s own status over any marker', () => {
    // An instrumentation that sets the status has already answered; a 200 on a
    // span OAP called failed does not overturn it.
    expect(spanOutcome(span('error', { 'http.status_code': '200' }))).toBe('error');
    expect(spanOutcome(span('ok', { 'http.status_code': '500' }))).toBe('ok');
  });

  it('falls through to the markers when the status is unset', () => {
    // The Zipkin converter leaves every span `unset`, so this is the ONLY
    // evidence a converted trace carries.
    expect(spanOutcome(span('unset', { 'http.status_code': '500' }))).toBe('error');
    expect(spanOutcome(span('unset', { 'http.status_code': '200' }))).toBe('ok');
    expect(spanOutcome(span('unset'))).toBeNull();
  });

  it('fails a trace on one span and passes it on agreement', () => {
    expect(traceOutcome([span('unset', { 'http.status_code': '200' }), span('unset', { error: 'reset' })]))
      .toBe('error');
    expect(traceOutcome([span('unset', { 'http.status_code': '200' }), span('ok')])).toBe('ok');
    // One span reporting success does not vouch for a sibling that reported
    // nothing — but it does settle the trace, which is the asymmetry: only a
    // trace where NOTHING spoke stays unknown.
    expect(traceOutcome([span('unset'), span('unset')])).toBeNull();
    expect(traceOutcome([])).toBeNull();
  });
});
