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
 * The counting rules, which are the whole reason this is a mechanism rather
 * than a store detail: a process counts only its own share, writes a running
 * total rather than a delta, and never reads before writing. Both backends
 * inherit these properties.
 */

import { describe, it, expect } from 'vitest';
import { TokenCounters } from './token-counters.js';
import { hourBucketOf } from './counters.js';

const AT = Date.UTC(2026, 7, 23, 7, 30);
const HOUR = hourBucketOf(AT);
const use = (tokenId = 'ab12cd', at = AT) =>
  ({ tokenId, username: 'sre', at });

describe('counting', () => {
  it('is one row per token per hour, however many uses', () => {
    const c = new TokenCounters();
    for (let i = 0; i < 40; i += 1) c.count(use());
    expect(c.pending()).toEqual([
      { hourBucket: HOUR, tokenId: 'ab12cd', username: 'sre', count: 40 },
    ]);
  });

  it('separates credentials, and separates hours', () => {
    const c = new TokenCounters();
    const nextHour = AT + 3_600_000;
    c.count(use('aaa'));
    c.count(use('bbb'));
    c.count(use('aaa', nextHour));
    expect(c.pending()).toHaveLength(3);
  });
});

/**
 * The property the whole design exists for, and the one a single cluster-wide
 * row cannot deliver: each process writes only its own share.
 */
describe('a process only ever writes its own share', () => {
  it('counts from zero, because another node\'s count is not its to restate', () => {
    const c = new TokenCounters();
    for (let i = 0; i < 12; i += 1) c.count(use());
    expect(c.pending()[0]?.count).toBe(12);
  });

  it('writes on the first flush rather than waiting to be told the hour', () => {
    const c = new TokenCounters();
    c.count(use());
    expect(c.pending()).toEqual([
      { hourBucket: HOUR, tokenId: 'ab12cd', username: 'sre', count: 1 },
    ]);
  });
});

describe('marking written', () => {
  it('counts only what was submitted, so uses during the write stay pending', () => {
    const c = new TokenCounters();
    for (let i = 0; i < 5; i += 1) c.count(use());
    const submitted = c.pending();
    expect(submitted[0]?.count).toBe(5);
    // Four more arrive while the write is on the wire.
    for (let i = 0; i < 4; i += 1) c.count(use());
    c.markWritten(submitted);
    expect(c.pending()[0]?.count).toBe(9);
  });

  it('is idempotent — replaying the same write changes nothing', () => {
    const c = new TokenCounters();
    for (let i = 0; i < 5; i += 1) c.count(use());
    const submitted = c.pending();
    c.markWritten(submitted);
    c.markWritten(submitted);
    expect(c.pending()).toEqual([]);
  });
});

describe('repeat use of one credential', () => {
  it('adds to the credential it already knows rather than adding a row', () => {
    const c = new TokenCounters();
    for (let i = 0; i < 3; i += 1) c.count(use('t0'));
    expect(c.pending()).toHaveLength(1);
    expect(c.pending()[0].count).toBe(3);
  });
});

/**
 * What shutdown reports when it could not write. Counted in USES rather than
 * rows: a row carries a running total, so "2 rows unwritten" understates it.
 */
describe('counting what has not reached the store', () => {
  it('is zero once a write is acknowledged', () => {
    const c = new TokenCounters();
    for (let i = 0; i < 6; i += 1) c.count(use());
    expect(c.unwritten()).toBe(6);

    c.markWritten(c.pending());

    expect(c.unwritten()).toBe(0);
  });

  it('counts uses, not credentials, and not what was already written', () => {
    const c = new TokenCounters();
    for (let i = 0; i < 4; i += 1) c.count(use('a'));
    c.markWritten(c.pending());
    // Five more on one credential, three on another: eight uses at risk.
    for (let i = 0; i < 5; i += 1) c.count(use('a'));
    for (let i = 0; i < 3; i += 1) c.count(use('b'));

    expect(c.unwritten()).toBe(8);
  });
});
