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
 * Value handling between `pg` and the audit types — the small conversions that
 * are wrong in ways nothing reports.
 */

import { isIP } from 'node:net';
import type { AuditEntry, AuditKind, AuditReason } from '../types.js';

/**
 * `bigint` and `SUM()` arrive as STRINGS.
 *
 * node-postgres returns `int8` as text because the range exceeds
 * `Number.MAX_SAFE_INTEGER`, and both failures are quiet: `"2026082114" >
 * 2026082110` is a string comparison that happens to work, and `SUM` totals
 * concatenate instead of adding. So every one is converted deliberately, and
 * throws rather than yielding `NaN`.
 *
 * A global type parser would be the shorter fix and the wrong one — it changes
 * how every other consumer in the process reads `int8`.
 */
export function toNumber(value: unknown, field: string): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`audit: ${field} is not numeric: ${String(value)}`);
  return n;
}

/** `id` stays a STRING all the way out. Narrowing a bigint to a JS number for
 *  the sake of a tidier type is a silent precision bug. */
export function toId(value: unknown): string {
  return String(value);
}


/**
 * A malformed address raises a Postgres type error mid-statement, which would
 * cost the whole batch. An address that does not parse is stored as NULL: a
 * bad address must not cost the row it came on.
 */
export function toInet(value: string | undefined): string | null {
  if (!value) return null;
  return isIP(value) === 0 ? null : value;
}

export interface RawAuditRow {
  id: unknown;
  at: Date;
  kind: string;
  provider: string | null;
  protocol: string | null;
  outcome: number;
  reason: string | null;
  username: string;
  mail: string | null;
  roles: string | null;
  client_ip: string | null;
  horizon_ip: string | null;
  horizon_node: string;
}

export function toEntry(row: RawAuditRow): AuditEntry {
  return {
    id: toId(row.id),
    at: row.at.getTime(),
    kind: row.kind as AuditKind,
    outcome: (row.outcome === 1 ? 1 : 0) as 0 | 1,
    username: row.username,
    horizonNode: row.horizon_node,
    ...(row.reason ? { reason: row.reason as AuditReason } : {}),
    ...(row.mail ? { mail: row.mail } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.protocol ? { protocol: row.protocol as 'oidc' | 'oauth2' } : {}),
    ...(row.roles ? { roles: row.roles } : {}),
    ...(row.client_ip ? { clientIp: row.client_ip } : {}),
    ...(row.horizon_ip ? { horizonIp: row.horizon_ip } : {}),
  };
}

/**
 * Build the `VALUES ($1,$2,…),($9,$10,…)` list for a multi-row insert.
 *
 * Chunking is the caller's job, and it matters: the wire protocol caps a
 * statement at 65535 bind parameters, and a flush that silently failed only on
 * the busiest deployment is the worst kind of bug to ship.
 */
export function valuesClause(rowCount: number, columnCount: number): string {
  const groups: string[] = [];
  for (let r = 0; r < rowCount; r += 1) {
    const params: string[] = [];
    for (let c = 1; c <= columnCount; c += 1) params.push(`$${r * columnCount + c}`);
    groups.push(`(${params.join(',')})`);
  }
  return groups.join(',');
}
