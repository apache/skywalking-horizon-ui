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
 * The schemas are strict, so the interesting cases are the ones that must be
 * REFUSED rather than quietly dropped — a parameter this route no longer takes
 * has to fail, or whoever sent it goes on believing it worked.
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
  /** The list is paged the way OAP pages every list it serves — by page
   *  number — so a cursor is not merely unused, it must not be honoured. A
   *  parameter that is silently ignored reads to a caller as one that worked. */
  it('is refused, not ignored', async () => {
    const res = await get('/api/admin/audit?cursor=1700000000000:42');

    // 400, because a parameter that is silently dropped reads to whoever sent
    // it as one that was honoured — and a resume position that appears to work
    // while doing nothing pages the same rows forever.
    expect(res.statusCode).toBe(400);
  });

  it('is gone from the reply as well as the request', async () => {
    const res = await get('/api/admin/audit');

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).not.toHaveProperty('nextCursor');
  });
});

describe('the audit list page number', () => {
  it('accepts a page within the depth bound', async () => {
    const res = await get('/api/admin/audit?pageNum=500');

    expect(res.statusCode).toBe(200);
  });

  /** An offset is paid for by the backend — every skipped row is read and
   *  discarded — so depth is bounded rather than free. Refused at the edge
   *  rather than clamped: a clamp would answer page 1 to someone who asked
   *  for page 250 000 and say nothing about it. */
  it('refuses a page past the depth bound', async () => {
    const res = await get('/api/admin/audit?pageNum=501');

    expect(res.statusCode).toBe(400);
  });

  it.each(['0', '-1', 'abc', '1.5'])('refuses %s', async (pageNum) => {
    const res = await get(`/api/admin/audit?pageNum=${pageNum}`);

    expect(res.statusCode).toBe(400);
  });
});
