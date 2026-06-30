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

import { describe, it, expect } from 'vitest';
import type { LalSamplePayload } from '@skywalking-horizon-ui/api-client';
import {
  inputEntries,
  outputEntries,
  objectEntries,
  logBuilderOutput,
  logDataInput,
} from './lalPayload.js';

describe('objectEntries (generic, format-agnostic dump)', () => {
  it('returns [] for nullish', () => {
    expect(objectEntries(null)).toEqual([]);
    expect(objectEntries(undefined)).toEqual([]);
  });

  it('dumps scalar keys, skipping the structural keys rendered separately', () => {
    expect(
      objectEntries({
        type: 'LogData',
        service: 'svc',
        endpoint: '/api',
        tags: [{ key: 'k', value: 'v' }],
        body: { text: 'hi' },
        content: 'c',
      }),
    ).toEqual([
      { k: 'service', v: 'svc' },
      { k: 'endpoint', v: '/api' },
    ]);
  });

  it('skips nullish + empty-string values but keeps 0', () => {
    expect(objectEntries({ a: null, b: undefined, c: '', d: 'x', spanId: 0 })).toEqual([
      { k: 'd', v: 'x' },
      { k: 'spanId', v: '0' },
    ]);
  });

  it('stringifies nested objects compact in the dense cell', () => {
    expect(objectEntries({ obj: { a: 1 } })).toEqual([{ k: 'obj', v: '{"a":1}' }]);
  });

  it('pretty-prints nested objects when full (the popout) to enrich reading', () => {
    expect(objectEntries({ obj: { a: 1 } }, true)).toEqual([{ k: 'obj', v: '{\n  "a": 1\n}' }]);
  });
});

describe('inputEntries — renders whatever shape the log format carries', () => {
  it('LogData → its OAP keys verbatim', () => {
    const p = {
      input: { type: 'LogData', service: 'svc', endpoint: '/api', serviceInstance: 'inst', layer: 'GENERAL' },
    } as unknown as LalSamplePayload;
    expect(inputEntries(p)).toEqual([
      { k: 'service', v: 'svc' },
      { k: 'endpoint', v: '/api' },
      { k: 'serviceInstance', v: 'inst' },
      { k: 'layer', v: 'GENERAL' },
    ]);
  });

  it('Envoy proto that OAP could not serialize → the error, not a blank cell', () => {
    const p = {
      input: {
        type: 'envoy.data.accesslog.v3.HTTPAccessLogEntry',
        error: 'jsonformat-failed',
        detail: 'Cannot find type for url: type.googleapis.com/google.protobuf.BytesValue',
      },
    } as unknown as LalSamplePayload;
    expect(inputEntries(p)).toEqual([
      { k: 'error', v: 'jsonformat-failed' },
      { k: 'detail', v: 'Cannot find type for url: type.googleapis.com/google.protobuf.BytesValue' },
    ]);
  });
});

describe('outputEntries + logBuilderOutput — tolerant of the builder class', () => {
  const envoyOut = {
    output: {
      type: 'EnvoyAccessLogBuilder',
      service: 'mesh-svc',
      endpoint: 'GET:/x',
      responseCode: 404,
      responseFlags: 'NR',
      timestamp: 1700000000000,
      content: 'access log line',
    },
  } as unknown as LalSamplePayload;

  it('renders an EnvoyAccessLogBuilder output (was dropped as non-LogBuilder)', () => {
    expect(outputEntries(envoyOut)).toEqual([
      { k: 'service', v: 'mesh-svc' },
      { k: 'endpoint', v: 'GET:/x' },
      { k: 'responseCode', v: '404' },
      { k: 'responseFlags', v: 'NR' },
      { k: 'timestamp', v: '1700000000000' },
    ]);
  });

  it('logBuilderOutput accepts any *Builder, rejects non-builders + missing output', () => {
    expect(logBuilderOutput({ output: { type: 'LogBuilder' } } as unknown as LalSamplePayload)).not.toBeNull();
    expect(
      logBuilderOutput({ output: { type: 'EnvoyAccessLogBuilder' } } as unknown as LalSamplePayload),
    ).not.toBeNull();
    expect(logBuilderOutput({ output: { type: 'SomethingElse' } } as unknown as LalSamplePayload)).toBeNull();
    expect(logBuilderOutput({ input: { type: 'LogData' } } as unknown as LalSamplePayload)).toBeNull();
    expect(logBuilderOutput(null)).toBeNull();
  });
});

describe('logDataInput — narrows to LogData only', () => {
  it('LogData passes, other input classes do not', () => {
    expect(
      logDataInput({ input: { type: 'LogData', service: 's' } } as unknown as LalSamplePayload),
    ).not.toBeNull();
    expect(
      logDataInput({ input: { type: 'HTTPAccessLogEntry' } } as unknown as LalSamplePayload),
    ).toBeNull();
    expect(logDataInput(null)).toBeNull();
  });
});
