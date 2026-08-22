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

export type AuditKind = 'local' | 'ldap' | 'break-glass' | 'sso' | 'api-token' | 'oauth-token';
export type AuditReason = 'no_roles' | 'zero_group_mappings';
export type AuditStatWindow = 2 | 6 | 12;

export interface AuditEntry {
  id: string;
  at: number;
  kind: AuditKind;
  outcome: 0 | 1;
  reason?: AuditReason;
  /** The verified principal. A login name, a verified email, or a token id —
   *  `kind` says how to read it. Never an unverified attempt. */
  username: string;
  mail?: string;
  provider?: string;
  /** What the sign-in granted, comma-separated. */
  roles?: string;
  clientIp?: string;
  horizonNode: string;
  horizonIp?: string;
  /** Present only on an aggregate row — a credential-hour rather than a
   *  single sign-in. */
  hourBucket?: number;
  /** 1 on a sign-in row; the accumulated uses on an aggregate. */
  count: number;
}

export interface AuditPage {
  rows: AuditEntry[];
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
  token: number;
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

  stat(window: AuditStatWindow): Promise<AuditStatResult> {
    return this.bff.request<AuditStatResult>('GET', `/api/admin/audit/stat?window=${window}`);
  }

  /** Health is process-local: in a multi-replica deployment this is whichever
   *  node answered, and the page says so. */
  status(): Promise<AuditHealth> {
    return this.bff.request<AuditHealth>('GET', '/api/admin/audit/status');
  }
}
