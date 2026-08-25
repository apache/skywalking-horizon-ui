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

// `rolesFor` answers for BEARER credentials only — an API token or an OAuth
// token, neither of which proves a person is present. Everything here is about
// the same property: a directory that cannot ANSWER must not be read as a
// directory that said yes.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigSource } from '../config/loader.js';
import { configSchema, type HorizonConfig } from '../config/schema.js';

const resolveLdapUser = vi.hoisted(() => vi.fn());
vi.mock('./ldap.js', () => ({ resolveLdapUser }));

const { RoleResolver } = await import('./roles.js');

function sourceOf(cfg: HorizonConfig): ConfigSource {
  return {
    get current() {
      return cfg;
    },
    current_: () => cfg,
    path: '',
    onChange: () => () => {},
    close: async () => {},
  };
}

const LDAP = {
  url: 'ldap://directory.invalid',
  userBaseDn: 'ou=people,dc=test',
};

/** LDAP backend with a break-glass account configured, as an outage-ready
 *  deployment has it. */
function ldapConfig(): HorizonConfig {
  return configSchema.parse({
    auth: {
      backend: 'ldap',
      ldap: LDAP,
      breakGlass: { username: 'emergency', passwordHash: 'x'.repeat(20), roles: ['admin'] },
    },
  });
}

beforeEach(() => resolveLdapUser.mockReset());

describe('RoleResolver, when the directory cannot answer', () => {
  // The distinction the whole file exists for: resolveLdapUser never throws, it
  // reports a failure by setting `error`. Reading that as "not in LDAP" would
  // turn an outage into a role GRANT.
  it('refuses rather than falling through to the SSO table', async () => {
    resolveLdapUser.mockResolvedValue({ found: false, dn: null, groups: [], roles: [], error: 'connect ECONNREFUSED' });
    const cfg = configSchema.parse({
      auth: {
        backend: 'ldap',
        ldap: LDAP,
        sso: {
          // Scoped to a domain, so this directory username is NOT one any
          // provider would admit — the directory owns it, and an outage must
          // refuse rather than let the SSO table answer for somebody else's
          // namespace. (An address the provider DOES admit belongs to SSO and
          // never reaches the directory at all; that is the test above.)
          providers: [{ id: 'g', issuer: 'https://accounts.example', clientId: 'c', allowedDomains: ['corp.com'] }],
          roles: { defaultRoles: ['admin'], roleByEmail: {}, roleByDomain: {} },
        },
      },
    });
    expect(await new RoleResolver(sourceOf(cfg)).rolesFor('anyone@example.com')).toEqual([]);
  });

  // The regression this test exists for. A break-glass exemption here looks
  // reasonable — the account is not in the directory, so a failing lookup
  // refuses it — but `rolesFor` is reached only by tokens, which verify no
  // password and demand no probe. Exempting the username would mean one
  // induced timeout promotes a standing token to admin, silently and for as
  // long as the attacker can keep lookups failing. Break-glass earns its roles
  // at LOGIN instead (password + a fresh probe saying the directory is down),
  // and a browser session carries them from there.
  it('does NOT exempt the break-glass username', async () => {
    resolveLdapUser.mockResolvedValue({ found: false, dn: null, groups: [], roles: [], error: 'ETIMEDOUT' });
    expect(await new RoleResolver(sourceOf(ldapConfig())).rolesFor('emergency')).toEqual([]);
  });

  it('does not cache the refusal, so recovery is immediate', async () => {
    const resolver = new RoleResolver(sourceOf(ldapConfig()));
    resolveLdapUser.mockResolvedValueOnce({ found: false, dn: null, groups: [], roles: [], error: 'ETIMEDOUT' });
    expect(await resolver.rolesFor('someone')).toEqual([]);

    resolveLdapUser.mockResolvedValueOnce({ found: true, dn: 'uid=someone,dc=test', groups: [], roles: ['viewer'] });
    expect(await resolver.rolesFor('someone')).toEqual(['viewer']);
  });

  /**
   * The escalation: a session built by SSO carries the SSO table's roles, but a
   * TOKEN for the same username used to resolve through LDAP — so someone who
   * consented as a viewer held whatever the directory grants the account at
   * that address. Two paths, one person, two answers. The address namespace
   * belongs to SSO, and the directory is not asked about it.
   */
  it('does not let the directory answer for an address SSO owns', async () => {
    resolveLdapUser.mockResolvedValue({
      found: true, dn: 'uid=boss,dc=test', groups: [], roles: ['admin'],
    });
    const cfg = configSchema.parse({
      auth: {
        backend: 'ldap',
        ldap: LDAP,
        sso: {
          providers: [{ id: 'g', issuer: 'https://idp.example', clientId: 'c', allowedDomains: ['corp.com'] }],
          roles: { defaultRoles: ['viewer'], roleByEmail: {}, roleByDomain: {} },
        },
      },
    });
    expect(await new RoleResolver(sourceOf(cfg)).rolesFor('boss@corp.com')).toEqual(['viewer']);
    expect(resolveLdapUser, 'the directory must not be consulted at all').not.toHaveBeenCalled();
  });

  it('still asks the directory for a username no provider would admit', async () => {
    resolveLdapUser.mockResolvedValue({
      found: true, dn: 'uid=ops,dc=test', groups: [], roles: ['operator'],
    });
    const cfg = configSchema.parse({
      auth: {
        backend: 'ldap',
        ldap: LDAP,
        sso: {
          providers: [{ id: 'g', issuer: 'https://idp.example', clientId: 'c', allowedDomains: ['corp.com'] }],
          roles: { defaultRoles: ['viewer'], roleByEmail: {}, roleByDomain: {} },
        },
      },
    });
    expect(await new RoleResolver(sourceOf(cfg)).rolesFor('ops')).toEqual(['operator']);
  });

  it('reports the person as unknown, not merely role-less', async () => {
    resolveLdapUser.mockResolvedValue({ found: false, dn: null, groups: [], roles: [], error: 'ETIMEDOUT' });
    expect(await new RoleResolver(sourceOf(ldapConfig())).knows('someone')).toBe(false);
  });

  it('refuses when the lookup throws outright', async () => {
    resolveLdapUser.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    expect(await new RoleResolver(sourceOf(ldapConfig())).rolesFor('someone')).toEqual([]);
  });
});

