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
 * The page and the BFF spell a Zipkin trace id the way OAP will look it up, so
 * a chip shows exactly the id that is asked for and a duplicate typed two ways
 * is caught before OAP refuses the whole request over it.
 */

import { describe, expect, it } from 'vitest';
import { normalizeZipkinTraceId } from './zipkin-trace-id.js';

describe('normalizeZipkinTraceId — Zipkin’s Span.normalizeTraceId', () => {
  it('lower-cases, since OAP refuses upper-case hex', () => {
    expect(normalizeZipkinTraceId('463AC35C9F6413AD')).toBe('463ac35c9f6413ad');
  });

  it('left-pads a short id to 16 digits and a longer one to 32', () => {
    expect(normalizeZipkinTraceId('abc')).toBe('0000000000000abc');
    expect(normalizeZipkinTraceId('1463ac35c9f6413ad')).toBe('0000000000000001463ac35c9f6413ad');
  });

  it('shortens an id whose high half is zero once padded, so normalizing again changes nothing', () => {
    expect(normalizeZipkinTraceId('0000000000000000463ac35c9f6413ad')).toBe('463ac35c9f6413ad');
    expect(normalizeZipkinTraceId('0463ac35c9f6413ad')).toBe('463ac35c9f6413ad');
    for (const id of ['abc', '0463ac35c9f6413ad', '1463ac35c9f6413ad', '5af7183fb1d4cf5f463ac35c9f6413ad']) {
      const once = normalizeZipkinTraceId(id)!;
      expect(normalizeZipkinTraceId(once)).toBe(once);
    }
  });

  it('keeps a full 16- or 32-digit id as it is, trimmed', () => {
    expect(normalizeZipkinTraceId('  463ac35c9f6413ad ')).toBe('463ac35c9f6413ad');
    expect(normalizeZipkinTraceId('5af7183fb1d4cf5f463ac35c9f6413ad')).toBe('5af7183fb1d4cf5f463ac35c9f6413ad');
  });

  it('refuses anything that is not a trace id', () => {
    expect(normalizeZipkinTraceId('xyz')).toBeNull();
    expect(normalizeZipkinTraceId('0000')).toBeNull();
    expect(normalizeZipkinTraceId('a'.repeat(33))).toBeNull();
    expect(normalizeZipkinTraceId('abc.1.2')).toBeNull();
    expect(normalizeZipkinTraceId('')).toBeNull();
  });
});
