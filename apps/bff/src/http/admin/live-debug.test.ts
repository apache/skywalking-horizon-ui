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
import { readOptionsOf } from './live-debug.js';

describe('readOptionsOf — the paged session read', () => {
  it('reads from the first record when no point is given', () => {
    expect(readOptionsOf({})).toEqual({});
    expect(readOptionsOf({ capturedSince: '' })).toEqual({});
    expect(readOptionsOf(undefined)).toEqual({});
  });

  it('passes a point and a page size through', () => {
    expect(readOptionsOf({ capturedSince: '1795505219786.871986', pageSize: '50' })).toEqual({
      capturedSince: '1795505219786.871986',
      pageSize: 50,
    });
  });

  it('refuses a point that is not <millis>.<six-digit nanos>, so OAP is not asked', () => {
    for (const bad of ['1795505219786', '1795505219786.8719', '+1795505219786.000000', '1795505219786.+00001', 'x']) {
      expect(typeof readOptionsOf({ capturedSince: bad }), bad).toBe('string');
    }
  });

  it('refuses a page size outside 1 to 1000', () => {
    for (const bad of ['0', '1001', '2.5', 'many']) {
      expect(typeof readOptionsOf({ pageSize: bad }), bad).toBe('string');
    }
  });
});
