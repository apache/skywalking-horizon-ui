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
 * `/api/admin/auth-status` — read-only board for the admin "Auth Status"
 * page. Reports:
 *   - active backend, source file path + mtime/size
 *   - local user count (when local backend)
 *   - LDAP connection probe (latest service-bind + user-search state)
 *   - resolved group->role mappings
 *   - active session count
 *   - break-glass armed/disarmed
 *
 * `POST /api/admin/auth-status/probe` forces a fresh LDAP probe and
 * (optionally) resolves a sample username to debug group mappings
 * without the user being present.
 */

import { statSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ConfigSource } from '../../config/loader.js';
import { probeLdap, resolveLdapUser } from '../../user/ldap.js';
import type { LdapHealth } from '../../user/ldap-health.js';
import type { SessionStore } from '../../user/sessions.js';
import { VERBS } from '../../rbac/verbs.js';

export interface AuthStatusRouteDeps {
  config: ConfigSource;
  ldapHealth: LdapHealth;
  sessions: SessionStore;
}

export interface AuthStatusBody {
  configPath: string;
  /** Last-modified time of the config file (ms). null if stat failed. */
  configMtime: number | null;
  /** File size in bytes; small detail that helps detect unexpected drift. */
  configSizeBytes: number | null;
  backend: 'local' | 'ldap';
  bothPresent: boolean;
  sessions: { active: number };
  local: {
    users: number;
    /** When LDAP is the active backend, the local users are still
     *  displayed but flagged as fallback-only. */
    role: 'primary' | 'break-glass-only';
  };
  ldap:
    | null
    | {
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
    /** True iff configured AND the LDAP probe is currently failing. */
    armed: boolean;
    username: string | null;
  };
  /** RBAC policy snapshot — drives the read-only Roles & permissions
   *  page. The roles + grants come straight from `rbac.roles` in
   *  horizon.yaml; `knownVerbs` is the closed namespace declared in
   *  the BFF's verbs module. */
  rbac: {
    enabled: boolean;
    roles: Record<string, string[]>;
    landingByRole: Record<string, string>;
    knownVerbs: string[];
  };
}

const probeBodySchema = z.object({
  username: z.string().min(1).optional(),
});

function hostnameOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function registerAuthStatusRoutes(app: FastifyInstance, deps: AuthStatusRouteDeps): void {
  const { config: source, ldapHealth, sessions } = deps;

  app.get('/api/admin/auth-status', async () => {
    const cfg = source.current;

    let configMtime: number | null = null;
    let configSizeBytes: number | null = null;
    try {
      const st = statSync(source.path);
      configMtime = st.mtimeMs;
      configSizeBytes = st.size;
    } catch {
      /* file missing — leave null */
    }

    const bothPresent =
      cfg.auth.backend === 'ldap' && cfg.auth.local.users.length > 0;

    let ldapBlock: AuthStatusBody['ldap'] = null;
    let breakGlassArmed = false;
    if (cfg.auth.backend === 'ldap' && cfg.auth.ldap) {
      const snap = ldapHealth.snapshot();
      const reachable = snap.result?.reachable ?? false;
      ldapBlock = {
        url: cfg.auth.ldap.url,
        host: hostnameOf(cfg.auth.ldap.url),
        bindDn: cfg.auth.ldap.bindDn,
        anonymous: cfg.auth.ldap.bindDn === '',
        userBaseDn: cfg.auth.ldap.userBaseDn,
        groupStrategy: cfg.auth.ldap.groupStrategy,
        groupMappings: cfg.auth.ldap.groupMappings.map((m) => ({ group: m.group, role: m.role })),
        probe: {
          reachable,
          serviceBindOk: snap.result?.serviceBindOk ?? null,
          userSearchOk: snap.result?.userSearchOk ?? null,
          userEntriesVisible: snap.result?.userEntriesVisible ?? null,
          latencyMs: snap.result?.latencyMs ?? null,
          error: snap.result?.error,
          at: snap.at,
        },
      };
      breakGlassArmed = !!cfg.auth.breakGlass && !reachable;
    }

    const body: AuthStatusBody = {
      configPath: source.path,
      configMtime,
      configSizeBytes,
      backend: cfg.auth.backend,
      bothPresent,
      sessions: { active: sessions.size() },
      local: {
        users: cfg.auth.local.users.length,
        role: cfg.auth.backend === 'local' ? 'primary' : 'break-glass-only',
      },
      ldap: ldapBlock,
      breakGlass: {
        configured: !!cfg.auth.breakGlass,
        armed: breakGlassArmed,
        username: cfg.auth.breakGlass?.username ?? null,
      },
      rbac: {
        enabled: cfg.rbac.enabled,
        roles: cfg.rbac.roles,
        landingByRole: cfg.rbac.landingByRole,
        knownVerbs: Object.values(VERBS).sort(),
      },
    };
    return body;
  });

  app.post('/api/admin/auth-status/probe', async (req: FastifyRequest, reply) => {
    const cfg = source.current;
    if (cfg.auth.backend !== 'ldap' || !cfg.auth.ldap) {
      return reply.code(409).send({ error: 'ldap_not_configured' });
    }
    const parsed = probeBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    const fresh = await probeLdap(cfg.auth.ldap);
    await ldapHealth.probe(cfg.auth.ldap).catch(() => undefined);

    let resolved:
      | { username: string; found: boolean; dn: string | null; groups: string[]; roles: string[]; error?: string }
      | null = null;
    if (parsed.data.username) {
      const r = await resolveLdapUser(cfg.auth.ldap, parsed.data.username);
      resolved = { username: parsed.data.username, ...r };
    }
    return { probe: fresh, resolved };
  });
}
