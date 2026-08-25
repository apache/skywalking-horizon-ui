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

import { status as GrpcStatus } from '@grpc/grpc-js';

/**
 * What went wrong, in the client's own vocabulary.
 *
 * Deliberately NOT the audit store's `StoreError`: `client/` must not know
 * what is stored on top of it, so the mapping onto that four-value UI-facing
 * set belongs to the store, the same way `postgres/errors.ts` owns the
 * mapping for `pg`.
 */
export type BanyanDBErrorCode =
  /** The server could not be reached, or the channel dropped. */
  | 'unavailable'
  /** Credentials missing, wrong, or not accepted. */
  | 'unauthenticated'
  /** A deadline expired, or the caller cancelled. */
  | 'deadline'
  /** The request is malformed, or contradicts the stored schema. */
  | 'invalid'
  /** The named group / stream / measure does not exist. */
  | 'not_found'
  /** The server is up but refused the work — resource limits, a group being
   *  deleted. Distinct from `unavailable` because retrying can succeed. */
  | 'rejected'
  /** Anything the server reported that this build cannot place. */
  | 'internal';

export class BanyanDBError extends Error {
  constructor(
    readonly code: BanyanDBErrorCode,
    message: string,
    readonly grpcCode?: GrpcStatus,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'BanyanDBError';
  }

  /** Whether the same call could succeed if repeated. `rejected` is included
   *  because the server says so explicitly: a stream refused under memory
   *  pressure, or a group mid-deletion, both clear on their own. */
  get retryable(): boolean {
    return this.code === 'unavailable' || this.code === 'rejected' || this.code === 'deadline';
  }
}

/**
 * gRPC status → client vocabulary.
 *
 * `UNIMPLEMENTED` maps to `not_found` rather than `internal` on purpose: on
 * this wire it means the server predates an RPC the pinned contract declares,
 * which is a capability question a caller can act on, not a fault.
 */
export function codeOfGrpc(grpcCode: GrpcStatus): BanyanDBErrorCode {
  switch (grpcCode) {
    case GrpcStatus.UNAVAILABLE:
      return 'unavailable';
    case GrpcStatus.UNAUTHENTICATED:
    case GrpcStatus.PERMISSION_DENIED:
      return 'unauthenticated';
    case GrpcStatus.DEADLINE_EXCEEDED:
    case GrpcStatus.CANCELLED:
      return 'deadline';
    case GrpcStatus.INVALID_ARGUMENT:
    case GrpcStatus.ALREADY_EXISTS:
      return 'invalid';
    case GrpcStatus.NOT_FOUND:
    case GrpcStatus.UNIMPLEMENTED:
      return 'not_found';
    case GrpcStatus.RESOURCE_EXHAUSTED:
    case GrpcStatus.FAILED_PRECONDITION:
      return 'rejected';
    default:
      return 'internal';
  }
}

interface GrpcServiceError {
  code?: unknown;
  details?: unknown;
  message?: unknown;
}

/**
 * Wrap whatever grpc-js threw.
 *
 * The address is NOT folded into the message here. grpc-js already puts the
 * target in its own text, and a caller that surfaces this to an operator is
 * responsible for sanitizing — the same rule the Postgres store follows for
 * connection strings.
 */
export function wrapGrpcError(err: unknown, what: string): BanyanDBError {
  if (err instanceof BanyanDBError) return err;
  const e = (err ?? {}) as GrpcServiceError;
  const grpcCode = typeof e.code === 'number' ? (e.code as GrpcStatus) : undefined;
  const detail =
    (typeof e.details === 'string' && e.details) ||
    (typeof e.message === 'string' && e.message) ||
    String(err);
  return new BanyanDBError(
    grpcCode === undefined ? 'internal' : codeOfGrpc(grpcCode),
    `${what}: ${detail}`,
    grpcCode,
    { cause: err },
  );
}
