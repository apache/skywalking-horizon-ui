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
import { configSchema, auditConfigProblem, type AuditConfig } from './schema.js';

function audit(overrides: Record<string, unknown> = {}): AuditConfig {
  return configSchema.parse({
    layers: {}, templates: {}, security: {}, auth: {}, rbac: {}, session: {},
    debugLog: {}, query: {}, sourceMaps: {}, ai: {}, performance: {},
    audit: overrides,
  }).audit;
}

describe('audit config', () => {
  it('is off by default and selects no backend', () => {
    const a = audit();
    expect(a.enabled).toBe(false);
    expect(a.provider).toBe('none');
    expect(auditConfigProblem(a)).toBeNull();
  });

  it('carries the documented defaults', () => {
    const a = audit();
    expect(a.maxRowsPerHour).toBe(1000);
    expect(a.flushIntervalSeconds).toBe(60);
    expect(a.eventBatchRows).toBe(50);
    expect(a.eventBatchSeconds).toBe(15);
    expect(a.postgres.retentionDays).toBe(90);
    expect(a.postgres.poolMax).toBe(4);
  });

  /**
   * The reason these rules are a function and not a `.refine()`: the loader
   * treats a ZodError as fatal and calls `process.exit(1)`, so a mistyped
   * OPTIONAL feature would stop the whole console booting. Parsing must
   * SUCCEED for every one of these, leaving the problem for the caller to log.
   */
  it('parses an incoherent config without throwing, and reports the problem', () => {
    const noBackend = audit({ enabled: true });
    expect(noBackend.provider).toBe('none');
    expect(auditConfigProblem(noBackend)).toMatch(/no backend selected/);

    const noUrl = audit({ enabled: true, provider: 'postgres' });
    expect(auditConfigProblem(noUrl)).toMatch(/url is empty/);
  });

  it('refuses a non-loopback URL that does not ask for a verified TLS session', () => {
    const cleartext = audit({
      enabled: true, provider: 'postgres',
      postgres: { url: 'postgres://horizon@db.internal:5432/horizon' },
    });
    expect(auditConfigProblem(cleartext)).toMatch(/verify-full/);

    // `require` encrypts but does not authenticate the server — it stops a
    // passive listener and not an active one, so it is not sufficient here.
    const requireOnly = audit({
      enabled: true, provider: 'postgres',
      postgres: { url: 'postgres://horizon@db.internal:5432/horizon?sslmode=require' },
    });
    expect(auditConfigProblem(requireOnly)).toMatch(/verify-full/);
  });

  /** The first form of this check anchored on `@`, so it required a userinfo
   *  section — and refused an ordinary `postgres://localhost/db` as remote. */
  it('recognises every loopback form, with or without a user in the URL', () => {
    for (const url of [
      'postgres://localhost/horizon',
      'postgres://horizon@localhost:5432/horizon',
      'postgres://127.0.0.1:5432/horizon',
      'postgres://horizon:pw@[::1]:5432/horizon',
    ]) {
      expect(
        auditConfigProblem(audit({ enabled: true, provider: 'postgres', postgres: { url } })),
        url,
      ).toBeNull();
    }
  });

  /**
   * Refusing outright made the commonest real deployment impossible — a
   * Postgres in the same cluster, reached over a network the operator
   * controls. The default stays strict; the escape hatch has to be named.
   */
  it('accepts a remote cleartext host only when explicitly allowed', () => {
    const url = 'postgres://horizon@db.internal:5432/horizon';
    expect(auditConfigProblem(audit({
      enabled: true, provider: 'postgres', postgres: { url },
    }))).toMatch(/verify-full/);
    expect(auditConfigProblem(audit({
      enabled: true, provider: 'postgres', postgres: { url, allowCleartext: true },
    }))).toBeNull();
  });

  it('names the escape hatch in the refusal, so the message is actionable', () => {
    const problem = auditConfigProblem(audit({
      enabled: true, provider: 'postgres',
      postgres: { url: 'postgres://horizon@db.internal:5432/horizon' },
    }));
    expect(problem).toMatch(/allowCleartext/);
  });

  it('accepts loopback in cleartext, and a remote host with verify-full', () => {
    expect(auditConfigProblem(audit({
      enabled: true, provider: 'postgres',
      postgres: { url: 'postgres://horizon@127.0.0.1:5432/horizon' },
    }))).toBeNull();

    expect(auditConfigProblem(audit({
      enabled: true, provider: 'postgres',
      postgres: { url: 'postgres://horizon@db.internal:5432/horizon?sslmode=verify-full' },
    }))).toBeNull();
  });

  it('rejects an unknown key rather than ignoring it', () => {
    expect(() => audit({ enbaled: true })).toThrow();
  });
});

