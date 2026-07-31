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
import { parseOapTimezoneMinutes } from './oap-info.js';

// Every OAP time string the UI sends is built by shifting the browser instant
// by this offset — a wrong sign or a swallowed half-hour silently queries the
// wrong window.
describe('parseOapTimezoneMinutes', () => {
  it('converts a positive offset to minutes east of UTC', () => {
    expect(parseOapTimezoneMinutes('+0800')).toBe(480);
    expect(parseOapTimezoneMinutes('+0530')).toBe(330);
    expect(parseOapTimezoneMinutes('+1345')).toBe(825);
  });

  it('converts a negative offset to a negative minute count, minutes included', () => {
    expect(parseOapTimezoneMinutes('-0500')).toBe(-300);
    expect(parseOapTimezoneMinutes('-0530')).toBe(-330);
    expect(parseOapTimezoneMinutes('-0930')).toBe(-570);
  });

  it('maps UTC to 0, not to undefined', () => {
    // 0 is a real offset; callers branch on `=== undefined`, so collapsing
    // UTC into "unknown" would blank every OAP-local time string.
    expect(parseOapTimezoneMinutes('+0000')).toBe(0);
    expect(parseOapTimezoneMinutes('-0000') === 0).toBe(true);
  });

  it('returns undefined for a missing or malformed offset rather than guessing', () => {
    expect(parseOapTimezoneMinutes(undefined)).toBeUndefined();
    expect(parseOapTimezoneMinutes('')).toBeUndefined();
    expect(parseOapTimezoneMinutes('+08:00')).toBeUndefined();
    expect(parseOapTimezoneMinutes('0800')).toBeUndefined();
    expect(parseOapTimezoneMinutes('+800')).toBeUndefined();
    expect(parseOapTimezoneMinutes('UTC')).toBeUndefined();
    // A `±HHmm` buried in a longer string is not an offset this can trust —
    // matching it anyway would hand the topbar a confidently wrong number.
    expect(parseOapTimezoneMinutes('GMT+0800')).toBeUndefined();
    expect(parseOapTimezoneMinutes('+08000')).toBeUndefined();
  });
});
