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
 * The `audit` configuration block, in its own file because `schema.ts` is at
 * its documented comment budget and this block carries more prose than schema.
 *
 * It also earns the separation: unlike every other block here, the audit
 * config has RULES that deliberately cannot be zod refinements, and keeping
 * them beside the shapes they check makes that pairing obvious.
 */

import { z } from 'zod';
import { isLoopbackHostname } from '../util/loopback.js';

// Login audit — an optional, store-backed record of who signed in. OFF by
// default, and Postgres-or-nothing: there is deliberately no file backend,
// because a file per pod is the per-replica partial history that got the
// previous audit trail removed.
//
// This block validates SHAPES ONLY. It carries no `.refine()`, and that is a
// decision rather than an omission: the config loader treats a ZodError as
// fatal (`process.exit(1)`), so expressing "postgres selected but no url" as a
// refinement would let a mistyped OPTIONAL feature stop the whole console from
// booting. Those consistency rules live in `auditConfigProblem()` below, which
// the audit module consults at startup to log and stay off.
export const auditPostgresSchema = z
  .object({
    /** SECRET — env-only, never committed, and it needs its own entry in the
     *  logger's redact list. No existing wildcard covers a connection string. */
    url: z.string().default(''),
    /** CA bundle for a private issuer, for `sslmode=verify-full` against a
     *  cluster-internal Postgres. Empty uses the system trust store. */
    caFile: z.string().default(''),
    /**
     * Permit a cleartext connection to a host that is not this machine.
     *
     * OFF, and it has to be an explicit choice rather than a default, because
     * the records carry usernames, verified email addresses and client
     * addresses and `pg` will connect in cleartext without complaint.
     *
     * But refusing outright was wrong: a database reached over a private
     * network the operator controls — the same Kubernetes namespace, an
     * isolated compose network — is a normal and deliberate deployment, and a
     * rule that cannot be opted out of does not make those deployments secure,
     * it makes the audit log unusable for them. So the default stays strict,
     * the opt-out is named for what it permits, and turning it on logs a
     * warning naming the host every time the process starts.
     */
    allowCleartext: z.boolean().default(false),
    autoMigrate: z.boolean().default(true),
    retentionDays: z.number().int().positive().default(90),
    sweepIntervalMinutes: z.number().int().positive().default(60),
    poolMax: z.number().int().positive().default(4),
    /** These bound the three writers and the retention sweep, none of which
     *  runs on a request path — the login path performs no I/O at all. The
     *  audit PAGE's own reads do run inside a request, so `statementTimeoutMs`
     *  is also what stops a slow query holding an operator's page open. */
    connectionTimeoutMs: z.number().int().positive().default(5000),
    statementTimeoutMs: z.number().int().positive().default(1000),
  })
  .strict()
  .default({});

export const auditSchema = z
  .object({
    enabled: z.boolean().default(process.env.HORIZON_AUDIT_ENABLED === 'true'),
    /** Per Horizon node, per UTC hour. A safety valve, not a throttle: a
     *  fifty-person team produces ~100 rows a DAY, so reaching this means
     *  something is wrong and the counter is how you find out. */
    maxRowsPerHour: z.number().int().positive().default(1000),
    /** How often token aggregates and the statistics row are written. The
     *  service runs ONE timer, at `eventBatchSeconds`; this is a multiple of
     *  that tick rather than a second timer. Generic, not per-backend — the
     *  service owns the map, so a second backend never re-declares it. */
    flushIntervalSeconds: z.number().int().positive().default(60),
    /** Sign-in rows are buffered and written in batches, never on the request
     *  path — so a database cannot delay a login at all. Whichever trigger
     *  fires first STARTS a flush; a pass writes a bounded number of batches,
     *  not the whole backlog, so a drained outage takes several ticks. */
    /** REFUSED above 500 — not silently clamped, because the loader treats a
     *  ZodError as fatal. The store writes a batch in 500-row chunks with
     *  autocommit, and a failure in a later chunk re-sends the earlier ones
     *  that already committed; holding the batch to one chunk is what avoids
     *  that partial replay, and an operator who asked for more should be told
     *  rather than quietly given something else. */
    eventBatchRows: z.number().int().positive().max(500).default(50),
    /** Bounded at an hour. `setInterval` silently clamps any delay past its
     *  32-bit millisecond limit to 1 ms, so a value like 3_000_000 turns the
     *  one timer into a tight database loop — the opposite of what was asked
     *  for, with no error anywhere. */
    eventBatchSeconds: z.number().int().positive().max(3600).default(15),
    provider: z.enum(['none', 'postgres']).default('none'),
    postgres: auditPostgresSchema,
  })
  .strict()
  .default({});