describe('server.trustProxy', () => {
  function server(trustProxy: unknown): unknown {
    return configSchema.parse({
      layers: {}, templates: {}, security: {}, auth: {}, rbac: {}, session: {},
      debugLog: {}, query: {}, sourceMaps: {}, ai: {}, performance: {},
      server: trustProxy === undefined ? {} : { trustProxy },
    }).server.trustProxy;
  }

  it('records the direct peer by default', () => {
    expect(server(undefined)).toBe(false);
  });

  /**
   * `true` means "trust the whole X-Forwarded-For header", so any caller can
   * choose the address Horizon records simply by sending one — which would
   * make `client_ip` in the audit log worse than absent, because it would look
   * authoritative. Refused rather than accepted with a warning.
   */
  it('refuses true, which would let a caller choose the recorded address', () => {
    expect(() => server(true)).toThrow();
  });

  it('accepts a hop count and an address list', () => {
    expect(server(1)).toBe(1);
    expect(server('10.0.0.0/8')).toBe('10.0.0.0/8');
    expect(server('10.0.0.1,10.0.0.2')).toBe('10.0.0.1,10.0.0.2');
  });

  it('accepts false explicitly', () => {
    expect(server(false)).toBe(false);
  });

  /** Fastify parses a string value as addresses and THROWS on anything that is
   *  not one, so `proxy.internal` took the process down at construction — long
   *  after this file was read, with a message naming Fastify rather than the
   *  setting. A hostname cannot work here even in principle: the match runs
   *  per request against a peer address. */
  it('refuses a hostname, which Fastify would crash on', () => {
    expect(() => server('proxy.internal')).toThrow();
    expect(() => server('not,an,ip')).toThrow();
  });

  it('refuses a CIDR prefix the address family cannot carry', () => {
    expect(() => server('10.0.0.0/33')).toThrow();
    expect(() => server('10.0.0.0/abc')).toThrow();
    expect(server('fd00::/8')).toBe('fd00::/8');
  });
});

describe('the TLS rule cannot be talked around', () => {
  const problemFor = (url: string): string | null =>
    auditConfigProblem(audit({ enabled: true, provider: 'postgres', postgres: { url } }));

  /**
   * `pg` honours a `host` parameter over the authority, so a check that reads
   * the URL's hostname sees loopback while the driver connects elsewhere —
   * accepting a cleartext remote connection AND skipping the warning.
   */
  it('refuses a host= parameter that redirects a loopback-looking URL', () => {
    expect(problemFor('postgres://localhost/db?host=db.internal')).toMatch(/verify-full/);
  });

  /** libpq takes the LAST value, so a substring search for the safe one is
   *  satisfied by a string that actually disables TLS. */
  it('reads the effective sslmode, not the first one that appears', () => {
    expect(problemFor('postgres://h@db.internal/db?sslmode=verify-full&sslmode=disable'))
      .toMatch(/verify-full/);
    expect(problemFor('postgres://h@db.internal/db?sslmode=disable&sslmode=verify-full'))
      .toBeNull();
  });

  it('is not satisfied by sslmode=require, which does not authenticate the server', () => {
    expect(problemFor('postgres://h@db.internal/db?sslmode=require')).toMatch(/verify-full/);
  });

  it('still accepts a genuine loopback target and a genuine verified one', () => {
    expect(problemFor('postgres://h@127.0.0.1:5432/db')).toBeNull();
    expect(problemFor('postgres://h@db.internal/db?sslmode=verify-ca')).toBeNull();
  });

  it('refuses a connection string it cannot parse rather than assuming', () => {
    expect(problemFor('not a url at all')).toMatch(/valid connection string/);
  });
});

