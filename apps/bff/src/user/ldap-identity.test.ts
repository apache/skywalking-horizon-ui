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
 * Which string becomes the signed-in identity.
 *
 * It used to be derived from the DN's first component, on the theory that the
 * directory's own name for an entry is more canonical than whatever spelling
 * was typed. That is true of the DN and false of the first RDN: Active
 * Directory names entries `CN=Display Name`, which has nothing to do with the
 * `sAMAccountName` people sign in with. The derived string became the session
 * identity, the OAuth `sub`, and the key every later role lookup re-resolved —
 * so a directory that names entries by display name could seat someone under a
 * principal that is not theirs, or one that does not exist.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { LdapConfig } from '../config/schema.js';

const bind = vi.fn(async () => {});
const unbind = vi.fn(async () => {});
const search = vi.fn(async () => ({ searchEntries: [] as Array<Record<string, unknown>> }));

vi.mock('ldapts', () => ({
  Client: class {
    bind = bind;
    unbind = unbind;
    search = search;
  },
}));

const { verifyLdapCredentials } = await import('./ldap.js');

const cfg: LdapConfig = {
  url: 'ldap://localhost',
  bindDn: 'cn=svc,dc=corp',
  bindPassword: 'x',
  userBaseDn: 'ou=people,dc=corp',
  // Active Directory's login attribute — note it is NOT the DN's first RDN.
  userFilter: '(sAMAccountName={username})',
  displayNameAttr: 'cn',
  groupStrategy: 'memberOf',
  groupBaseDn: '',
  memberAttr: 'member',
  groupMappings: [{ group: '*', role: 'viewer' }],
  timeoutMs: 5000,
  tlsInsecure: false,
};

beforeEach(() => {
  bind.mockClear(); unbind.mockClear();
  search.mockReset();
});

describe('the LDAP identity', () => {
  /** The Active Directory shape the old derivation got wrong. */
  it('is the login identifier that was verified, not the DN first RDN', async () => {
    search.mockResolvedValue({
      searchEntries: [{
        dn: 'CN=Alice Smith,OU=Users,DC=corp',
        cn: 'Alice Smith',
        memberOf: ['CN=Staff,OU=Groups,DC=corp'],
      }],
    });
    const out = await verifyLdapCredentials(cfg, 'asmith', 'pw');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // NOT 'Alice Smith', which is what the DN's first component says.
    expect(out.identity.username).toBe('asmith');
    // The DN is still carried, because the audit budget meters on it.
    expect(out.identity.dn).toBe('CN=Alice Smith,OU=Users,DC=corp');
  });

  it('keeps the submitted identifier even where the RDN happens to agree', async () => {
    search.mockResolvedValue({
      searchEntries: [{
        dn: 'uid=alice,ou=people,dc=corp',
        cn: 'Alice',
        memberOf: [],
      }],
    });
    const out = await verifyLdapCredentials(cfg, 'alice', 'pw');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.identity.username).toBe('alice');
  });

  /* Two spellings are two sessions and ONE metered principal — the folding
   * that the DN derivation was reaching for, done where it is safe. */
  it('carries one DN for either spelling, so metering still sees one account', async () => {
    search.mockResolvedValue({
      searchEntries: [{ dn: 'CN=Alice Smith,OU=Users,DC=corp', cn: 'Alice Smith', memberOf: [] }],
    });
    const lower = await verifyLdapCredentials(cfg, 'asmith', 'pw');
    const upper = await verifyLdapCredentials(cfg, 'ASmith', 'pw');
    expect(lower.ok && upper.ok).toBe(true);
    if (!lower.ok || !upper.ok) return;
    expect(lower.identity.username).not.toBe(upper.identity.username);
    expect(lower.identity.dn).toBe(upper.identity.dn);
  });
});
