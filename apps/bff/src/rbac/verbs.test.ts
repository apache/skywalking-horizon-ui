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
import { SCOPE_VERBS } from '../oauth/scopes.js';
import { WILDCARD_EXEMPT_VERBS, hasVerb, resolveVerbsForRoles } from './verbs.js';
import { configSchema } from '../config/schema.js';
import { BUILTIN_ROLES, BUILTIN_LANDING_BY_ROLE } from '../config/builtin-roles.js';

describe('hasVerb', () => {
  it('grants everything for "*"', () => {
    expect(hasVerb(['*'], 'metrics:read')).toBe(true);
    expect(hasVerb(['*'], 'rule:write:structural')).toBe(true);
  });

  it('grants everything for the "admin" sentinel', () => {
    expect(hasVerb(['admin'], 'user:write')).toBe(true);
  });

  it('matches exact verbs', () => {
    expect(hasVerb(['alarms:read'], 'alarms:read')).toBe(true);
    expect(hasVerb(['alarms:read'], 'alarms:write')).toBe(false);
  });

  it('area:* grants every action in that area, including sub-actions', () => {
    expect(hasVerb(['rule:*'], 'rule:read')).toBe(true);
    expect(hasVerb(['rule:*'], 'rule:write')).toBe(true);
    expect(hasVerb(['rule:*'], 'rule:write:structural')).toBe(true);
    expect(hasVerb(['rule:*'], 'rule:delete')).toBe(true);
    expect(hasVerb(['rule:*'], 'alarm-rule:read')).toBe(false);
  });

  it('*:read grants read in every area', () => {
    expect(hasVerb(['*:read'], 'alarms:read')).toBe(true);
    expect(hasVerb(['*:read'], 'metrics:read')).toBe(true);
    expect(hasVerb(['*:read'], 'rule:read')).toBe(true);
    expect(hasVerb(['*:read'], 'rule:write')).toBe(false);
  });

  it('two-segment grants do NOT imply three-segment sub-actions', () => {
    // operator must list `rule:write:structural` explicitly to gate
    // schema-breaking edits; plain `rule:write` shouldn't cover it.
    expect(hasVerb(['rule:write'], 'rule:write:structural')).toBe(false);
    expect(hasVerb(['rule:write', 'rule:write:structural'], 'rule:write:structural')).toBe(true);
  });

  it('returns false for empty grants', () => {
    expect(hasVerb([], 'metrics:read')).toBe(false);
  });
});

describe('resolveVerbsForRoles', () => {
  const policy = {
    viewer: ['*:read'],
    maintainer: ['*:read'],
    operator: ['*:read', 'rule:write', 'profile:enable'],
    admin: ['*'],
  };

  it('returns ["*"] when rbac is disabled — even for unknown roles', () => {
    expect(resolveVerbsForRoles(policy, ['nobody'], false)).toEqual(['*']);
  });

  it('unions verbs across multiple roles', () => {
    const verbs = resolveVerbsForRoles(policy, ['viewer', 'operator'], true);
    expect(verbs).toContain('*:read');
    expect(verbs).toContain('rule:write');
    expect(verbs).toContain('profile:enable');
  });

  it('ignores roles not in the policy table', () => {
    expect(resolveVerbsForRoles(policy, ['operator', 'unknown-role'], true)).toEqual(
      expect.arrayContaining(['*:read', 'rule:write', 'profile:enable']),
    );
  });
});

describe('retired verbs still granted by an upgraded horizon.yaml', () => {
  const R = (grants: string[]): string[] =>
    resolveVerbsForRoles({ r: grants }, ['r'], true).sort();

  it('expands the exact retired names', () => {
    expect(R(['dashboard:read'])).toContain('layer-template:read');
    expect(R(['dashboard:write'])).toContain('layer-template:write');
    // `overview:write` reached five of the six setup pages, so it expands to
    // both halves of each — whoever could edit them could read them.
    const ov = R(['overview:write']);
    for (const v of [
      'overview-template:read', 'overview-template:write',
      'translation:read', 'translation:write',
      'alarm-setup:read', 'alarm-setup:write',
      'infra-3d-setup:read', 'infra-3d-setup:write',
      'setup:read', 'setup:write',
    ]) expect(ov, v).toContain(v);
  });

  it('expands a retired AREA wildcard, which would otherwise fail silently', () => {
    // Both areas still exist, so `overview:*` still parses and the boot warning
    // has nothing to report — it would simply stop granting the setup pages.
    expect(R(['dashboard:*'])).toContain('layer-template:write');
    expect(R(['overview:*'])).toContain('overview-template:write');
    expect(hasVerb(R(['overview:*']), 'setup:write')).toBe(true);
  });

  it('does not expand a live verb into template reads', () => {
    // `overview:read` survives as the RENDER verb. Expanding it would hand
    // every viewer the editor content the split exists to withhold.
    const v = R(['overview:read']);
    expect(hasVerb(v, 'overview-template:read')).toBe(false);
    expect(hasVerb(v, 'layer-template:read')).toBe(false);
  });

  it('a grant named after a prototype member grants nothing and does not throw', () => {
    // `in` / bare indexing would have found Object.prototype.toString here and
    // thrown `function is not iterable` inside the authorization path.
    for (const g of ['toString', 'constructor', 'hasOwnProperty', 'valueOf']) {
      expect(() => R([g])).not.toThrow();
      expect(R([g])).toEqual([g]);
    }
  });
});