describe('the hourly budget cannot be spent by one account', () => {
  it('caps a single principal at a share, leaving room for everyone else', async () => {
    const { AuditCounters } = await import('../store/audit/counters.js');
    const at = Date.UTC(2026, 7, 22, 14, 0);
    const c = new AuditCounters({ maxRowsPerHour: 100 });

    // One noisy account signs in far past its share (100/10 = 20).
    let noisyAccepted = 0;
    for (let i = 0; i < 200; i += 1) if (c.admitEvent('local', 1, at, undefined, 'noisy')) noisyAccepted += 1;
    expect(noisyAccepted).toBe(20);

    // The admin sign-in an audit log exists to capture still lands.
    expect(c.admitEvent('sso', 1, at, 'oidc', 'admin@example.com')).toBe(true);
  });
});

describe('loopback means an address, not a name that starts like one', () => {
  const problemFor = (url: string): string | null =>
    auditConfigProblem(audit({ enabled: true, provider: 'postgres', postgres: { url } }));

  /** `/^127\./` as a string prefix accepts an ordinary DNS name whose owner
   *  points it wherever they like. */
  it('refuses a hostname that merely begins with 127.', () => {
    expect(problemFor('postgres://h@127.attacker.example:5432/db')).toMatch(/verify-full/);
    expect(problemFor('postgres://h@127.0.0.1:5432/db')).toBeNull();
  });

  it('refuses localhost-lookalikes', () => {
    expect(problemFor('postgres://h@localhost.attacker.example/db')).toMatch(/verify-full/);
  });

  /** An empty host makes `pg` fall back to PGHOST, which the configuration
   *  does not control — so it cannot be treated as local. */
  it('refuses a URL that names no host', () => {
    expect(problemFor('postgres:///db')).toMatch(/no host/);
  });

  it('accepts a unix socket path, which never leaves the machine', () => {
    expect(problemFor('postgres://h@localhost/db?host=/var/run/postgresql')).toBeNull();
  });

  /** An optional feature must not stop the console booting over a bad
   *  character in a password. */
  it('does not throw on a malformed percent escape', () => {
    expect(() => problemFor('postgres://u:p%zz@127.0.0.1/db')).not.toThrow();
  });
});

describe('the DSN carries only what Horizon applies', () => {
  const problemFor = (url: string): string | null =>
    auditConfigProblem(audit({ enabled: true, provider: 'postgres', postgres: { url } }));

  /** A TLS file an operator wrote and Horizon silently ignored is worse than
   *  one it refuses: they would believe a client certificate was in use. */
  it('refuses settings it would otherwise drop', () => {
    expect(problemFor('postgres://h@127.0.0.1/db?sslcert=/x.pem')).toMatch(/does not apply/);
    expect(problemFor('postgres://h@127.0.0.1/db?sslrootcert=/ca.pem')).toMatch(/sslrootcert/);
  });

  it('accepts the ones it does carry', () => {
    expect(problemFor('postgres://127.0.0.1/db?user=h&password=p&application_name=horizon')).toBeNull();
    expect(problemFor('postgres://h@127.0.0.1/db?options=-c%20statement_timeout%3D5s')).toBeNull();
  });
});

