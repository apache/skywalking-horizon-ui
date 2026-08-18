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
 * API tokens — the credential for callers with no browser: scripts, CI, and
 * MCP clients. A token resolves to the same `{username, roles}` a login does,
 * so it works on every route under the existing verb policy; it is not an
 * MCP-specific or route-scoped credential.
 *
 * Three decisions worth knowing:
 *
 *  - **A token names a USER, never a role set.** Roles resolve from that user
 *    on every request, so a token cannot be minted carrying more than its
 *    owner holds, and removing the user revokes it without touching the file.
 *    An entry MAY carry a `roles` cap, which is intersected with the live
 *    roles — least privilege for a CI credential, and still never a grant.
 *  - **SHA-256, not argon2**, though passwords here are argon2. Argon2 is
 *    deliberately slow to resist brute-forcing *guessable* secrets; a 32-byte
 *    random token is not guessable, so the slowness would only add ~50-100ms
 *    to every request.
 *  - **Re-read on a TTL, never watched.** Kubernetes replaces a mounted Secret
 *    by swapping a `..data` symlink, so a watcher on the file path watches an
 *    inode that gets unlinked and commonly misses the update *silently* — and
 *    a missed update means a revoked token keeps working. A TTL turns
 *    revocation latency into a bounded, documented number instead.
 */

import { readFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { ConfigSource } from '../config/loader.js';
import { RoleResolver } from './roles.js';
import { logger } from '../logger.js';

/** `hzn_<id>_<secret>`. The id is carried in the token so verification is one
 *  lookup and one comparison, rather than hashing against every row. */
const TOKEN_PREFIX = 'hzn_';
const RELOAD_MS = 30_000;
/** How long a transient read failure may keep serving the last good file.
 *  Long enough to ride out a slow or contended mount, short enough that a
 *  permanently broken one stops authenticating rather than never expiring. */
const STALE_GRACE_MS = 5 * 60_000;

export interface TokenEntry {
  id: string;
  username: string;
  /** `sha256:<hex>` of the secret half. */
  hash: string;
  label?: string;
  /** Optional least-privilege CAP. When present the token holds the
   *  INTERSECTION of this list and the user's live roles — so it can narrow a
   *  credential (a CI token that only reads) but never widen one. Absent means
   *  "whatever the user holds". */
  roles?: string[];
  created?: string;
  /** ISO date; the token is refused from this instant. */
  expires?: string;
}

export interface TokenIdentity {
  username: string;
  roles: string[];
  tokenId: string;
  label?: string;
}

export function hashTokenSecret(secret: string): string {
  return `sha256:${createHash('sha256').update(secret, 'utf8').digest('hex')}`;
}

/** Split `hzn_<id>_<secret>`. The secret may itself contain `_`, so this reads
 *  the id up to the FIRST separator and treats everything after it as secret. */
export function parseToken(raw: string): { id: string; secret: string } | null {
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  const rest = raw.slice(TOKEN_PREFIX.length);
  const sep = rest.indexOf('_');
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { id: rest.slice(0, sep), secret: rest.slice(sep + 1) };
}

function secretMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself leak length.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isExpired(entry: TokenEntry, now: number): boolean {
  if (!entry.expires) return false;
  const at = Date.parse(entry.expires);
  // An unparseable date ("2026-11-31", "90d") must NOT mean "never expires":
  // failing open on a credential's lifetime is the wrong direction to be wrong.
  if (!Number.isFinite(at)) return true;
  return at <= now;
}

/** Reads and caches the token file, and resolves a bearer value to an identity.
 *  Constructed once and shared; every read is cache-backed. */
export class TokenStore {
  private entries = new Map<string, TokenEntry>();
  private loadedAt = 0;
  /** When the file last read successfully — the clock the grace window uses. */
  private goodAt = 0;
  private loadedPath = '';
  private inflight: Promise<void> | null = null;
  private readonly roles: RoleResolver;

  constructor(private readonly config: ConfigSource) {
    this.roles = new RoleResolver(config);
  }

  private get path(): string {
    return this.config.current.auth.tokensFile;
  }

  private async load(): Promise<void> {
    const path = this.path;
    const fresh = Date.now() - this.loadedAt < RELOAD_MS && path === this.loadedPath;
    if (fresh) return;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const next = new Map<string, TokenEntry>();
      if (path) {
        try {
          const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
          if (!Array.isArray(parsed)) throw new Error('expected a JSON array of token entries');
          for (const raw of parsed) {
            const e = raw as Partial<TokenEntry>;
            if (!e || typeof e.id !== 'string' || typeof e.username !== 'string' || typeof e.hash !== 'string') {
              logger.warn({ path }, 'auth.tokensFile: skipping an entry missing id / username / hash');
              continue;
            }
            if (e.roles !== undefined && (!Array.isArray(e.roles) || e.roles.some((r) => typeof r !== 'string'))) {
              // A bare string would make `includes` a substring match, so a cap
              // of "viewer" would also admit a role named "view".
              logger.warn({ path, id: e.id }, 'auth.tokensFile: skipping an entry whose roles cap is not an array of strings');
              continue;
            }
            next.set(e.id, e as TokenEntry);
          }
        } catch (err) {
          const missing = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
          const staleFor = Date.now() - this.goodAt;
          // A file that is GONE is a deletion or a lost mount, not a hiccup —
          // keeping its tokens alive would make them unrevokable for the life
          // of the process. Other errors (EACCES, a torn read mid-rotation)
          // may be transient, so the last good file is served for a bounded
          // grace window and then dropped. Never indefinitely.
          if (missing || staleFor > STALE_GRACE_MS) {
            logger.error(
              { path, err: err instanceof Error ? err.message : String(err), missing, staleForMs: staleFor },
              missing
                ? 'auth.tokensFile is gone — refusing every API token until it returns'
                : 'auth.tokensFile unreadable for longer than the grace window — refusing every API token',
            );
            this.entries = new Map();
          } else {
            logger.warn(
              { path, err: err instanceof Error ? err.message : String(err), staleForMs: staleFor },
              'auth.tokensFile unreadable — serving the last good copy for now',
            );
          }
          // Record the path too, or the freshness check never holds and every
          // subsequent request re-reads the same broken file and re-logs.
          this.loadedPath = path;
          this.loadedAt = Date.now();
          this.inflight = null;
          return;
        }
      }
      this.entries = next;
      this.loadedPath = path;
      this.loadedAt = Date.now();
      this.goodAt = this.loadedAt;
      this.inflight = null;
    })();
    return this.inflight;
  }

  /** Resolve an `Authorization` header value. Returns null for anything that
   *  is not a valid, unexpired token belonging to a user who still has roles. */
  async resolve(authorization: string | undefined): Promise<TokenIdentity | null> {
    if (!this.path) return null;
    // RFC 7235 makes the scheme case-insensitive, and clients do send `bearer`.
    if (!authorization || authorization.slice(0, 7).toLowerCase() !== 'bearer ') return null;
    const parsed = parseToken(authorization.slice(7).trim());
    if (!parsed) return null;
    await this.load();
    const entry = this.entries.get(parsed.id);
    if (!entry) return null;
    if (isExpired(entry, Date.now())) return null;
    if (!secretMatches(entry.hash, hashTokenSecret(parsed.secret))) return null;
    // Existence first, and independently of roles. With `rbac.enabled: false`
    // every role list is empty yet every session holds `*`, so an empty list
    // says nothing about whether the account still exists — and a DELETED
    // user's token would otherwise keep working with full authority, while the
    // same person could no longer log in through the browser at all.
    if (!(await this.roles.knows(entry.username))) return null;
    const live = await this.roles.rolesFor(entry.username);
    // Intersect, never union: a cap in the file can narrow the credential but
    // must not grant a role the user does not currently hold.
    const roles = entry.roles ? live.filter((r) => entry.roles?.includes(r)) : live;
    // With RBAC off every session is granted `*`, so a role-less user signs in
    // fine in the browser. Refusing their token would make the two credentials
    // disagree about the same person.
    if (roles.length === 0 && this.config.current.rbac.enabled) return null;
    return { username: entry.username, roles, tokenId: entry.id, label: entry.label };
  }
}
