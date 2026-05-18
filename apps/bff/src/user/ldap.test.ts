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

import { describe, expect, it } from 'vitest';
import type { LdapConfig } from '../config/schema.js';
import { escapeFilterValue, mapGroupsToRoles } from './ldap.js';

const cfgBase: LdapConfig = {
  url: 'ldap://localhost',
  bindDn: '',
  bindPassword: '',
  userBaseDn: 'ou=people,dc=corp',
  userFilter: '(uid={username})',
  displayNameAttr: 'cn',
  groupStrategy: 'memberOf',
  groupBaseDn: '',
  memberAttr: 'member',
  groupMappings: [],
  timeoutMs: 5000,
  tlsInsecure: false,
};

describe('escapeFilterValue', () => {
  it('escapes the RFC 4515 metacharacters', () => {
    expect(escapeFilterValue('a*b')).toBe('a\\2ab');
    expect(escapeFilterValue('a(b)c')).toBe('a\\28b\\29c');
    expect(escapeFilterValue('a\\b')).toBe('a\\5cb');
    expect(escapeFilterValue('a\0b')).toBe('a\\00b');
  });

  it('passes ordinary characters through', () => {
    expect(escapeFilterValue('alice.smith@corp')).toBe('alice.smith@corp');
  });
});

describe('mapGroupsToRoles', () => {
  it('maps a single group to its role', () => {
    const cfg: LdapConfig = {
      ...cfgBase,
      groupMappings: [{ group: 'cn=admins,ou=g,dc=corp', role: 'admin' }],
    };
    expect(mapGroupsToRoles(cfg, ['cn=admins,ou=g,dc=corp'])).toEqual(['admin']);
  });

  it('matches case-insensitively (DNs are case-insensitive per RFC)', () => {
    const cfg: LdapConfig = {
      ...cfgBase,
      groupMappings: [{ group: 'CN=Admins,OU=g,DC=corp', role: 'admin' }],
    };
    expect(mapGroupsToRoles(cfg, ['cn=admins,ou=g,dc=corp'])).toEqual(['admin']);
  });

  it('always assigns the "*" fallback role', () => {
    const cfg: LdapConfig = {
      ...cfgBase,
      groupMappings: [
        { group: 'cn=admins,ou=g,dc=corp', role: 'admin' },
        { group: '*', role: 'viewer' },
      ],
    };
    // user in no special groups still gets the fallback
    expect(mapGroupsToRoles(cfg, [])).toEqual(['viewer']);
    // user in the admin group gets both
    expect(mapGroupsToRoles(cfg, ['cn=admins,ou=g,dc=corp'])).toEqual(
      expect.arrayContaining(['admin', 'viewer']),
    );
  });

  it('unions multiple matching roles, deduplicating', () => {
    const cfg: LdapConfig = {
      ...cfgBase,
      groupMappings: [
        { group: 'cn=ops,ou=g,dc=corp', role: 'operator' },
        { group: 'cn=sre,ou=g,dc=corp', role: 'operator' }, // duplicate role
        { group: 'cn=eng,ou=g,dc=corp', role: 'viewer' },
      ],
    };
    const roles = mapGroupsToRoles(cfg, [
      'cn=ops,ou=g,dc=corp',
      'cn=sre,ou=g,dc=corp',
      'cn=eng,ou=g,dc=corp',
    ]);
    expect(roles.sort()).toEqual(['operator', 'viewer']);
  });

  it('returns empty when no mapping matches and no fallback exists', () => {
    const cfg: LdapConfig = {
      ...cfgBase,
      groupMappings: [{ group: 'cn=admins,ou=g,dc=corp', role: 'admin' }],
    };
    expect(mapGroupsToRoles(cfg, ['cn=other,ou=g,dc=corp'])).toEqual([]);
  });
});
