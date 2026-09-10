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
import { relativeAgo } from './formatters';

const t = (key: string, named?: Record<string, unknown>): string =>
  key.replace(/\{(\w+)\}/g, (_, k: string) => String(named?.[k] ?? ''));
const NOW = 1_800_000_000_000;
const H = 3_600_000;

describe('relativeAgo', () => {
  it('reads days and hours past a day, never a pile of hours', () => {
    expect(relativeAgo(NOW - 288 * H, t, NOW)).toBe('12d 0h ago');
    expect(relativeAgo(NOW - 27 * H - 5 * 60_000, t, NOW)).toBe('1d 3h ago');
  });

  it('reads hours and minutes under a day, minutes under an hour, seconds under a minute', () => {
    expect(relativeAgo(NOW - 5 * H - 20 * 60_000, t, NOW)).toBe('5h 20m ago');
    expect(relativeAgo(NOW - 59 * 60_000, t, NOW)).toBe('59m ago');
    expect(relativeAgo(NOW - 42_000, t, NOW)).toBe('42s ago');
    expect(relativeAgo(NOW - 400, t, NOW)).toBe('just now');
  });

  it('draws a dash for no moment', () => {
    expect(relativeAgo(null, t, NOW)).toBe('—');
    expect(relativeAgo(0, t, NOW)).toBe('—');
  });
});
