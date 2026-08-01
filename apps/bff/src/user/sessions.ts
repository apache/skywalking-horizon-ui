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

import { randomBytes } from 'node:crypto';

export interface Session {
  sid: string;
  username: string;
  roles: string[];
  createdAt: number;
  lastSeenAt: number;
}

export interface SessionStoreOptions {
  /** Pass a getter over the live config so a hot reload re-evaluates EVERY
   *  session — already-issued ones included — against the new TTL. The cookie's
   *  maxAge is stamped from the live config on each request, so a store holding
   *  a boot-time copy would disagree with the browser after a reload. A plain
   *  number pins the TTL for the store's lifetime (tests). */
  ttlMinutes: number | (() => number);
  reapIntervalMs?: number;
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly ttlMinutes: () => number;
  private readonly reaper: NodeJS.Timeout;

  constructor(opts: SessionStoreOptions) {
    const ttl = opts.ttlMinutes;
    this.ttlMinutes = typeof ttl === 'function' ? ttl : () => ttl;
    this.reaper = setInterval(() => this.reap(), opts.reapIntervalMs ?? 60_000);
    this.reaper.unref?.();
  }

  private get ttlMs(): number {
    return this.ttlMinutes() * 60_000;
  }

  create(username: string, roles: string[]): Session {
    const sid = randomBytes(32).toString('base64url');
    const now = Date.now();
    const session: Session = { sid, username, roles, createdAt: now, lastSeenAt: now };
    this.sessions.set(sid, session);
    return session;
  }

  touch(sid: string): Session | undefined {
    const session = this.sessions.get(sid);
    if (!session) return undefined;
    if (Date.now() - session.lastSeenAt > this.ttlMs) {
      this.sessions.delete(sid);
      return undefined;
    }
    session.lastSeenAt = Date.now();
    return session;
  }

  // Read-without-touch — used by route handlers that just need identity
  // and don't want to slide the TTL window. Returns `undefined` for
  // expired sessions.
  get(sid: string): Session | undefined {
    const session = this.sessions.get(sid);
    if (!session) return undefined;
    if (Date.now() - session.lastSeenAt > this.ttlMs) {
      this.sessions.delete(sid);
      return undefined;
    }
    return session;
  }

  destroy(sid: string): void {
    this.sessions.delete(sid);
  }

  size(): number {
    return this.sessions.size;
  }

  private reap(): void {
    const now = Date.now();
    const ttlMs = this.ttlMs;
    for (const [sid, s] of this.sessions) {
      if (now - s.lastSeenAt > ttlMs) this.sessions.delete(sid);
    }
  }

  async close(): Promise<void> {
    clearInterval(this.reaper);
    this.sessions.clear();
  }
}
