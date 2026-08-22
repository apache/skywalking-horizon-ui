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

import { describe, it, expect } from 'vitest';
import { auditReasonOf, granted, refused, refusedOnPolicy, type AuthFailureReason } from './outcome.js';

describe('the persisted-reason bridge', () => {
  /**
   * The rule the whole valid-credential-only policy rests on: exactly two
   * refusals are recordable, and both are reachable ONLY after a credential
   * was proved. Everything else is log-only, which is what keeps the audit
   * table unreachable by a caller holding nothing.
   */
  it('bridges only the two refusals a valid credential can produce', () => {
    expect(auditReasonOf('no_roles')).toBe('no_roles');
    expect(auditReasonOf('zero_group_mappings')).toBe('zero_group_mappings');
  });

  it('refuses to bridge anything an anonymous caller can trigger', () => {
    const anonymous: AuthFailureReason[] = [
      'invalid_credentials', 'backend_unreachable', 'state_mismatch', 'login_expired',
      'no_code', 'unknown_provider', 'no_email', 'email_not_verified',
      'domain_not_allowed', 'provider_error', 'expired', 'unknown_user', 'invalid_token',
    ];
    for (const reason of anonymous) expect(auditReasonOf(reason)).toBeUndefined();
  });
});

describe('the three variants', () => {
  it('carries the identity on success', () => {
    const r = granted({ username: 'alice' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity.username).toBe('alice');
  });

  /** A policy refusal must keep the principal, or the row it produces has
   *  nobody to be about. */
  it('carries the identity on a post-authentication policy refusal', () => {
    const r = refusedOnPolicy('zero_group_mappings', { username: 'alice' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('zero_group_mappings');
      expect(r.identity?.username).toBe('alice');
    }
  });

  it('carries no identity when nobody was ever authenticated', () => {
    const r = refused<{ username: string }>('invalid_credentials');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.identity).toBeUndefined();
  });

  /**
   * A compile-time guarantee, asserted here so its removal is visible: the
   * anonymous branch subtracts the persisted reasons, so "a policy refusal
   * with no principal" — the exact shape the middle branch exists to prevent —
   * cannot be constructed through the door beside it.
   */
  it('cannot express a policy refusal without a principal', () => {
    // @ts-expect-error `no_roles` is excluded from the identity-less branch.
    const bad = refused<{ username: string }>('no_roles');
    expect(bad.ok).toBe(false);
  });
});
