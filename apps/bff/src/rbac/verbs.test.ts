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
