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
 * `GET /api/admin/users` — read-only listing for the admin Users page.
 *
 * The shape merges two sources:
 *   - static local users (always present, from `auth.local.users`)
 *   - cached "seen" users (added on first successful login, kept in
 *     memory for the lifetime of the BFF process)
 *
 * In LDAP mode local users are flagged `localOnly: true` and shown as
 * fallback rows ("break-glass · file fallback"). Their `lastSeenAt`
 * comes from the seen cache when available; otherwise null ("never").
 */

import type { FastifyInstance } from 'fastify';
import type { ConfigSource } from '../../config/loader.js';
import type { UserSeenCache, SeenSource } from '../../user/seen-cache.js';

export interface UsersRouteDeps {
  config: ConfigSource;
  seenCache: UserSeenCache;
}

export interface AdminUserRow {
  username: string;
  source: SeenSource | 'local';
  /** Roles as resolved at the user's last login (LDAP/break-glass)
   *  OR as declared in `auth.local.users[].roles` (local). */
  roles: string[];
  lastSeenAt: number | null;
  lastIp: string | null;
  /** True when the row comes only from the static file and the user
   *  has never logged in on this BFF instance. */
  staticOnly: boolean;
  /** True when the active backend is LDAP and this user lives only in
   *  the local fallback file. Distinguishes break-glass-only accounts
   *  from "regular" users. */
  fallbackOnly: boolean;
}

export interface AdminUsersBody {
  generatedAt: number;
  backend: 'local' | 'ldap';
  rows: AdminUserRow[];
  counts: {
    total: number;
    fromLdap: number;
    local: number;
    activeLast24h: number;
  };
}

export function registerAdminUsersRoute(app: FastifyInstance, deps: UsersRouteDeps): void {
  const { config: source, seenCache } = deps;

  app.get('/api/admin/users', async () => {
    const cfg = source.current;
    const seenByName = new Map(seenCache.list().map((u) => [u.username, u]));
    const localByName = new Map(cfg.auth.local.users.map((u) => [u.username, u]));

    const allNames = new Set<string>([...seenByName.keys(), ...localByName.keys()]);
    const rows: AdminUserRow[] = [];

    for (const name of allNames) {
      const seen = seenByName.get(name);
      const local = localByName.get(name);
      const fallbackOnly = cfg.auth.backend === 'ldap' && !!local;
      if (seen) {
        rows.push({
          username: name,
          source: seen.source,
          roles: seen.roles,
          lastSeenAt: seen.lastSeenAt,
          lastIp: seen.lastIp,
          staticOnly: false,
          fallbackOnly,
        });
      } else if (local) {
        rows.push({
          username: name,
          source: 'local',
          roles: local.roles,
          lastSeenAt: null,
          lastIp: null,
          staticOnly: true,
          fallbackOnly,
        });
      }
    }

    rows.sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));

    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const counts = {
      total: rows.length,
      fromLdap: rows.filter((r) => r.source === 'ldap').length,
      local: rows.filter((r) => r.source === 'local' || r.source === 'break-glass').length,
      activeLast24h: rows.filter((r) => r.lastSeenAt !== null && now - r.lastSeenAt <= dayMs).length,
    };

    const body: AdminUsersBody = {
      generatedAt: now,
      backend: cfg.auth.backend,
      rows,
      counts,
    };
    return body;
  });
}
