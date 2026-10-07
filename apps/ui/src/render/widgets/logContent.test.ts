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
import type { LogRow } from '@/api/client';
import { detectFormat, prettyContent, previewContent } from './logContent';

function row(content: string, contentType = 'TEXT'): LogRow {
  return {
    serviceName: 'svc', serviceId: 's', serviceInstanceName: null, serviceInstanceId: null,
    endpointName: null, endpointId: null, traceId: null, timestamp: 0, contentType, content, tags: [],
  };
}

describe('logContent', () => {
  it('keeps JSON compact in a row and indented in full', () => {
    const r = row('{ "a": { "b": 1 } }', 'JSON');
    expect(detectFormat(r)).toBe('json');
    expect(previewContent(r)).toBe('{"a":{"b":1}}');
    expect(prettyContent(r)).toBe('{\n  "a": {\n    "b": 1\n  }\n}');
  });

  it('flattens a text log to one line for the row, and keeps it whole in full', () => {
    const r = row('boom\n\tat A.b(A.java:1)\n');
    expect(previewContent(r)).toBe('boom at A.b(A.java:1)');
    expect(prettyContent(r)).toBe('boom\n\tat A.b(A.java:1)\n');
  });

  it('treats an unparsable JSON-looking log as text', () => {
    const r = row('{not json}');
    expect(detectFormat(r)).toBe('text');
    expect(prettyContent(r)).toBe('{not json}');
  });
});
