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
 * Constructing the audit log from configuration.
 *
 * Every caller gets an `AuditService` whatever the deployment does, so no
 * emit site needs to know whether auditing is configured — a disabled one is a
 * no-op object rather than a null check at each call.
 */

import type { AuditConfig } from '../../config/schema.js';
import { auditConfigProblem } from '../../config/schema.js';
import { parsePostgresUrl } from '../../config/audit.js';
import { logger } from '../../logger.js';
import { PostgresAuditStore } from './postgres/store.js';
import { BanyanDBAuditStore } from './banyandb/store.js';
import { BufferedAuditService, DisabledAuditService } from './service.js';
import type { AuditService } from './types.js';

export interface AuditSetup {
  audit: AuditConfig;
}

/**
 * Never throws, and never prevents the console booting.
 *
 * An incoherent configuration is logged at `error` and leaves the feature off.
 * The same rules could have been a zod refinement, which would have been
 * shorter and wrong: the config loader treats a ZodError as fatal, so a
 * mistyped OPTIONAL feature would stop the whole UI from starting.
 */
/** Host only — the connection string is a secret and must never be logged. */
/** The host the records actually reach — which is the parsed target, not the
 *  URL's authority: a `?host=` parameter overrides it and `pg` honours that. */
/**
 * What the url's `sslmode` actually gets you, which is three states rather
 * than two.
 *
 * `verify-full` / `verify-ca` encrypt AND check who answered. `require` and
 * `prefer` encrypt without checking, which stops someone listening and not
 * someone impersonating — so the records do not travel in the clear, and
 * saying they do is simply wrong. Anything else is a cleartext socket.
 */
function postgresTransport(url: string): 'verified' | 'encrypted' | 'cleartext' {
  const mode = parsePostgresUrl(url)?.sslmode;
  if (mode === 'verify-full' || mode === 'verify-ca') return 'verified';
  if (mode === 'require' || mode === 'prefer') return 'encrypted';
  return 'cleartext';
}

function hostOf(url: string): string {
  const target = parsePostgresUrl(url);
  if (!target || !target.host) return '(unparseable)';
  return `${target.host}:${target.port}`;
}

export function createAuditService({ audit }: AuditSetup): AuditService {
  const problem = auditConfigProblem(audit);
  if (problem) {
    logger.error({ problem }, 'audit: disabled — the configuration cannot be used');
    return new DisabledAuditService(audit, problem);
  }
  if (!audit.enabled || audit.provider === 'none') return new DisabledAuditService(audit);

  // Loud, and every boot: an operator who turned this on months ago should
  // still be told what it is doing.
  //
  // Only when the connection really is in the clear, though. `allowCleartext`
  // is a PERMISSION, not a mode: alongside TLS it permits something that then
  // does not happen, and warning there tells an operator their encrypted
  // connection is unencrypted — which is worse than not warning, because the
  // next time the line appears about a connection that IS in the clear, they
  // have already learned to ignore it.
  if (audit.provider === 'postgres' && audit.postgres.allowCleartext) {
    const transport = postgresTransport(audit.postgres.url);
    if (transport === 'cleartext') {
      logger.warn(
        { host: hostOf(audit.postgres.url) },
        'audit: postgres.allowCleartext is on — sign-in records, including verified email ' +
          'addresses and client addresses, travel to this host unencrypted',
      );
    } else if (transport === 'encrypted') {
      logger.warn(
        { host: hostOf(audit.postgres.url), sslmode: 'require/prefer' },
        'audit: postgres.allowCleartext is on and sslmode does not verify the server — the ' +
          'connection is encrypted but its peer is unchecked, which stops someone listening ' +
          'and not someone impersonating. Use sslmode=verify-full',
      );
    }
  }
  if (audit.provider === 'banyandb' && audit.banyandb.allowCleartext && !audit.banyandb.tls) {
    logger.warn(
      { address: audit.banyandb.address },
      'audit: banyandb.allowCleartext is on — sign-in records, and the credentials for this ' +
        'store, travel to this host unencrypted',
    );
  }
  logger.info(
    {
      provider: audit.provider,
      maxRowsPerHour: audit.maxRowsPerHour,
      eventBatchRows: audit.eventBatchRows,
      eventBatchSeconds: audit.eventBatchSeconds,
      retentionDays:
        audit.provider === 'banyandb' ? audit.banyandb.retentionDays : audit.postgres.retentionDays,
    },
    'audit: recording sign-ins',
  );

  if (audit.provider === 'banyandb') {
    // One object serves both contracts here: the sign-in log and token use
    // share a connection, and on this store they also share a schema.
    const store = new BanyanDBAuditStore({
      namespace: audit.banyandb.namespace ?? '',
      retentionDays: audit.banyandb.retentionDays,
      connection: {
        kind: 'banyandb',
        address: audit.banyandb.address,
        ...(audit.banyandb.username === undefined ? {} : { username: audit.banyandb.username }),
        ...(audit.banyandb.password === undefined ? {} : { password: audit.banyandb.password }),
        ...(audit.banyandb.tls
          ? { tls: { enabled: true, ...(audit.banyandb.caFile ? { caFile: audit.banyandb.caFile } : {}) } }
          : {}),
        deadlineMs: audit.banyandb.deadlineMs,
      },
    });
    return new BufferedAuditService({ store, tokenStore: store, config: audit });
  }

  const store = new PostgresAuditStore(audit.postgres);
  return new BufferedAuditService({
    store,
    // The token-usage statistic shares this store's pool — a separate
    // contract, not a separate connection.
    tokenStore: store.tokenUsage(),
    config: audit,
  });
}

export { BufferedAuditService, DisabledAuditService } from './service.js';
export { PostgresAuditStore } from './postgres/store.js';
export { BanyanDBAuditStore } from './banyandb/store.js';
export * from './types.js';
