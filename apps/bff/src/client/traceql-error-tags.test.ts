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
 * The error markers a trace list reads off a search result. Each rule decides
 * whether a row is painted as a FAILURE, so the cases that matter are the ones
 * where a tag is present and says nothing is wrong — a 200, an rpc code of 0,
 * an `error="false"` — which must not turn into a red row.
 */

import { describe, expect, it } from 'vitest';
import { attributesReportError } from './traceql-error-tags.js';

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
    // OAP pads a span that lacks a projected attribute with an empty value.
    expect(attributesReportError(attrs({ error: '' }))).toBe(false);
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
    // An empty one says nothing.
    expect(attributesReportError(attrs({ 'exception.type': '' }))).toBe(false);
  });

  it('ignores tags that are not markers at all', () => {
    expect(attributesReportError(attrs({ 'http.method': 'GET', 'db.type': 'sql', 'span.kind': 'SPAN_KIND_SERVER' }))).toBe(false);
    expect(attributesReportError([])).toBe(false);
    // A tag whose NAME merely ends in a marker's is not that marker.
    expect(attributesReportError(attrs({ 'app.error.kind': 'x', 'business_status': 'error' }))).toBe(false);
  });
});
