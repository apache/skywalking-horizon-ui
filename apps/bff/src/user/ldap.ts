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
 * LDAP backend. The directory is treated as read-only:
 *
 *   1. Service-bind (or anonymous-bind) to search for the user's DN.
 *   2. Bind as the user with the typed password — this IS the password
 *      verification. The directory does the hash-and-compare server-side
 *      and we only see success/failure. The user-typed password is held
 *      in memory only for the duration of the bind attempt.
 *   3. Resolve group memberships either via `memberOf` on the user entry
 *      (AD-style) or via a group search (OpenLDAP-style).
 *   4. Map groups → Horizon roles using `auth.ldap.groupMappings`.
 *
 * Horizon never stores LDAP passwords, never writes to the directory,
 * never sets the `userPassword` / `unicodePwd` attribute.
 */

import { Client, type SearchOptions } from 'ldapts';
import type { LdapConfig } from '../config/schema.js';
import { logger } from '../logger.js';
import type { VerifiedUser } from './local.js';

/** Escape a value for an LDAP filter per RFC 4515. */
export function escapeFilterValue(input: string): string {
  let out = '';
  for (const ch of input) {
    switch (ch) {
      case '\\': out += '\\5c'; break;
      case '*':  out += '\\2a'; break;
      case '(':  out += '\\28'; break;
      case ')':  out += '\\29'; break;
      case '\0': out += '\\00'; break;
      default:   out += ch;
    }
  }
  return out;
}

function clientFor(cfg: LdapConfig): Client {
  return new Client({
    url: cfg.url,
    timeout: cfg.timeoutMs,
    connectTimeout: cfg.timeoutMs,
    tlsOptions: cfg.tlsInsecure ? { rejectUnauthorized: false } : undefined,
  });
}

async function safeUnbind(client: Client): Promise<void> {
  try {
    await client.unbind();
  } catch {
    /* close-on-best-effort */
  }
}

interface FoundUser {
  dn: string;
  displayName: string;
  memberOfFromEntry: string[];
}

async function searchUser(client: Client, cfg: LdapConfig, username: string): Promise<FoundUser | null> {
  const filter = cfg.userFilter.replaceAll('{username}', escapeFilterValue(username));
  const attrs = ['dn', cfg.displayNameAttr];
  if (cfg.groupStrategy === 'memberOf') attrs.push('memberOf');
  const opts: SearchOptions = {
    scope: 'sub',
    filter,
    attributes: attrs,
    sizeLimit: 2,
    timeLimit: Math.ceil(cfg.timeoutMs / 1000),
  };
  const { searchEntries } = await client.search(cfg.userBaseDn, opts);
  if (searchEntries.length === 0) return null;
  if (searchEntries.length > 1) {
    logger.warn(
      { username, count: searchEntries.length },
      'ldap user search returned multiple entries; using first',
    );
  }
  const e = searchEntries[0];
  const displayName = typeof e[cfg.displayNameAttr] === 'string'
    ? (e[cfg.displayNameAttr] as string)
    : Array.isArray(e[cfg.displayNameAttr])
      ? ((e[cfg.displayNameAttr] as unknown[])[0] as string) ?? String(e.dn)
      : String(e.dn);
  const memberOfRaw = e.memberOf;
  const memberOf = Array.isArray(memberOfRaw)
    ? (memberOfRaw as unknown[]).map(String)
    : typeof memberOfRaw === 'string'
      ? [memberOfRaw]
      : [];
  return { dn: String(e.dn), displayName, memberOfFromEntry: memberOf };
}

async function searchGroupsByMember(client: Client, cfg: LdapConfig, userDn: string): Promise<string[]> {
  if (!cfg.groupBaseDn) return [];
  const filter = `(${cfg.memberAttr}=${escapeFilterValue(userDn)})`;
  const opts: SearchOptions = {
    scope: 'sub',
    filter,
    attributes: ['dn'],
    sizeLimit: 256,
    timeLimit: Math.ceil(cfg.timeoutMs / 1000),
  };
  const { searchEntries } = await client.search(cfg.groupBaseDn, opts);
  return searchEntries.map((e) => String(e.dn));
}

export function mapGroupsToRoles(cfg: LdapConfig, groupDns: readonly string[]): string[] {
  const set = new Set<string>();
  const groups = new Set(groupDns.map((g) => g.toLowerCase()));
  for (const mapping of cfg.groupMappings) {
    if (mapping.group === '*') {
      set.add(mapping.role);
    } else if (groups.has(mapping.group.toLowerCase())) {
      set.add(mapping.role);
    }
  }
  return [...set];
}

export interface LdapVerified extends VerifiedUser {
  displayName: string;
  dn: string;
  groups: string[];
}

/**
 * Verify a username/password pair against LDAP and resolve the user's
 * Horizon roles. Returns null on any failure (bad credentials, no user
 * entry, no matching role mapping). The reason is logged but never sent
 * to the client — same posture as the local verifier.
 */
