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
  if (audit.provider === 'postgres' && audit.postgres.allowCleartext) {
    logger.warn(
      { host: hostOf(audit.postgres.url) },
      'audit: postgres.allowCleartext is on — sign-in records, including verified email ' +
        'addresses and client addresses, travel to this host unencrypted',
    );
  }
  logger.info(
    {
      provider: audit.provider,
      maxRowsPerHour: audit.maxRowsPerHour,
      eventBatchRows: audit.eventBatchRows,
      eventBatchSeconds: audit.eventBatchSeconds,
      retentionDays: audit.postgres.retentionDays,
    },
    'audit: recording sign-ins',
  );
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
export * from './types.js';
