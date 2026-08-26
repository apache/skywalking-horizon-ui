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

import { BanyanDBError } from '../../../client/banyandb/index.js';
import { AuditStoreError, type StoreError } from '../types.js';

/**
 * The client's vocabulary, narrowed to the four the page can say something
 * useful about.
 *
 * The gRPC detail is deliberately dropped rather than passed on: a driver
 * message names the address it failed to reach, and this reaches an admin
 * screen.
 */
export function classify(err: unknown): StoreError {
  if (!(err instanceof BanyanDBError)) return 'unreachable';
  switch (err.code) {
    case 'unauthenticated':
      return 'auth_failed';
    case 'deadline':
      return 'timeout';
    case 'invalid':
    case 'not_found':
      return 'schema_error';
    case 'unavailable':
    case 'rejected':
    case 'internal':
    default:
      return 'unreachable';
  }
}

/**
 * Re-throw as the store's own vocabulary.
 *
 * An `AuditStoreError` passes through UNCHANGED. It is already this
 * vocabulary — something above decided what the failure means — and
 * reclassifying it loses that: `too_large` became `unreachable`, which reports
 * the whole store down over a read that was merely too big, and takes the
 * buffered writes with it.
 */
export function fail(err: unknown): never {
  if (err instanceof AuditStoreError) throw err;
  throw new AuditStoreError(classify(err));
}
