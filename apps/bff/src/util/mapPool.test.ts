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
import { mapPool } from './mapPool.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('mapPool', () => {
  it('preserves input order regardless of completion order', async () => {
    const out = await mapPool([1, 2, 3, 4, 5], 2, async (n) => {
      // Smaller numbers resolve later, so completion order != input order.
      await new Promise((r) => setTimeout(r, (6 - n) * 2));
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it('never exceeds the concurrency cap in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapPool(Array.from({ length: 12 }, (_, i) => i), 3, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
      return i;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // actually ran concurrently
  });

  it('processes every item exactly once', async () => {
    const seen: number[] = [];
    const out = await mapPool([5, 6, 7], 5, async (n) => {
      seen.push(n);
      return n;
    });
    expect(out).toEqual([5, 6, 7]);
    expect(seen.sort()).toEqual([5, 6, 7]);
  });

  it('returns [] for empty input without invoking fn', async () => {
    let called = false;
    const out = await mapPool([], 4, async (x) => {
      called = true;
      return x;
    });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it('caps the worker count at the item count (concurrency > length)', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapPool([1, 2], 10, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('treats a zero / negative concurrency as serial (>= 1 worker)', async () => {
    const out = await mapPool([1, 2, 3], 0, async (n) => n + 1);
    expect(out).toEqual([2, 3, 4]);
  });
});
