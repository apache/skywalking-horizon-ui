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
 * Where a RETAINED comparison series is drawn.
 *
 * A member whose round failed keeps its previous answer — that is deliberate,
 * so one soft failure does not blank its siblings. What must not happen is the
 * older answer being spread across the newer axis, which draws a stale line to
 * the right-hand edge and invites a comparison between two different windows.
 */

import { describe, expect, it } from 'vitest';
import { alignToAxis } from './useCompareEngine';

const MIN = 60_000;
/** A MINUTE window of `len` buckets starting at bucket `t` (t = minutes). */
const win = (t: number, len: number) => ({
  step: 'MINUTE' as const,
  startMs: t * MIN,
  endMs: (t + len - 1) * MIN,
});

describe('placing a retained series on the current axis', () => {
  it('holds its own buckets and leaves the un-refreshed one empty', () => {
    // The reported case: everyone had T1–T10, the next round asks T2–T11, and
    // B fails. B keeps T1–T10, so on a T2–T11 axis it covers T2–T10 and T11 is
    // absent — rather than being stretched to the right-hand edge as though it
    // had refreshed.
    const axis = win(2, 10); // T2..T11
    const bData = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; // T1..T10
    expect(alignToAxis(bData, win(1, 10), axis, 10)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, null,
    ]);
  });

  it('leaves a member that DID refresh untouched', () => {
    const axis = win(2, 10);
    const fresh = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(alignToAxis(fresh, axis, axis, 10)).toBe(fresh);
  });

  it('makes no assumption about which side it hangs off', () => {
    // A custom range can put the retained window anywhere. Ahead of the axis:
    const axis = win(10, 5); // T10..T14
    expect(alignToAxis([1, 2, 3, 4, 5], win(12, 5), axis, 5)).toEqual([
      null, null, 1, 2, 3,
    ]);
    // And with no overlap at all, nothing is drawn rather than something wrong.
    expect(alignToAxis([1, 2, 3], win(100, 3), axis, 5)).toEqual([
      null, null, null, null, null,
    ]);
  });

  it('draws nothing when the STEP differs, because the buckets are not comparable', () => {
    // An HOUR bucket and a MINUTE bucket cover different spans, so no offset
    // makes them line up. Drawing it anyway would be the lie this prevents.
    const axis = win(2, 4);
    const hourly = { step: 'HOUR' as const, startMs: 2 * MIN, endMs: 5 * MIN };
    expect(alignToAxis([1, 2, 3, 4], hourly, axis, 4)).toEqual([null, null, null, null]);
  });

  it('passes the data through before any window is known', () => {
    const data = [1, 2, 3];
    expect(alignToAxis(data, null, null, 3)).toBe(data);
  });
});
