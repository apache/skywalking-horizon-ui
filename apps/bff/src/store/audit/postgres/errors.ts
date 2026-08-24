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
 * Driver failures, mapped to the fixed vocabulary the rest of the audit store
 * speaks.
 *
 * Its own module because both stores need it: leaving it in `store.ts` while
 * `token-store.ts` imported it — and `store.ts` imported the token store back
 * — made the two files a cycle.
 */

import { logger } from '../../../logger.js';
import { AuditStoreError, type StoreError } from '../types.js';

/**
 * Map a driver failure to the fixed vocabulary.
 *
 * Nothing from `pg` crosses this boundary. A connection error can carry the
 * DSN — host, database, and depending on the failure the user — and the code
 * travels into logs, replies and the admin page. The raw error is logged at
 * debug here, where it cannot escape.
 */
export function classify(err: unknown): StoreError {
  const code = (err as { code?: string } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  logger.debug({ err: message, code }, 'audit: postgres error');
  if (code === '28P01' || code === '28000') return 'auth_failed';
  if (code === '57014' || code === 'ETIMEDOUT' || /timeout/i.test(message)) return 'timeout';
  // ANY server-side error class is a fault in the statement or the schema, not
  // a dead database. Reporting one as `unreachable` sends the operator to look
  // at the network while the real cause sits in a query — and because the next
  // probe succeeds, health flaps red-green on every tick forever instead of
  // holding one honest state. SQLSTATE classes 08 (connection) and 53
  // (insufficient resources) are the genuinely connection-shaped ones.
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
    if (code.startsWith('08') || code.startsWith('53')) return 'unreachable';
    return 'schema_error';
  }
  return 'unreachable';
}

export function fail(err: unknown): never {
  throw err instanceof AuditStoreError ? err : new AuditStoreError(classify(err));
}
