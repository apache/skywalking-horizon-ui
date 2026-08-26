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
 * Between the audit types and what BanyanDB holds.
 *
 * The conversions that are wrong in ways nothing reports: an absent tag is a
 * NULL arm rather than an omitted field, a 64-bit value arrives as a decimal
 * string, and an outcome is a number on one side and a union on the other.
 */

import type { StreamElement, StreamRow, MeasureRow, MeasureDataPoint } from '../../../client/banyandb/index.js';
import type { AuditEntry, AuditEvent, AuditKind, AuditReason, AuditStat, StoreStamp } from '../types.js';
import type { TokenUsage, TokenUsageEntry } from '../token-usage.js';

/** Tags carry no absent/empty distinction worth relying on, so a value that
 *  was not set is written as NULL and read back as undefined. */
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/**
 * A sign-in, as an element.
 *
 * `elementId` is derived from the row rather than minted: the server hashes it
 * and collapses repeats, so a batch re-sent after an uncertain outcome leaves
 * one row instead of two. It carries the process and the arrival counter
 * because two sign-ins by one principal can share a millisecond.
 */
export function toStreamRow(row: AuditEvent & StoreStamp, seq: number): StreamRow {
  return {
    timestampMs: row.at,
    elementId: `${row.at}:${row.kind}:${row.username}:${row.horizonNode}:${seq}`,
    tags: {
      username: row.username,
      kind: row.kind,
      outcome: row.outcome,
      provider: row.provider ?? null,
      protocol: row.protocol ?? null,
      reason: row.reason ?? null,
      mail: row.mail ?? null,
      roles: row.roles ?? null,
      client_ip: row.clientIp ?? null,
      horizon_ip: row.horizonIp ?? null,
      horizon_node: row.horizonNode,
    },
  };
}

/** `id` is the identity BanyanDB returns — the element's own, not one this
 *  store invented. */
export function toEntry(el: StreamElement): AuditEntry {
  const t = el.tags;
  return {
    id: el.elementId,
    at: el.timestampMs,
    kind: String(t.kind) as AuditKind,
    username: String(t.username ?? ''),
    outcome: Number(t.outcome) === 1 ? 1 : 0,
    ...(str(t.provider) ? { provider: str(t.provider) } : {}),
    ...(str(t.protocol) ? { protocol: str(t.protocol) as 'oidc' | 'oauth2' } : {}),
    ...(str(t.reason) ? { reason: str(t.reason) as AuditReason } : {}),
    ...(str(t.mail) ? { mail: str(t.mail) } : {}),
    ...(str(t.roles) ? { roles: str(t.roles) } : {}),
    ...(str(t.client_ip) ? { clientIp: str(t.client_ip) } : {}),
    ...(str(t.horizon_ip) ? { horizonIp: str(t.horizon_ip) } : {}),
    horizonNode: String(t.horizon_node ?? ''),
  };
}

/** The hour is the point's timestamp; the process is its series. */
export function toStatRow(stat: AuditStat): MeasureRow {
  return {
    timestampMs: hourStart(stat.hourBucket),
    tags: { horizon_node: stat.horizonNode, hour_bucket: stat.hourBucket },
    fields: {
      login_local: stat.login.local,
      login_ldap: stat.login.ldap,
      login_oidc: stat.login.oidc,
      login_oauth: stat.login.oauth,
      rejected: stat.rejected,
      over_budget: stat.overBudget,
    },
  };
}

export function toUsageRow(row: TokenUsage & StoreStamp): MeasureRow {
  return {
    timestampMs: hourStart(row.hourBucket),
    tags: { token_id: row.tokenId, horizon_node: row.horizonNode, hour_bucket: row.hourBucket, username: row.username },
    fields: { count: row.count },
  };
}

export function toUsageEntry(dp: MeasureDataPoint): TokenUsageEntry {
  return {
    hourBucket: Number(dp.tags.hour_bucket),
    at: dp.timestampMs,
    tokenId: String(dp.tags.token_id ?? ''),
    username: String(dp.tags.username ?? ''),
    horizonNode: String(dp.tags.horizon_node ?? ''),
    count: Number(dp.fields.count ?? 0),
  };
}

/** `yyyyMMddHH`, UTC, as epoch milliseconds. */
export function hourStart(bucket: number): number {
  const s = String(bucket);
  return Date.UTC(
    Number(s.slice(0, 4)),
    Number(s.slice(4, 6)) - 1,
    Number(s.slice(6, 8)),
    Number(s.slice(8, 10)),
  );
}
