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

import { z } from 'zod';

const serverSchema = z
  .object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().positive().default(8081),
    staticDir: z.string().optional(),
  })
  .strict();

const oapSchema = z
  .object({
    /** OAP query host (GraphQL + `/status/*`). Single URL — query traffic
     *  is load-balanceable, any OAP node can answer. */
    queryUrl: z.string().url().default('http://127.0.0.1:12800'),
    /** OAP admin host (runtime rule mgmt, DSL/MQE/OAL, inspect, live
     *  debug). Single URL. Most endpoints get a single fire (OAP routes
     *  cluster-internal); live-debug status performs a DNS lookup on
     *  the hostname to discover all node IPs and probes each. */
    adminUrl: z.string().url().default('http://127.0.0.1:17128'),
    timeoutMs: z.number().int().positive().default(15000),
    auth: z
      .object({
        username: z.string().min(1),
        password: z.string().min(1),
      })
      .strict()
      .optional(),
    mqe: z
      .object({
        host: z.string().optional(),
        port: z.number().int().positive().optional(),
      })
      .strict()
      .default({}),
    zipkinUrl: z.string().url().default('http://127.0.0.1:9412/zipkin'),
  })
  .strict();

const localUserSchema = z
  .object({
    username: z.string().min(1),
    passwordHash: z.string().min(1),
    roles: z.array(z.string().min(1)).default([]),
  })
  .strict();

const ldapGroupMappingSchema = z
  .object({
    /** LDAP group DN (or the literal "*" to match any authenticated user). */
    group: z.string().min(1),
    /** Horizon role assigned when the user's group memberships include `group`. */
    role: z.string().min(1),
  })
  .strict();

const ldapSchema = z
  .object({
    /** Directory URL, e.g. `ldaps://ldap.corp:636` or `ldap://localhost:389`. */
    url: z.string().min(1),
    /** Optional service-account DN used for user/group searches.
     *  When empty, an anonymous bind is attempted for searches. */
    bindDn: z.string().default(''),
    /** Service-account password. Supports `${VAR:default}` interpolation
     *  in the YAML; empty means anonymous search. */
    bindPassword: z.string().default(''),
    /** Base DN under which user entries live (e.g. `ou=people,dc=corp`). */
    userBaseDn: z.string().min(1),
    /** Search filter; `{username}` is substituted with the typed username,
     *  escaped per RFC 4515. Default targets the common `uid` attribute. */
    userFilter: z.string().default('(uid={username})'),
    /** Attribute on the user entry that holds the display name. */
    displayNameAttr: z.string().default('cn'),
    /** Group membership strategy:
     *  - `memberOf`  → read the user entry's `memberOf` attribute (AD-style).
     *  - `search`    → search `groupBaseDn` for groups whose `memberAttr`
     *                   contains the user's DN (OpenLDAP-style). */
    groupStrategy: z.enum(['memberOf', 'search']).default('memberOf'),
    /** Base DN under which group entries live. Only used when
     *  `groupStrategy: 'search'`. */
    groupBaseDn: z.string().default(''),
    /** Group attribute that lists members (e.g. `member`, `uniqueMember`).
     *  Only used when `groupStrategy: 'search'`. */
    memberAttr: z.string().default('member'),
    /** Group DN → Horizon role bindings. First match wins; `"*"` matches
     *  every authenticated user. Order matters — put the highest-privilege
     *  rule first if you only want one role per user, or use multiple
     *  entries to assign multiple roles. */
    groupMappings: z.array(ldapGroupMappingSchema).default([]),
    /** Bind / search timeout in ms. */
    timeoutMs: z.number().int().positive().default(5000),
    /** When `true`, skip TLS certificate validation. Use only for dev
     *  directories with self-signed certs; never in production. */
    tlsInsecure: z.boolean().default(false),
  })
  .strict();

const breakGlassSchema = z
  .object({
    /** Username allowed to log in via break-glass. When unset, break-glass
     *  is disabled. */
    username: z.string().min(1),
    /** Argon2id hash of the break-glass password (use `pnpm --filter bff cli:hash`). */
    passwordHash: z.string().min(1),
    /** Roles granted when the break-glass session is established.
     *  Defaults to `['admin']` since the whole point of break-glass is
     *  recovering from a broken auth config. */
    roles: z.array(z.string().min(1)).default(['admin']),
  })
  .strict();

