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

import type { ClientDuplexStream } from '@grpc/grpc-js';
import type { BanyanDBChannel } from './channel.js';
import { wrapGrpcError } from './errors.js';
import { NO_REPLY, toWriteStatus, type WriteOutcomeStatus } from './status.js';

export interface WriteOutcome {
  messageId: string;
  status: WriteOutcomeStatus;
}

interface WireWriteResponse {
  message_id?: string;
  status?: string;
}

/**
 * Send one batch on its own short-lived stream.
 *
 * The shape is send-all, half-close, then drain — and it is not a stylistic
 * choice. The liaison replies inline only for FAILURES; successes are queued
 * and flushed after it sees the client's half-close, so awaiting an ack before
 * sending the next row deadlocks on a batch where nothing is wrong. A
 * long-lived stream never gets its successes flushed at all and grows the
 * server's pending list without bound.
 *
 * Every id sent gets an outcome. The server may end the stream having answered
 * only some of them — those come back as `STATUS_NO_REPLY` rather than being
 * assumed to have landed, because the whole point of the batch is to know what
 * was recorded.
 */
export async function sendBatch<Req extends { message_id: string }>(
  ch: BanyanDBChannel,
  service: string,
  requests: readonly Req[],
  deadlineMs?: number,
): Promise<WriteOutcome[]> {
  if (requests.length === 0) return [];

  const call: ClientDuplexStream<Req, WireWriteResponse> = ch.duplex<Req, WireWriteResponse>(
    service,
    'Write',
    deadlineMs,
  );

  const seen = new Map<string, WriteOutcomeStatus>();

  const drained = new Promise<void>((resolve, reject) => {
    call.on('data', (res: WireWriteResponse) => {
      if (res.message_id) seen.set(res.message_id, toWriteStatus(res.status ?? ''));
    });
    call.on('error', (err) => reject(wrapGrpcError(err, `${service}/Write`)));
    call.on('end', () => resolve());
  });

  // `write()` returning false means the send buffer is full; ignoring it lets
  // a large batch accumulate in memory rather than on the wire.
  for (const req of requests) {
    if (!call.write(req)) {
      await new Promise<void>((resolve) => call.once('drain', resolve));
    }
  }
  call.end();
  await drained;

  // Correlate by message_id, never by arrival order: the server continues past
  // a rejected row rather than aborting the batch, so replies are neither
  // complete nor in the order they were sent.
  return requests.map((r) => ({
    messageId: r.message_id,
    status: seen.get(r.message_id) ?? NO_REPLY,
  }));
}

/**
 * A monotonic, time-derived message id.
 *
 * It must be greater than zero, and for a Measure it doubles as the data
 * point's `version` when none is given — where the merge keeps the HIGHER
 * version. A counter restarting at 1 each run would therefore make a later
 * correction lose to the row it was meant to replace. Epoch nanoseconds
 * exceed `Number.MAX_SAFE_INTEGER`, so this is a bigint stringified.
 */
export function createMessageIds(): () => string {
  let last = 0n;
  return () => {
    const now = BigInt(Date.now()) * 1_000_000n;
    last = now > last ? now : last + 1n;
    return last.toString();
  };
}