/**
 * A certificate authority is only ever consulted on a TLS connection, so a
 * `caFile` beside a mode that opens a cleartext socket is a contradiction.
 * It used to resolve silently in the dangerous direction: the CA was read and
 * validated, `sslFor` then fell through to `ssl: false`, and every record —
 * usernames, verified email addresses, client addresses — crossed the network
 * in the clear while the operator was looking at a certificate path in their
 * configuration.
 */
describe('a CA and the connection mode must agree', () => {
  const withCa = (url: string, over: Record<string, unknown> = {}) =>
    auditConfigProblem(
      audit({
        enabled: true, provider: 'postgres',
        postgres: { url, caFile: '/etc/horizon/pg-ca.crt', ...over },
      }),
    );

  it('refuses a CA on a connection that asks for no TLS at all', () => {
    expect(withCa('postgres://h@audit-db:5432/horizon', { allowCleartext: true })).toMatch(/caFile/);
  });

  it('refuses a CA even on loopback, where the url is otherwise accepted', () => {
    // Loopback is exempt from the TLS requirement, which is exactly why the
    // contradiction has to be caught on its own terms rather than as a
    // side effect of the transport rule.
    expect(withCa('postgres://h@127.0.0.1:5432/horizon')).toMatch(/caFile/);
  });

  it('accepts a CA with a verifying mode', () => {
    expect(withCa('postgres://h@audit-db:5432/horizon?sslmode=verify-full')).toBeNull();
    expect(withCa('postgres://h@audit-db:5432/horizon?sslmode=verify-ca')).toBeNull();
  });

  it('accepts a CA with an encrypting-but-unverified mode, which the transport rule then judges', () => {
    // `require` encrypts, so the CA is at least consulted; whether it is good
    // ENOUGH is the separate question the sslmode rule answers.
    expect(withCa('postgres://h@audit-db:5432/horizon?sslmode=require', { allowCleartext: true })).toBeNull();
  });

  it('leaves a url with no CA alone', () => {
    expect(
      auditConfigProblem(
        audit({
          enabled: true, provider: 'postgres',
          postgres: { url: 'postgres://h@127.0.0.1:5432/horizon' },
        }),
      ),
    ).toBeNull();
  });
});

/** `dbname` is a carried key, so it has to actually be carried: reporting it
 *  as supported and then connecting to no database at all is the silent drop
 *  the carried/unsupported split exists to prevent. */
describe('the database can be named in the query string', () => {
  it('accepts a url whose database comes from dbname rather than the path', () => {
    expect(
      auditConfigProblem(
        audit({
          enabled: true, provider: 'postgres',
          postgres: { url: 'postgres://h@127.0.0.1:5432/?dbname=horizon' },
        }),
      ),
    ).toBeNull();
  });
});

/** `Number('abc')` is NaN and `Number('0')` is 0; `pg` accepts neither and
 *  falls back to PGPORT or 5432 — so a typo connects to a different server
 *  than the URL names, with nothing said. */
describe('the DSN port must be a port', () => {
  const problem = (url: string) =>
    auditConfigProblem(audit({ enabled: true, provider: 'postgres', postgres: { url } }));

  it('refuses a non-numeric port', () => {
    expect(problem('postgres://h@127.0.0.1:5432/db?port=abc')).toMatch(/not a port/);
  });

  it('refuses port 0 and anything out of range', () => {
    expect(problem('postgres://h@127.0.0.1/db?port=0')).toMatch(/not a port/);
    expect(problem('postgres://h@127.0.0.1/db?port=70000')).toMatch(/not a port/);
    expect(problem('postgres://h@127.0.0.1/db?port=5432.5')).toMatch(/not a port/);
  });

  it('accepts a real port, in the authority or the query string', () => {
    expect(problem('postgres://h@127.0.0.1:55432/db')).toBeNull();
    expect(problem('postgres://h@127.0.0.1/db?port=55432')).toBeNull();
  });

  it('accepts a URL that names no port at all', () => {
    expect(problem('postgres://h@127.0.0.1/db')).toBeNull();
  });
});