/**
 * The consistency rules that must NOT be zod refinements — see `auditSchema`.
 *
 * Returns a human-readable reason the audit log cannot run, or null when the
 * configuration is coherent. `enabled: false` is not a problem: it is the
 * default and means the feature is simply off.
 *
 * The caller logs the reason at `error` and leaves the feature disabled. It
 * never throws, because an optional feature must not stop the console booting.
 */
/**
 * What a Postgres URL actually resolves to.
 *
 * The connection string is parsed ONCE, here, and the result is used both to
 * validate the configuration and to build the pool. Reading it as a string in
 * one place and letting `pg` reparse it in another is what made the TLS rule
 * bypassable: `postgres://localhost/db?host=db.internal` looks like loopback
 * to a hostname check while `pg` honours the `host` parameter and connects
 * elsewhere, and a substring search for `sslmode` accepts
 * `?sslmode=verify-full&sslmode=disable`, where the last value is the one that
 * takes effect.
 */
export interface PostgresTarget {
  host: string;
  /** `null` when the URL named a port that is not one. */
  port: number | null;
  user?: string;
  password?: string;
  database?: string;
  /** The EFFECTIVE mode: the last `sslmode` given, as libpq resolves it. */
  sslmode: string;
  /** Passed through to `pg` untouched — building the config from explicit
   *  fields must not silently drop settings the operator wrote. */
  options?: string;
  applicationName?: string;
  /** Query keys this parser does not carry into the pool. Reported rather
   *  than dropped: a setting an operator wrote and Horizon silently ignores
   *  is worse than one it refuses. */
  unsupported: string[];
}

/** The modes that open a TLS socket, and therefore the only ones a
 *  configured certificate authority can apply to. */
const TLS_MODES = new Set(['verify-full', 'verify-ca', 'require', 'prefer']);

/** Everything `parsePostgresUrl` reads and passes on. */
const CARRIED_DSN_KEYS = new Set([
  'host', 'port', 'user', 'password', 'dbname', 'sslmode',
  'options', 'application_name',
]);