describe('builtinRoles: how a configured block meets the built-ins', () => {
  const parse = (rbac: object) => configSchema.parse({ rbac }).rbac;

  it('replaces by default — the block IS the role set', () => {
    expect(Object.keys(parse({ roles: { tv: ['setup:read'] } }).roles)).toEqual(['tv']);
  });

  it('keeps the built-ins and appends under `keep`', () => {
    const r = parse({ builtinRoles: 'keep', roles: { tv: ['setup:read'] } }).roles;
    expect(Object.keys(r)).toEqual(['viewer', 'maintainer', 'operator', 'admin', 'tv']);
    expect(r.viewer).toEqual(BUILTIN_ROLES.viewer);
  });

  it('a listed name overrides that ONE role, wholesale', () => {
    const r = parse({ builtinRoles: 'keep', roles: { operator: ['rule:read'] } }).roles;
    expect(r.operator).toEqual(['rule:read']);
    expect(r.viewer).toEqual(BUILTIN_ROLES.viewer);
  });

  it('merges landingByRole too, or a kept role has no landing route', () => {
    const l = parse({ builtinRoles: 'keep', roles: { tv: ['setup:read'] }, landingByRole: { tv: '/' } })
      .landingByRole;
    expect(l).toEqual({ ...BUILTIN_LANDING_BY_ROLE, tv: '/' });
  });

  it('a built-in cannot be dropped by omission under `keep` — grant it nothing instead', () => {
    const r = parse({ builtinRoles: 'keep', roles: { admin: [] } }).roles;
    expect(r.admin).toEqual([]);
    expect(hasVerb(resolveVerbsForRoles(r, ['admin'], true), 'user:read')).toBe(false);
  });

  it('never merges silently: the default must not hand back a role a deployment removed', () => {
    // `admin: ["*"]` is one of the roles `keep` restores. An upgrade that
    // flipped this default would widen access on its own.
    expect(parse({}).builtinRoles).toBe('replace');
    expect(Object.keys(parse({ roles: { onlyOne: ['metrics:read'] } }).roles)).not.toContain('admin');
  });
});

describe('wildcard-exempt verbs', () => {
  /**
   * The containment `audit:read` cannot get from the ordinary grammar.
   *
   * `*:read` is a documented role recipe AND the expansion of the default
   * OAuth scope, so without the exemption, enabling an optional audit log
   * would silently hand the full login history — usernames, verified email
   * addresses, source addresses, internal cluster addressing — to every
   * read-only MCP client and every reviewer role. The consent screen shows
   * that scope as the single line `*:read` and names none of it.
   */
  it('is not granted by *:read', () => {
    expect(hasVerb(['*:read'], 'audit:read')).toBe(false);
    // The neighbouring read verb is unaffected — this is one exemption, not a
    // change to how the grammar works.
    expect(hasVerb(['*:read'], 'auth:read')).toBe(true);
  });

  it('is not granted by an area wildcard either', () => {
    expect(hasVerb(['audit:*'], 'audit:read')).toBe(false);
  });

  it('is granted by the exact verb, by `*`, and by `admin`', () => {
    expect(hasVerb(['audit:read'], 'audit:read')).toBe(true);
    expect(hasVerb(['*'], 'audit:read')).toBe(true);
    expect(hasVerb(['admin'], 'audit:read')).toBe(true);
  });

  it('is not reachable through the default OAuth scope', () => {
    // `SCOPE_VERBS['horizon:read']` is exactly `['*:read']`, so this is the
    // same assertion the consent screen depends on.
    expect(hasVerb(SCOPE_VERBS['horizon:read'], 'audit:read')).toBe(false);
    expect(hasVerb(SCOPE_VERBS['horizon:full'], 'audit:read')).toBe(true);
  });

  it('keeps the exempt set small — every entry is a place the grammar stops being uniform', () => {
    expect([...WILDCARD_EXEMPT_VERBS]).toEqual(['audit:read']);
  });
});
