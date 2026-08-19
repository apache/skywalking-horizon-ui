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
 * A username's CURRENT roles, read from the configured auth backend.
 *
 * Both credential kinds that have no server-side session — the API token from
 * `auth.tokensFile` and an OAuth access token — resolve roles this way on every
 * request. That is what makes deleting a user revoke their credentials without
 * anything having to be revoked: an unknown user resolves to no roles, and no
 * roles is refused.
 *
 * The order is local → directory → SSO. Local first so a break-glass account
 * survives a broken provider; SSO last because it is a mapping over the
 * address rather than a directory that can be asked.
 */

import type { ConfigSource } from '../config/loader.js';
import { resolveLdapUser } from './ldap.js';
import { oidcAdmits, oidcRolesFor } from './oidc/identity.js';
import { logger } from '../logger.js';

/** How long a successful LDAP lookup is reused. A directory should not be
 *  queried on every request; a demotion applies within this window. */
const CACHE_MS = 30_000;

/** What a lookup established: what this person may do, and whether they are
 *  anybody at all. Kept apart because `rbac.enabled: false` makes roles
 *  uninformative — see `oidcAdmits`. */
interface Resolution {
  roles: string[];
  known: boolean;
}

export class RoleResolver {
  private cache = new Map<string, { res: Resolution; at: number }>();

  constructor(private readonly config: ConfigSource) {}

  /** `[]` when the user no longer exists — see the file comment. */
  async rolesFor(username: string): Promise<string[]> {
    return (await this.resolve(username)).roles;
  }

  /**
   * Does this person still exist in whatever backend owns them?
   *
   * Separate from `rolesFor` so that a deleted user's TOKEN can be refused
   * under `rbac.enabled: false`, where every role list is empty-but-omnipotent
   * and therefore says nothing about whether the account is still there.
   */
  async knows(username: string): Promise<boolean> {
    return (await this.resolve(username)).known;
  }

  private async resolve(username: string): Promise<Resolution> {
    const cfg = this.config.current;
    // Local users live in memory, so resolution is a lookup — caching it would
    // only delay a config change for no gain.
    if (cfg.auth.backend !== 'ldap' || !cfg.auth.ldap) {
      const local = cfg.auth.local.users.find((u) => u.username === username)?.roles;
      // Local FIRST, so a break-glass account keeps working when a provider
      // misbehaves; SSO identities are a fallback, resolved from the address
      // alone (see oidc/identity.ts on why it cannot be claim-based).
      if (local) return { roles: local, known: true };
      return { roles: oidcRolesFor(cfg, username), known: oidcAdmits(cfg, username) };
    }
    // SSO OWNS THE ADDRESS NAMESPACE, and the directory is not asked about it.
    //
    // The same partition the loader enforces for local users, which it can do
    // by dropping them at boot; a directory cannot be edited from here, so the
    // rule is applied at lookup instead. Without it the two paths disagree
    // about the same person: signing in through SSO builds the session from the
    // SSO role table, while a token for that username resolves through LDAP —
    // so someone who consented as a viewer held whatever the directory grants
    // the account at the same address, and the consent screen had told them
    // otherwise.
    //
    // Only addresses a provider would actually admit are taken this way, so a
    // directory whose usernames merely look like addresses is unaffected unless
    // a provider claims that domain.
    if (oidcAdmits(cfg, username)) {
      return { roles: oidcRolesFor(cfg, username), known: true };
    }
    const hit = this.cache.get(username);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.res;
    try {
      const res = await resolveLdapUser(cfg.auth.ldap, username);
      // `found: false` means two different things and they must not be
      // conflated: the directory ANSWERED and has no such user, or the lookup
      // FAILED. resolveLdapUser never throws — it reports a failure by setting
      // `error` — so treating both as "not in LDAP" turned a directory outage
      // into a role GRANT from the SSO table, for every email-shaped username,
      // cached for the window. That is fail-open in the one module whose whole
      // job is to fail closed.
      if (res.error) {
        // Deliberately no break-glass exemption here, though it is tempting:
        // the emergency account is not in the directory, so a failing lookup
        // refuses it. That is correct, because this function serves only
        // BEARER credentials — an API token or an OAuth token, neither of
        // which proves a person is present. Break-glass proves one: it is a
        // browser login that verifies a password AND requires a fresh probe
        // saying the directory really is down (see http/user.ts). Granting it
        // here would need neither, so any transient failure — one timeout, a
        // refused connection, a TLS blip — would hand admin to a standing
        // token, and to anyone able to make a single lookup fail on demand.
        logger.warn(
          { username, err: res.error },
          'role resolution: the directory could not answer — refusing the credential rather than falling back',
        );
        return { roles: [], known: false };
      }
      const out: Resolution = res.found
        ? { roles: res.roles, known: true }
        : { roles: oidcRolesFor(cfg, username), known: oidcAdmits(cfg, username) };
      // Only a SUCCESSFUL lookup is cached. Caching a failure would keep
      // refusing valid credentials for the rest of the window after the
      // directory recovers, turning a blip into an outage.
      this.cache.set(username, { res: out, at: Date.now() });
      return out;
    } catch (err) {
      logger.warn(
        { username, err: err instanceof Error ? err.message : String(err) },
        'role resolution failed — refusing the credential rather than assuming roles',
      );
      return { roles: [], known: false };
    }
  }
}
