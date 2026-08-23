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
 * What the audit routes accept, at the edge.
 *
 * The cursor cases exist because a validator can FAIL rather than reject: zod
 * runs every check in a chain, so a refine placed after a `.regex()` is still
 * handed the string the regex just rejected. `BigInt('def')` throws there, and
 * a throw out of `safeParse` is a 500 for what is plainly a bad request.
 */

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { registerAuditRoutes } from './audit.js';
import type { AuditRouteDeps } from './audit.js';

/** Enough of the service for the routes to answer; the reads are not exercised. */
const audit = {
  query: async () => ({ rows: [], hasNext: false }),
  queryStat: async () => ({ columns: [], overBudget: 0, horizonNodes: 0 }),
  queryTokenUsage: async () => ({ hours: [] }),
  health: async () => ({
    horizonNode: 'n1', enabled: true, configured: true, available: true,
    rowsThisHour: 0, overBudgetThisHour: 0,
  }),
} as unknown as AuditRouteDeps['audit'];

async function app() {
  const f = Fastify();
  await registerAuditRoutes(f, { audit } as AuditRouteDeps);
  return f;
}

async function get(url: string) {
  const f = await app();
  try {
    return await f.inject({ method: 'GET', url });
  } finally {
    await f.close();
  }
}

describe('the audit list cursor', () => {
  it.each([
    ['abc:def', 'a shape the regex rejects, whose id half is not a number'],
    ['not-a-cursor', 'no separator at all'],
    ['1:2:3', 'too many halves'],
    ['', 'empty'],
  ])('answers 400 rather than failing on %s (%s)', async (cursor) => {
    const res = await get(`/api/admin/audit?cursor=${encodeURIComponent(cursor)}`);

    // 400, never 500: the distinction is the whole point — a malformed
    // parameter is the caller's fault and must not read as a server fault.
    expect(res.statusCode).toBe(400);
  });

  it('refuses an id past what a signed bigint can hold', async () => {
    const res = await get('/api/admin/audit?cursor=1700000000000:9999999999999999999');

    expect(res.statusCode).toBe(400);
  });

  it('accepts an ordinary cursor', async () => {
    const res = await get('/api/admin/audit?cursor=1700000000000:42');

    expect(res.statusCode).toBe(200);
  });
});

describe('the audit list page number', () => {
  /** Keyset paging makes depth free, so the only rule is that it stays a
   *  number the rest of the code can do arithmetic on. */
  it('accepts a page far beyond any previous cap', async () => {
    const res = await get('/api/admin/audit?pageNum=250000');

    expect(res.statusCode).toBe(200);
  });

  it.each(['0', '-1', 'abc', '1.5'])('refuses %s', async (pageNum) => {
    const res = await get(`/api/admin/audit?pageNum=${pageNum}`);

    expect(res.statusCode).toBe(400);
  });
});
