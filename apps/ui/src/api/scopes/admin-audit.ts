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

import type { BffClient } from '../client';

export type AuditKind = 'local' | 'ldap' | 'break-glass' | 'sso';
export type AuditReason = 'no_roles' | 'zero_group_mappings';
export type AuditStatWindow = 2 | 6 | 12;

export interface AuditEntry {
  id: string;
  at: number;
  kind: AuditKind;
  outcome: 0 | 1;
  reason?: AuditReason;
  /** The verified principal — a login name, or a verified email on the SSO
   *  path. Never an unverified attempt. */
  username: string;
  mail?: string;
  provider?: string;
  /** Which SSO protocol proved the identity. Present on `sso` rows recorded
   *  since it began being stored, absent on older ones — the chart could
   *  always split these because it counts them at sign-in, the row could not. */
  protocol?: 'oidc' | 'oauth2';
  /** What the sign-in granted, comma-separated. */
  roles?: string;
  clientIp?: string;
  horizonNode: string;
  horizonIp?: string;
}

export interface AuditPage {
  rows: AuditEntry[];
  /** Opaque `<epochMs>:<id>` position to resume from. Absent on the last
   *  page. Paging is keyset, not offset: the table is appended to at exactly
   *  the end the page reads from, so an offset counts a moving target and a
   *  row written between two requests is shown twice or skipped. */
  nextCursor?: string;
  pageNum: number;
  pageSize: number;
  /** The only paging fact this reports: there IS more, never how much more. */
  hasNext: boolean;
}

export interface AuditLoginCounts {
  local: number;
  ldap: number;
  oidc: number;
  oauth: number;
}

export interface AuditStatColumn {
  hourBucket: number;
  /** Accepted sign-ins only. */
  login: AuditLoginCounts;
  rejected: number;
}

export interface AuditStatResult {
  columns: AuditStatColumn[];
  /** Never stacked into the columns: it counts rows that were never written,
   *  so drawing it beside rows that were would read as volume. */
  overBudget: number;
  horizonNodes: number;
}

export interface AuditHealth {
  horizonNode: string;
  enabled: boolean;
  configured: boolean;
  available: boolean;
  error?: 'unreachable' | 'auth_failed' | 'timeout' | 'schema_error';
  /** Set when the configuration itself was refused at boot — a different
   *  problem, and a different next step, from a store that could not be
   *  reached. */
  configProblem?: string;
  rowsThisHour: number;
  overBudgetThisHour: number;
}

/**
 * One credential's hour, merged across every Horizon that served it.
 *
 * Carries no node. The stored rows are per node — that is what keeps replicas
 * from overwriting each other — but they are summed before they leave the
 * server, so a row here belongs to the deployment and naming one process for
 * it would be picking a winner arbitrarily.
 */
export interface TokenUsageCredential {
  hourBucket: number;
  /** The hour's start, epoch ms. */
  at: number;
  tokenId: string;
  username: string;
  count: number;
}

/** One group per hour, so the span is capped at twelve. */
export const MAX_TOKEN_USAGE_HOURS = 12;
export const DEFAULT_TOKEN_USAGE_HOURS = 6;

/** One hour of the window. */
export interface TokenUsageHour {
  hourBucket: number;
  at: number;
  /** Every use in the hour, across ALL credentials — not just the listed ones. */
  total: number;
  /** Distinct credentials used. Greater than `top.length` means the list is a
   *  sample of the busiest, not the whole hour. */
  credentials: number;
  top: TokenUsageCredential[];
}

export interface TokenUsageResult {
  hours: TokenUsageHour[];
  /** The bounds actually covered, snapped out to whole hour groups. Not always
   *  the bounds that were asked for, so the picker shows these back. */
  range: { from: number; to: number };
}

/** Time range, how someone signed in, and who. Nothing else — the page is
 *  read, not queried. */
export interface AuditQuery {
  from?: number;
  to?: number;
  kind?: AuditKind[];
  /** Prefix match. */
  username?: string;
  pageNum?: number;
  pageSize?: number;
  cursor?: string;
}

/** `bff.adminAudit` — the login audit page. Read-only: the log is append and
 *  query, so there is nothing here that writes or deletes. */
export class AdminAuditApi {
  constructor(private readonly bff: BffClient) {}

  list(query: AuditQuery = {}): Promise<AuditPage> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === '') continue;
      params.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    const qs = params.toString();
    return this.bff.request<AuditPage>('GET', `/api/admin/audit${qs ? `?${qs}` : ''}`);
  }

  /**
   * Token usage — the separate statistic, one group per hour.
   *
   * A RANGE rather than a page: presenting a token is not a login, and the
   * question is which hours were busy and who made them busy.
   */
  tokenUsage(range: { from: number; to: number }): Promise<TokenUsageResult> {
    return this.bff.request<TokenUsageResult>(
      'GET', `/api/admin/token-usage?from=${range.from}&to=${range.to}`,
    );
  }

  stat(window: AuditStatWindow): Promise<AuditStatResult> {
    return this.bff.request<AuditStatResult>('GET', `/api/admin/audit/stat?window=${window}`);
  }

  /** Health is process-local: in a multi-replica deployment this is whichever
   *  node answered, and the page says so. */
  status(): Promise<AuditHealth> {
    return this.bff.request<AuditHealth>('GET', '/api/admin/audit/status');
  }
}
