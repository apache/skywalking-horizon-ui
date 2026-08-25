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
import { toEntry, toId, toInet, toNumber, valuesClause, type RawAuditRow } from './rows.js';
import { CHUNK_ROWS, EVENT_COLUMNS } from './store.js';

describe('bigint handling', () => {
  /**
   * node-postgres returns int8 as a STRING, and both failure modes are quiet:
   * a string comparison of two bucket labels happens to work, and SUM totals
   * concatenate instead of adding.
   */
  it('converts a string bigint to a number', () => {
    expect(toNumber('2026082214', 'hour_bucket')).toBe(2026082214);
    expect(toNumber('412', 'count')).toBe(412);
  });

  it('throws rather than yielding NaN, so a bad value cannot be silently rendered', () => {
    expect(() => toNumber('not-a-number', 'count')).toThrow(/count/);
  });

  /** Narrowing an id to a JS number for a tidier type is a precision bug. */
  it('keeps id a string', () => {
    expect(toId('9007199254740993')).toBe('9007199254740993');
  });
});

describe('inet handling', () => {
  /** A malformed address raises a type error mid-statement, which would cost
   *  the whole batch. A bad address must not cost the row it came on. */
  it('nulls an unparseable address instead of failing the write', () => {
    expect(toInet('not-an-ip')).toBeNull();
    expect(toInet('')).toBeNull();
    expect(toInet(undefined)).toBeNull();
  });

  it('passes real v4 and v6 addresses through', () => {
    expect(toInet('203.0.113.7')).toBe('203.0.113.7');
    expect(toInet('2001:db8::1')).toBe('2001:db8::1');
  });
});

describe('multi-row VALUES', () => {
  it('numbers placeholders across rows', () => {
    expect(valuesClause(1, 3)).toBe('($1,$2,$3)');
    expect(valuesClause(3, 2)).toBe('($1,$2),($3,$4),($5,$6)');
  });

  /** The protocol caps a statement at 65535 bind parameters. The chunk size
   *  times the column count must stay well under it, or a flush fails only on
   *  the busiest deployment.
   *
   *  Measured from the real constants, not a literal: a hardcoded column count
   *  cannot notice a column being added, which is the only way this budget
   *  ever moves. */
  it('stays inside the bind-parameter cap at the chunk size the store uses', () => {
    const widest = EVENT_COLUMNS.length;
    expect(CHUNK_ROWS * widest).toBeLessThan(65535);
  });
});

describe('row mapping', () => {
  const base: RawAuditRow = {
    id: '42', at: new Date('2026-08-22T14:30:00Z'), kind: 'local',
    provider: null, protocol: null, roles: null,
    outcome: 1, reason: null, username: 'alice', mail: null,
    client_ip: null, horizon_ip: null, horizon_node: 'pod-1:abc',
  };

  it('maps an event row without inventing optional fields', () => {
    const e = toEntry(base);
    expect(e).toEqual({
      id: '42', at: Date.UTC(2026, 7, 22, 14, 30), kind: 'local', outcome: 1,
      username: 'alice', horizonNode: 'pod-1:abc',
    });
    expect('reason' in e).toBe(false);
  });


  it('carries a refusal with its reason', () => {
    const e = toEntry({ ...base, outcome: 0, reason: 'no_roles' });
    expect(e.outcome).toBe(0);
    expect(e.reason).toBe('no_roles');
  });
});
