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
 * `GET /api/auth/health` — public, no auth required.
 *
 * Used by the login page to decide whether to show the LDAP-unreachable
 * banner and whether to enable the break-glass affordance. Returns a
 * minimal, non-sensitive snapshot: backend type, LDAP reachable state,
 * break-glass armed/disarmed. Never leaks DNs, bind passwords, or user
 * lists.
 */

import type { FastifyInstance } from 'fastify';
import type { ConfigSource } from '../config/loader.js';
import type { LdapHealth } from '../user/ldap-health.js';

export interface AuthHealthRouteDeps {
  config: ConfigSource;
  ldapHealth: LdapHealth;
}

export interface AuthHealthBody {
  backend: 'local' | 'ldap';
  ldap: null | {
    reachable: boolean;
    /** Hostname only — port and full DN are admin-only. */
    host: string;
    lastProbeAt: number | null;
    /** Seconds since the last *successful* probe. null when none. */
    lastSuccessAgoSeconds: number | null;
    error: string | null;
  };
  breakGlass: {
    /** True iff `auth.breakGlass` is configured AND would be honored
     *  given the current LDAP health. */
    armed: boolean;
  };
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function registerAuthHealthRoute(app: FastifyInstance, deps: AuthHealthRouteDeps): void {
  const { config: source, ldapHealth } = deps;

  app.get('/api/auth/health', async () => {
    const cfg = source.current;
    let ldap: AuthHealthBody['ldap'] = null;
    if (cfg.auth.backend === 'ldap' && cfg.auth.ldap) {
      // Refresh on-demand if stale (>30s) — the login page only calls
      // this every few seconds at most.
      await ldapHealth.getOrProbe(cfg.auth.ldap, 30_000).catch(() => undefined);
      const snap = ldapHealth.snapshot();
      const reachable = snap.result?.reachable ?? false;
      ldap = {
        reachable,
        host: hostnameOf(cfg.auth.ldap.url),
        lastProbeAt: snap.at,
        lastSuccessAgoSeconds:
          reachable && snap.at ? Math.round((Date.now() - snap.at) / 1000) : null,
        error: snap.result?.error ?? null,
      };
    }
    const breakGlassArmed = !!cfg.auth.breakGlass && (ldap === null ? false : !ldap.reachable);
    const body: AuthHealthBody = {
      backend: cfg.auth.backend,
      ldap,
      breakGlass: { armed: breakGlassArmed },
    };
    return body;
  });
}
