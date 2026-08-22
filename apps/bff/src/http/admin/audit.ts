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
 * `/api/admin/audit*` — the login audit page.
 *
 * Three READS and nothing else. The audit log is append and query: rows come
 * from the sign-in paths and leave only when retention expires them, so there
 * is no write route, no delete, and no verb for one.
 *
 * A thin route: it parses, calls the service and shapes the reply. There is no
 * `logic/` seam because there is no orchestration to own — the service already
 * is the domain layer.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../../errors.js';
import type { AuthDeps } from '../../user/middleware.js';
import {
  AUDIT_KINDS,
  AUDIT_STAT_WINDOWS,
  DEFAULT_AUDIT_STAT_WINDOW,
  type AuditService,
  type AuditStatWindow,
} from '../../store/audit/types.js';

export interface AuditRouteDeps extends AuthDeps {
  audit: AuditService;
}

/** 50 rows, as the page renders. Clamped rather than trusted: an unbounded
 *  read over a 90-day table is a denial of service against your own
 *  database. */
const MAX_PAGE_SIZE = 200;

/**
 * Bounds a caller's timestamps to what the COLUMN can hold, not to what a JS
 * `Date` can represent.
 *
 * The wider range is representable in JS and still out of range for
 * `timestamptz`, so it reached the driver, failed there, and — because a query
 * failure is evidence about the store — marked the audit log unavailable. A
 * value the caller supplied should be a 400, never a reason to report the
 * database down. Postgres tops out at 294276 AD; a century either side of now
 * is far past any audit question and comfortably inside it.
 */
const EPOCH_MIN = Date.UTC(1900, 0, 1);
const EPOCH_MAX = Date.UTC(2200, 0, 1);

/**
 * A filter value the database can actually hold.
 *
 * Postgres `text` cannot contain a NUL byte: one reaches the driver and fails
 * with 22021, and because a query failure is evidence about the store, an
 * `audit:read` caller could flap the audit log's health by sending `%00`. A
 * caller's input belongs in a 400, never in the store's health.
 */
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => !v.includes('\u0000'), { message: 'must not contain a NUL byte' })
    .optional();

const listQuerySchema = z.object({
  from: z.coerce.number().int().min(EPOCH_MIN).max(EPOCH_MAX).optional(),
  to: z.coerce.number().int().min(EPOCH_MIN).max(EPOCH_MAX).optional(),
  kind: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : v.split(','))),
  username: text(256),
  // Bounded, not merely positive: the store turns this into an OFFSET, and an
  // enormous one is a full scan the caller chose.
  pageNum: z.coerce.number().int().positive().max(100_000).default(1),
  pageSize: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(50),
});

const statQuerySchema = z.object({
  window: z.coerce.number().int().optional(),
});

export function registerAuditRoutes(app: FastifyInstance, deps: AuditRouteDeps): void {
  app.get('/api/admin/audit', async (req) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest('invalid audit query', parsed.error.flatten());
    const q = parsed.data;
    // A `kind` filter that matches nothing must return NOTHING. Dropping
    // unknown values and then treating the empty list as "no filter" made the
    // filter fail OPEN: `?kind=bogus` returned the entire log, and a typo in a
    // real kind quietly widened the query instead of narrowing it.
    const kind = q.kind?.filter((k): k is (typeof AUDIT_KINDS)[number] =>
      (AUDIT_KINDS as readonly string[]).includes(k),
    );
    if (q.kind !== undefined && kind?.length === 0) {
      return { rows: [], pageNum: q.pageNum, pageSize: q.pageSize, hasNext: false };
    }
    return deps.audit.query({ ...q, kind });
  });

  app.get('/api/admin/audit/stat', async (req) => {
    const parsed = statQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest('invalid audit stat query', parsed.error.flatten());
    const requested = parsed.data.window;
    const window: AuditStatWindow = (AUDIT_STAT_WINDOWS as readonly number[]).includes(
      requested ?? -1,
    )
      ? (requested as AuditStatWindow)
      : DEFAULT_AUDIT_STAT_WINDOW;
    return deps.audit.queryStat(window);
  });

  /** Health is process-local, so the reply names the node it came from — a
   *  multi-replica deployment has as many answers as replicas. */
  app.get('/api/admin/audit/status', async () => deps.audit.health());
}