export async function verifyLdapCredentials(
  cfg: LdapConfig,
  username: string,
  password: string,
): Promise<LdapVerified | null> {
  const searchClient = clientFor(cfg);
  let user: FoundUser | null = null;
  try {
    if (cfg.bindDn) {
      await searchClient.bind(cfg.bindDn, cfg.bindPassword);
    }
    user = await searchUser(searchClient, cfg, username);
  } catch (err) {
    logger.warn({ err: errMsg(err), username }, 'ldap user search failed');
    await safeUnbind(searchClient);
    return null;
  }
  await safeUnbind(searchClient);
  if (!user) return null;

  // The actual password check — bind as the user.
  const userClient = clientFor(cfg);
  try {
    await userClient.bind(user.dn, password);
  } catch {
    // Wrong password / locked account / disabled user → bind 49.
    await safeUnbind(userClient);
    return null;
  }

  // Resolve group memberships using the credentials we already have.
  let groups: string[] = [];
  try {
    if (cfg.groupStrategy === 'memberOf') {
      groups = user.memberOfFromEntry;
    } else {
      groups = await searchGroupsByMember(userClient, cfg, user.dn);
    }
  } catch (err) {
    logger.warn({ err: errMsg(err), dn: user.dn }, 'ldap group resolution failed');
    groups = [];
  }
  await safeUnbind(userClient);

  const roles = mapGroupsToRoles(cfg, groups);
  if (roles.length === 0) {
    logger.warn(
      { username, groups },
      'ldap user authenticated but matched zero group mappings; rejecting login',
    );
    return null;
  }
  return {
    username,
    displayName: user.displayName,
    dn: user.dn,
    groups,
    roles,
  };
}

export interface LdapProbeResult {
  reachable: boolean;
  serviceBindOk: boolean | null;
  userSearchOk: boolean | null;
  /** Number of user entries visible under `userBaseDn` (capped at the sizeLimit). */
  userEntriesVisible: number | null;
  latencyMs: number | null;
  error?: string;
}

/**
 * Diagnostic probe used by the Auth Status admin page. Tries the
 * service bind and a tiny user-base search, returning a structured
 * result instead of throwing. Never leaks the bind password.
 */
export async function probeLdap(cfg: LdapConfig): Promise<LdapProbeResult> {
  const start = Date.now();
  const client = clientFor(cfg);
  const result: LdapProbeResult = {
    reachable: false,
    serviceBindOk: null,
    userSearchOk: null,
    userEntriesVisible: null,
    latencyMs: null,
  };
  try {
    if (cfg.bindDn) {
      await client.bind(cfg.bindDn, cfg.bindPassword);
      result.reachable = true;
      result.serviceBindOk = true;
    } else {
      // Anonymous: connect-only check via a no-op search at the base.
      result.reachable = true;
      result.serviceBindOk = null;
    }
    try {
      const { searchEntries } = await client.search(cfg.userBaseDn, {
        scope: 'one',
        filter: '(objectClass=*)',
        attributes: ['dn'],
        sizeLimit: 10,
        timeLimit: Math.ceil(cfg.timeoutMs / 1000),
      });
      result.userSearchOk = true;
      result.userEntriesVisible = searchEntries.length;
    } catch (err) {
      result.userSearchOk = false;
      result.error = errMsg(err);
    }
  } catch (err) {
    result.reachable = false;
    result.serviceBindOk = cfg.bindDn ? false : null;
    result.error = errMsg(err);
  } finally {
    result.latencyMs = Date.now() - start;
    await safeUnbind(client);
  }
  return result;
}

/**
 * Resolve a sample username to the groups + roles that login would
 * assign, without actually authenticating. Drives the Auth Status
 * "test a username" affordance so operators can debug group mappings
 * without the user being present.
 */
export interface LdapResolveResult {
  found: boolean;
  dn: string | null;
  groups: string[];
  roles: string[];
  error?: string;
}

export async function resolveLdapUser(
  cfg: LdapConfig,
  username: string,
): Promise<LdapResolveResult> {
  const client = clientFor(cfg);
  try {
    if (cfg.bindDn) await client.bind(cfg.bindDn, cfg.bindPassword);
    const user = await searchUser(client, cfg, username);
    if (!user) {
      await safeUnbind(client);
      return { found: false, dn: null, groups: [], roles: [] };
    }
    let groups = user.memberOfFromEntry;
    if (cfg.groupStrategy === 'search') {
      groups = await searchGroupsByMember(client, cfg, user.dn);
    }
    await safeUnbind(client);
    return {
      found: true,
      dn: user.dn,
      groups,
      roles: mapGroupsToRoles(cfg, groups),
    };
  } catch (err) {
    await safeUnbind(client);
    return { found: false, dn: null, groups: [], roles: [], error: errMsg(err) };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
