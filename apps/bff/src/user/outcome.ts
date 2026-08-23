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
 * What a credential resolver returns, and why a refusal happened.
 *
 * The resolvers used to answer identity-or-null, which cannot tell a caller
 * whether a directory was down or a password was wrong — and the audit log
 * needs that distinction, because exactly two refusals are recordable and the
 * rest are log-only.
 */

import type { AuditReason } from '../store/audit/types.js';

/**
 * Every distinguishable authentication failure. Most never reach the audit
 * table; they are what the log line is built from.
 */
export type AuthFailureReason =
  | AuditReason
  | 'invalid_credentials'
  | 'backend_unreachable'
  | 'state_mismatch'
  | 'login_expired'
  | 'no_code'
  | 'unknown_provider'
  | 'no_email'
  | 'email_not_verified'
  | 'domain_not_allowed'
  | 'provider_error'
  | 'expired'
  | 'unknown_user'
  | 'invalid_token';

/**
 * THREE variants, not two.
 *
 * The middle one exists because `no_roles` and `zero_group_mappings` are
 * refusals that must persist the VERIFIED principal — a failure branch
 * carrying only a reason cannot express the two cases the audit table exists
 * to record.
 *
 * The third subtracts those reasons rather than repeating the whole union.
 * Typed as the full `AuthFailureReason` it would still admit
 * `{ ok: false, reason: 'no_roles' }` with no identity: exactly the shape the
 * middle branch prevents, reachable through the door beside it.
 */
export type Verified<T> =
  | { ok: true; identity: T }
  | { ok: false; reason: AuditReason; identity: T }
  | { ok: false; reason: Exclude<AuthFailureReason, AuditReason>; identity?: never };

const PERSISTED: ReadonlySet<AuthFailureReason> = new Set<AuthFailureReason>([
  'no_roles',
  'zero_group_mappings',
]);

/** The only bridge between the two vocabularies. A call site that gets
 *  `undefined` writes a log line, not a row — so no site decides it ad hoc. */
export function auditReasonOf(reason: AuthFailureReason): AuditReason | undefined {
  return PERSISTED.has(reason) ? (reason as AuditReason) : undefined;
}

export function granted<T>(identity: T): Verified<T> {
  return { ok: true, identity };
}

/** A refusal by someone who never proved a credential. */
export function refused<T>(reason: Exclude<AuthFailureReason, AuditReason>): Verified<T> {
  return { ok: false, reason };
}

/** A refusal AFTER authentication succeeded — the only kind that is recorded,
 *  and the only one that carries who it was about. */
export function refusedOnPolicy<T>(reason: AuditReason, identity: T): Verified<T> {
  return { ok: false, reason, identity };
}
