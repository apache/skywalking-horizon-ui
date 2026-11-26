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
import type { MatchedPeer, PairingsResponse } from '@skywalking-horizon-ui/api-client';
import { compactCount, countsText, filterBy, localTime, roundOfCaptures, unmatchedByCause } from './otlpPairing';

const peer = (over: Partial<MatchedPeer>): MatchedPeer => ({
  peer: 'backend:8080',
  server: 'backend',
  callers: ['frontend'],
  address: 'frontend->backend:8080',
  count: 3,
  outcomes: { registered: 3 },
  firstTime: 1,
  lastTime: 2,
  ...over,
});

describe('otlpPairing', () => {
  it('reads counts the most frequent first, each compact', () => {
    expect(countsText({ expired: 2, replaced: 12_345, evicted: 0 })).toBe('replaced 12k · expired 2');
  });

  it('reads a count at a glance, never rounding up past what it is', () => {
    expect([0, 987, 1000, 1049, 1250, 12_345, 456_789, 999_999, 7_850_000, 12_000_000, 3_400_000_000].map(compactCount))
      .toEqual(['0', '987', '1k', '1k', '1.2k', '12k', '456k', '999k', '7.8m', '12m', '3.4b']);
  });

  it('sums the unmatched halves of both roles by cause', () => {
    const found = {
      unmatched: { caller: { expired: 2, replaced: 1 }, callee: { expired: 1 } },
    } as unknown as PairingsResponse;
    expect(unmatchedByCause(found)).toEqual({ expired: 3, replaced: 1 });
  });

  it('filters entries by any of their fields, ignoring case', () => {
    const list = [peer({}), peer({ peer: 'cart:7070', server: 'cart', callers: ['checkout'] })];
    const fields = (p: MatchedPeer): string[] => [p.peer, p.server, ...p.callers];
    expect(filterBy(list, 'CHECKOUT', fields).map((p) => p.peer)).toEqual(['cart:7070']);
    expect(filterBy(list, '  ', fields)).toHaveLength(2);
  });

  it('reads an epoch as local time, and nothing for none', () => {
    const ms = new Date(2026, 10, 24, 20, 42, 38, 33).getTime();
    expect(localTime(ms)).toBe('2026-11-24 20:42:38.033');
    expect(localTime(0)).toBe('');
  });

  it('reads exact counts for a hover', () => {
    expect(countsText({ expired: 12_345 }, true)).toBe('expired 12345');
  });

  it('picks the round as OAP picks it: most nodes, then the earliest start', () => {
    const c = (roundId: string, startTime: number) => ({ state: 'capturing' as const, roundId, startTime, lastReadTime: 0, idleMillis: 60_000 });
    expect(roundOfCaptures([c('r2', 2_000), c('r1', 1_000), c('r1', 1_000)])?.roundId).toBe('r1');
    expect(roundOfCaptures([c('r2', 2_000), c('r1', 1_000)])?.roundId, 'as many: the earliest started').toBe('r1');
    expect(roundOfCaptures([undefined, { ...c('', 0), state: 'off' }])).toBeNull();
  });
});
