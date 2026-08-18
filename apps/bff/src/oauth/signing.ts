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
 * Every value this authorization server hands out is a signed blob, and that is
 * a constraint rather than a preference: **Horizon has no writable persistent
 * store.** Sessions are an in-memory map, and the only thing it persists is
 * templates into OAP's `ui_template` store, which is no place for credentials.
 *
 * So a registered client, an authorization code, an access token and a refresh
 * token are all `<type>_<payload>.<hmac>` — self-describing, verified by
 * recomputing a signature rather than by looking anything up. Nothing to
 * migrate, nothing to replicate, and any replica can verify what any other
 * issued as long as they share `oauth.signingKey`.
 *
 * What that costs, stated plainly: **an issued access token cannot be revoked
 * before it expires.** Three things bound the damage — access tokens are
 * short-lived (an hour by default), roles are re-resolved from the auth backend
 * on every single request (so removing the user stops it immediately), and
 * rotating `oauth.signingKey` invalidates every outstanding token at once.
 */

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

/** Distinct per value type so a token can never be replayed as a code, or a
 *  code as a client registration — the type is inside the signed material. */
export type SignedKind = 'client' | 'code' | 'access' | 'refresh' | 'request';

export interface SignedEnvelope<T> {
  kind: SignedKind;
  /** Epoch ms. Absent for a client registration, which does not expire. */
  exp?: number;
  data: T;
}

const b64u = (b: Buffer): string => b.toString('base64url');

function mac(key: string, payload: string): string {
  return b64u(createHmac('sha256', key).update(payload, 'utf8').digest());
}

export function sign<T>(key: string, kind: SignedKind, data: T, ttlMs?: number): string {
  const env: SignedEnvelope<T> = {
    kind,
    ...(ttlMs === undefined ? {} : { exp: Date.now() + ttlMs }),
    data,
  };
  const payload = b64u(Buffer.from(JSON.stringify(env), 'utf8'));
  return `${payload}.${mac(key, payload)}`;
}

/**
 * Verify and unwrap. Returns null for anything that is not a well-formed,
 * correctly-signed, unexpired value of exactly `kind`.
 *
 * The signature is checked BEFORE the payload is parsed, so a forged blob never
 * reaches `JSON.parse` — and the comparison is constant-time, because an
 * attacker who can measure how far their guess matched can walk the MAC out one
 * byte at a time.
 */
export function verify<T>(key: string, kind: SignedKind, raw: string): T | null {
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const given = Buffer.from(raw.slice(dot + 1), 'utf8');
  const want = Buffer.from(mac(key, payload), 'utf8');
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  let env: SignedEnvelope<T>;
  try {
    env = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SignedEnvelope<T>;
  } catch {
    return null;
  }
  if (env.kind !== kind) return null;
  if (env.exp !== undefined && env.exp <= Date.now()) return null;
  return env.data;
}

/** A per-value random id. Carried in codes and tokens so a log line can name
 *  the exact credential without the credential itself appearing in a log. */
export function newId(): string {
  return randomBytes(9).toString('base64url');
}
