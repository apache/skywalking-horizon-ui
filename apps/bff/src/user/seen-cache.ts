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
 * In-memory record of every user that has successfully logged in this
 * BFF instance. Drives the admin Users page when the backend is LDAP
 * (we can't enumerate the directory; we surface who we've actually
 * seen). Local users always appear in the listing even before they
 * log in — those rows come from the static YAML, not from this cache.
 *
 * Cache is process-local; restarting the BFF clears it. That's fine —
 * the next login refreshes each user's row. No file persistence.
 */

export type SeenSource = 'local' | 'ldap' | 'break-glass';

export interface SeenUser {
  username: string;
  source: SeenSource;
  roles: string[];
  lastSeenAt: number;
  lastIp: string | null;
}

export class UserSeenCache {
  private readonly users = new Map<string, SeenUser>();

  record(u: { username: string; source: SeenSource; roles: string[]; ip?: string | null }): void {
    this.users.set(u.username, {
      username: u.username,
      source: u.source,
      roles: u.roles,
      lastSeenAt: Date.now(),
      lastIp: u.ip ?? null,
    });
  }

  list(): SeenUser[] {
    return [...this.users.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  get(username: string): SeenUser | undefined {
    return this.users.get(username);
  }

  size(): number {
    return this.users.size;
  }

  clear(): void {
    this.users.clear();
  }
}