/**
 * Existence has to be answerable on its own, because with `rbac.enabled: false`
 * every role list is empty AND every session holds `*` — so "no roles" stops
 * meaning "nobody", and the token resolvers lose the signal that revokes a
 * deleted user's credential.
 */
describe('RoleResolver knows who exists, separately from what they may do', () => {
  const local = (over: Record<string, unknown> = {}) =>
    configSchema.parse({
      auth: {
        local: { users: [{ username: 'alice', passwordHash: 'x'.repeat(20), roles: ['viewer'] }] },
        ...over,
      },
    });

  it('knows a configured local user', async () => {
    expect(await new RoleResolver(sourceOf(local())).knows('alice')).toBe(true);
  });

  it('does not know a username that was removed', async () => {
    expect(await new RoleResolver(sourceOf(local())).knows('bob')).toBe(false);
  });

  // A local user with an EMPTY role list still exists — the distinction the
  // whole method is for.
  it('knows a local user who holds no roles', async () => {
    const cfg = configSchema.parse({
      auth: { local: { users: [{ username: 'roleless', passwordHash: 'x'.repeat(20), roles: [] }] } },
    });
    const r = new RoleResolver(sourceOf(cfg));
    expect(await r.rolesFor('roleless')).toEqual([]);
    expect(await r.knows('roleless')).toBe(true);
  });

  it('knows an address a provider would admit, and no other', async () => {
    const cfg = local({
      sso: {
        providers: [{ id: 'g', issuer: 'https://idp.example', clientId: 'c', allowedDomains: ['corp.com'] }],
        roles: { defaultRoles: [], roleByEmail: {}, roleByDomain: {} },
      },
    });
    const r = new RoleResolver(sourceOf(cfg));
    // defaultRoles is empty, so roles alone cannot tell these two apart.
    expect(await r.rolesFor('dev@corp.com')).toEqual([]);
    expect(await r.knows('dev@corp.com')).toBe(true);
    expect(await r.knows('stranger@elsewhere.org')).toBe(false);
  });
});
