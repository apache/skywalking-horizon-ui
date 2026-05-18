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

export interface AuthHealth {
  backend: 'local' | 'ldap';
  ldap: null | {
    reachable: boolean;
    host: string;
    lastProbeAt: number | null;
    lastSuccessAgoSeconds: number | null;
    error: string | null;
  };
  breakGlass: { armed: boolean };
}

export interface AuthStatus {
  configPath: string;
  configMtime: number | null;
  configSizeBytes: number | null;
  backend: 'local' | 'ldap';
  bothPresent: boolean;
  sessions: { active: number };
  local: { users: number; role: 'primary' | 'break-glass-only' };
  ldap: null | {
    url: string;
    host: string;
    bindDn: string;
    anonymous: boolean;
    userBaseDn: string;
    groupStrategy: 'memberOf' | 'search';
    groupMappings: Array<{ group: string; role: string }>;
    probe: {
      reachable: boolean;
      serviceBindOk: boolean | null;
      userSearchOk: boolean | null;
      userEntriesVisible: number | null;
      latencyMs: number | null;
      error?: string;
      at: number | null;
    };
  };
  breakGlass: {
    configured: boolean;
    armed: boolean;
    username: string | null;
  };
  rbac: {
    enabled: boolean;
    roles: Record<string, string[]>;
    landingByRole: Record<string, string>;
    knownVerbs: string[];
  };
}

export interface AuthProbeResult {
  probe: {
    reachable: boolean;
    serviceBindOk: boolean | null;
    userSearchOk: boolean | null;
    userEntriesVisible: number | null;
    latencyMs: number | null;
    error?: string;
  };
  resolved: null | {
    username: string;
    found: boolean;
    dn: string | null;
    groups: string[];
    roles: string[];
    error?: string;
  };
}

/** `bff.adminAuth` — Auth Status admin page + public LDAP health probe. */
export class AdminAuthApi {
  constructor(private readonly bff: BffClient) {}

  /** Public: drives the LoginView LDAP-unreachable banner. No auth needed. */
  health(): Promise<AuthHealth> {
    return this.bff.request<AuthHealth>('GET', '/api/auth/health');
  }

  status(): Promise<AuthStatus> {
    return this.bff.request<AuthStatus>('GET', '/api/admin/auth-status');
  }

  /** Force a fresh LDAP probe. Optional `username` resolves group→role
   *  mapping for that user without authenticating. */
  probe(username?: string): Promise<AuthProbeResult> {
    return this.bff.request<AuthProbeResult>(
      'POST',
      '/api/admin/auth-status/probe',
      username ? { username } : {},
    );
  }
}