const authSchema = z
  .object({
    /** Active auth backend. Switching to `ldap` causes `auth.local` to be
     *  ignored (a warning is logged at startup if both are populated). */
    backend: z.enum(['local', 'ldap']).default('local'),
    local: z
      .object({
        users: z.array(localUserSchema).default([]),
      })
      .strict()
      .default({ users: [] }),
    ldap: ldapSchema.optional(),
    /** Optional break-glass account, only honored when `backend: 'ldap'`
     *  AND the LDAP probe is currently failing. Logged loudly in the
     *  audit file on every use. */
    breakGlass: breakGlassSchema.optional(),
  })
  .strict()
  .default({ backend: 'local', local: { users: [] } });

const rbacSchema = z
  .object({
    /** When false, every authenticated session is granted `*`. */
    enabled: z.boolean().default(true),
    roles: z
      .record(z.string(), z.array(z.string().min(1)))
      .default({
        // Data catalog only — public dashboards, alarms, traces, logs,
        // topology, profiling results. Deliberately NOT `*:read` so a
        // viewer can't accidentally see rule definitions, live-debug
        // sessions, setup screens, or platform internals.
        viewer: [
          'metrics:read',
          'alarms:read',
          'traces:read',
          'logs:read',
          'topology:read',
          'profile:read',
        ],
        // Viewer baseline plus the platform-monitoring reads (cluster
        // health + OAP internals). Maintainer's whole job is watching
        // SkyWalking itself.
        maintainer: [
          'metrics:read',
          'alarms:read',
          'traces:read',
          'logs:read',
          'topology:read',
          'profile:read',
          'cluster:read',
          'inspect:read',
        ],
        // Configures observability: dashboards, alarm rules, DSL/OAL,
        // diagnostics. Inherits viewer + platform reads so operators
        // can verify their changes against live data.
        operator: [
          'metrics:read',
          'alarms:read',
          'traces:read',
          'logs:read',
          'topology:read',
          'profile:read',
          'cluster:read',
          'inspect:read',
          'overview:read',
          'overview:write',
          'setup:read',
          'setup:write',
          'dashboard:read',
          'dashboard:write',
          'alarm-setup:read',
          'alarm-setup:write',
          'alarm-rule:read',
          'alarm-rule:write',
          'rule:read',
          'rule:write',
          'rule:write:structural',
          'rule:delete',
          'rule:debug',
          'live-debug:read',
          'live-debug:write',
          'profile:enable',
        ],
        admin: ['*'],
      }),
    /** Landing route per role; the UI uses this to send users to the
     *  page that fits their job after login. */
    landingByRole: z
      .record(z.string(), z.string())
      .default({
        viewer: '/',
        maintainer: '/admin/cluster',
        operator: '/',
        admin: '/admin/cluster',
      }),
  })
  .strict()
  .default({});

const sessionSchema = z
  .object({
    ttlMinutes: z.number().int().positive().default(60),
    cookieName: z.string().default('horizon_sid'),
    cookieSecure: z.boolean().default(false),
  })
  .strict()
  .default({ ttlMinutes: 60, cookieName: 'horizon_sid', cookieSecure: false });

const auditSchema = z
  .object({
    file: z.string().default('./horizon-audit.jsonl'),
  })
  .strict()
  .default({ file: './horizon-audit.jsonl' });

const setupSchema = z
  .object({
    file: z.string().default('./horizon-setup.json'),
  })
  .strict()
  .default({ file: './horizon-setup.json' });

const alarmsSchema = z
  .object({
    file: z.string().default('./horizon-alarms.json'),
  })
  .strict()
  .default({ file: './horizon-alarms.json' });

const debugLogSchema = z
  .object({
    enabled: z.boolean().default(false),
    file: z.string().default('./horizon-wire.jsonl'),
    maxBodyChars: z.number().int().nonnegative().default(8192),
    redactAuthHeaders: z.boolean().default(true),
  })
  .strict()
  .default({
    enabled: false,
    file: './horizon-wire.jsonl',
    maxBodyChars: 8192,
    redactAuthHeaders: true,
  });

export const configSchema = z
  .object({
    server: serverSchema.default({}),
    oap: oapSchema.default({}),
    auth: authSchema,
    rbac: rbacSchema,
    session: sessionSchema,
    audit: auditSchema,
    setup: setupSchema,
    alarms: alarmsSchema,
    debugLog: debugLogSchema,
  })
  .strict();

export type HorizonConfig = z.infer<typeof configSchema>;
export type LdapConfig = z.infer<typeof ldapSchema>;
export type LocalUser = z.infer<typeof localUserSchema>;
export type BreakGlassConfig = z.infer<typeof breakGlassSchema>;