/** A TCP port, or null. Rejects NaN, 0, fractions and anything out of range. */
function portNumber(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parsePostgresUrl(raw: string): PostgresTarget | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const params = url.searchParams;
  const last = (name: string): string | undefined => {
    const all = params.getAll(name);
    return all.length ? all[all.length - 1] : undefined;
  };
  // A `host` parameter overrides the authority — that is libpq behaviour and
  // `pg` follows it, so the check must too.
  const rawHost = (last('host') ?? url.hostname).replace(/^\[|\]$/g, '');
  // A hostname is case-insensitive; a Unix socket DIRECTORY is a filesystem
  // path and is not. Folding it turned `/Var/Run/PostgreSQL` into a path that
  // does not exist.
  const host = rawHost.startsWith('/') ? rawHost : rawHost.toLowerCase();
  const portRaw = last('port') ?? url.port;
  // `Number('abc')` is NaN and `Number('0')` is 0; `pg` accepts neither as a
  // port and falls back to PGPORT or 5432 — so a typo silently connects to a
  // DIFFERENT server than the URL names. `null` here is refused by
  // `auditConfigProblem` rather than quietly defaulted.
  const port = portRaw ? portNumber(portRaw) : 5432;
  return {
    host,
    port,
    // A malformed escape (`%zz`) throws from `decodeURIComponent`, and this
    // runs at startup for an OPTIONAL feature — a bad character in a password
    // must disable the audit log, not stop the console booting. The raw value
    // is kept: `pg` will refuse it and the failure surfaces as a store error.
    // libpq accepts these in the query string too, and `pg` honours them —
    // so must this, or a URL that authenticates for `psql` would not here.
    user: url.username ? safeDecode(url.username) : last('user'),
    password: url.password ? safeDecode(url.password) : last('password'),
    // Percent-encoded like any URL path segment: a database named `my db` is
    // written `my%20db`, and passing that through connects to a database of
    // that literal name, which does not exist.
    database: safeDecode(url.pathname.replace(/^\//, '')) || last('dbname'),
    sslmode: (last('sslmode') ?? '').toLowerCase(),
    options: last('options'),
    applicationName: last('application_name'),
    unsupported: [...new Set([...params.keys()])].filter((k) => !CARRIED_DSN_KEYS.has(k)),
  };
}

/**
 * Whether the target is this machine.
 *
 * A unix socket path never leaves the host, so it counts. An EMPTY host does
 * not: `pg` falls back to `PGHOST` there, which can name anything, so an
 * empty host that looked local would silently permit a cleartext connection
 * to a remote server chosen by the environment.
 *
 * And the `127/8` rule needs a real IP literal — as a string prefix it
 * accepts `127.attacker.example`, an ordinary DNS name.
 */
export function isLoopbackHost(host: string): boolean {
  if (host.startsWith('/')) return true;
  if (host === '') return false;
  return isLoopbackHostname(host);
}

export function auditConfigProblem(audit: AuditConfig): string | null {
  if (!audit.enabled) return null;
  if (audit.provider === 'none') {
    return 'audit.enabled is true but audit.provider is "none" — no backend selected, so nothing will be recorded';
  }
  const pg = audit.postgres;
  if (!pg.url) {
    return 'audit.provider is "postgres" but audit.postgres.url is empty — set HORIZON_AUDIT_POSTGRES';
  }
  // An audit log carries usernames, verified email addresses and source
  // addresses. `pg` connects in cleartext without complaint, so a non-loopback
  // URL that has not asked for a verified TLS session is refused rather than
  // warned about. `sslmode=require` is NOT enough — it encrypts without
  // authenticating the server, which stops passive capture and not an active
  // attacker.
  // Anchoring on `@` required a userinfo section, so a perfectly ordinary
  // `postgres://localhost/db` — no user in the URL — was treated as remote and
  // refused. Parse the host instead of pattern-matching the string.
  const target = parsePostgresUrl(pg.url);
  if (!target) return 'audit.postgres.url is not a valid connection string';
  if (target.unsupported.length > 0) {
    return `audit.postgres.url carries settings Horizon does not apply: ${target.unsupported.join(', ')} — remove them, or configure the equivalent (a private CA goes in postgres.caFile)`;
  }
  if (target.port === null) {
    return 'audit.postgres.url names a port that is not a port — it must be an integer from 1 to 65535, or be omitted';
  }
  if (target.host === '') {
    return 'audit.postgres.url names no host — it would fall back to PGHOST, which the configuration does not control';
  }
  const loopback = isLoopbackHost(target.host);
  const verified = target.sslmode === 'verify-full' || target.sslmode === 'verify-ca';
  // A CA is only ever consulted on a TLS connection, so a CA configured
  // alongside a mode that opens a cleartext socket is a contradiction — and
  // the silent resolution was the dangerous one: the CA was read, validated,
  // then thrown away, and the records crossed the network in the clear with
  // the operator looking at a certificate path in their config. Refused for
  // the same reason an unsupported DSN key is: only the operator can say
  // which half they meant.
  if (pg.caFile && !TLS_MODES.has(target.sslmode)) {
    return (
      `audit.postgres.caFile is set but audit.postgres.url asks for sslmode=${target.sslmode || '(none)'}, ` +
      'which opens an unencrypted connection the certificate authority would never be consulted for — ' +
      'add sslmode=verify-full to the url, or remove caFile'
    );
  }
  if (!loopback && !verified && !pg.allowCleartext) {
    return (
      'audit.postgres.url is not loopback and does not request sslmode=verify-full (or verify-ca) — ' +
      'refusing to send audit records over an unverified connection. Add sslmode=verify-full (with ' +
      'postgres.caFile for a private authority), or set postgres.allowCleartext: true if the database ' +
      'is reached over a network you control'
    );
  }
  return null;
}

export type AuditConfig = z.infer<typeof auditSchema>;
export type AuditPostgresConfig = z.infer<typeof auditPostgresSchema>;
