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

import pino, { type LoggerOptions } from 'pino';

// Production unless explicitly opted into dev. Matters because the
// "production target" includes both `node dist/server.js` (local
// binary) and the Docker image — both should be quiet by default and
// emit machine-readable JSON for log aggregators. Only `pnpm dev` /
// `tsx watch` flips into dev mode (its `dev` script sets
// NODE_ENV=development).
const isDev = process.env.NODE_ENV === 'development';

/**
 * Default log level:
 *   - dev (`NODE_ENV=development`, e.g. `pnpm --filter bff dev`):
 *     `debug` — verbose lifecycle + per-request access logs, pretty-
 *     printed via `pino-pretty` for human reading.
 *   - prod (anything else, incl. local `node dist/server.js` and the
 *     Docker image): `warn` — quiet by default. Fastify's per-request
 *     `info` access logs are suppressed; only warnings, errors, and
 *     fatals reach stdout as JSON. `warn` (not `error`) is the floor
 *     because misconfiguration + security signals are emitted at warn
 *     (break-glass logins, LDAP failures, rejected config reloads) and
 *     operators are told to alert on them.
 *
 * Operators tune it explicitly: `LOG_LEVEL=info` for access logs,
 * `LOG_LEVEL=debug` for the lifecycle chatter, `trace` for everything
 * pino-instrumented code emits, `LOG_LEVEL=error` to silence warnings.
 */
export const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'warn'),
  // Backstop redaction for every credential horizon.yaml can carry. None is
  // intentionally logged, but a stray `logger.info({ config })` — or an error
  // object that happens to embed connection options — must not leak one. Covers
  // the LLM key, the OAP basic-auth password, the LDAP service-account bind
  // password, each SSO provider's client secret, the OAuth signing key and the
  // audit store's connection string — each at its config path and under a
  // `config.` wrapper.
  redact: {
    paths: [
      'ai.apiKey',
      'config.ai.apiKey',
      '*.apiKey',
      '*.bedrockBearerToken',
      'oap.auth.password',
      'config.oap.auth.password',
      '*.auth.password',
      'auth.ldap.bindPassword',
      'config.auth.ldap.bindPassword',
      '*.bindPassword',
      // SSO: the per-provider client secret, and the OAuth signing key that
      // every issued token is only as private as.
      '*.clientSecret',
      '*.client_secret',
      'oauth.signingKey',
      'config.oauth.signingKey',
      '*.signingKey',
      // The audit store's connection string. Not covered by any wildcard
      // above, and it carries host, database, user and password in one value.
      'audit.postgres.url',
      'config.audit.postgres.url',
      '*.postgres.url',
      '*.connectionString',
    ],
    censor: '[redacted]',
  },
  /**
   * Strip the query string from access-logged URLs.
   *
   * The audit page filters by person — `?username=alice@corp.example` — and
   * Fastify's per-request `info` line carries the full URL, which the docs
   * tell operators to turn on. That copies the identity of everyone an
   * auditor looks up into a second store with its own retention, outside the
   * audit log's own rules, and readable by anyone who can read logs. The path
   * is what an access log is for; the arguments are not.
   */
  serializers: {
    req(request: { method: string; url?: string; id?: unknown; ip?: string }) {
      const url = request.url ?? '';
      const cut = url.indexOf('?');
      return {
        id: request.id,
        method: request.method,
        url: cut === -1 ? url : `${url.slice(0, cut)}?[redacted]`,
        ip: request.ip,
      };
    },
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
};

export const logger = pino(loggerOptions);
