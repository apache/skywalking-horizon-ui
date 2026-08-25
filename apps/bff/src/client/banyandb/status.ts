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
 * The per-message outcome of a write.
 *
 * BanyanDB declares this as an enum, but `WriteResponse.status` is a plain
 * `string` on the wire carrying the enum's NAME — the server sends
 * `status.String()`. So the union below is the client's own, and an
 * unrecognised value is possible whenever the server is newer than the pinned
 * contract.
 */
export const WRITE_STATUSES = [
  'STATUS_UNSPECIFIED',
  'STATUS_SUCCEED',
  'STATUS_INVALID_TIMESTAMP',
  'STATUS_NOT_FOUND',
  'STATUS_EXPIRED_SCHEMA',
  'STATUS_INTERNAL_ERROR',
  'STATUS_DISK_FULL',
  'STATUS_VERSION_UNSUPPORTED',
  'STATUS_VERSION_DEPRECATED',
  'STATUS_METADATA_REQUIRED',
  'STATUS_SCHEMA_NOT_APPLIED',
] as const;

export type WriteStatus = (typeof WRITE_STATUSES)[number];

/** A status the server sent that this build has no name for. Kept distinct
 *  from the known set so a caller can tell "newer server" from "known fault". */
export const UNKNOWN_STATUS = 'STATUS_UNKNOWN' as const;
/** No reply arrived for a message the client sent. Not a server value: the
 *  write stream can end without answering every id (see `writeBatch`). */
export const NO_REPLY = 'STATUS_NO_REPLY' as const;

export type WriteOutcomeStatus = WriteStatus | typeof UNKNOWN_STATUS | typeof NO_REPLY;

export function toWriteStatus(raw: string): WriteOutcomeStatus {
  return (WRITE_STATUSES as readonly string[]).includes(raw)
    ? (raw as WriteStatus)
    : UNKNOWN_STATUS;
}

/**
 * Whether re-sending the same rows could succeed.
 *
 * The distinction is load-bearing rather than cosmetic: a caller that treats
 * every non-success alike either retries a row the server will never accept,
 * or discards one it would have taken a moment later.
 *
 * Schema propagation is the transient case — the row is well-formed and the
 * receiving node simply has not caught up. Everything else is a fault in the
 * request, the schema, or the server, and re-sending reproduces it. An
 * unknown status counts as permanent: a build that cannot name a status
 * cannot reason about whether repeating it is safe.
 */
export function isTransient(status: WriteOutcomeStatus): boolean {
  return status === 'STATUS_SCHEMA_NOT_APPLIED' || status === 'STATUS_EXPIRED_SCHEMA';
}

export function isSucceeded(status: WriteOutcomeStatus): boolean {
  return status === 'STATUS_SUCCEED';
}
