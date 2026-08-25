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

import { readFileSync } from 'node:fs';
import {
  Client,
  Metadata,
  credentials,
  type CallOptions,
  type ChannelCredentials,
  type ClientDuplexStream,
  type MethodDefinition,
} from '@grpc/grpc-js';
import { loadBanyanDBProto } from './proto.js';
import { wrapGrpcError, BanyanDBError } from './errors.js';

/**
 * How to reach a BanyanDB liaison.
 *
 * `kind` is a brand, not decoration: the other client option types in this
 * folder are structurally similar enough that a mis-wired call site would
 * otherwise type-check against the wrong one.
 */
export interface BanyanDBOptions {
  readonly kind: 'banyandb';
  /** `host:port` of the liaison's gRPC port (17912 by default). */
  address: string;
  username?: string;
  password?: string;
  /** Absent means an insecure channel. A `caFile` selects TLS with that
   *  authority; omit it for TLS against a public authority. */
  tls?: { enabled: boolean; caFile?: string };
  /** Applied to every call that does not override it. */
  deadlineMs: number;
  /** grpc-js defaults to 4 MiB; the server sends up to 16 MiB. */
  maxReceiveBytes?: number;
}

const DEFAULT_MAX_RECEIVE_BYTES = 16 * 1024 * 1024;

/**
 * Transport only. Credentials do NOT ride on the channel.
 *
 * gRPC refuses to compose call credentials onto an insecure channel — it
 * throws at construction — and BanyanDB's own documented setup is exactly
 * that: username and password over plaintext. So the credentials travel as
 * ordinary metadata on every call instead, which works the same whether or
 * not TLS is on.
 */
function buildCredentials(opts: BanyanDBOptions): ChannelCredentials {
  return opts.tls?.enabled
    ? credentials.createSsl(opts.tls.caFile ? readFileSync(opts.tls.caFile) : undefined)
    : credentials.createInsecure();
}

/**
 * The loaded contract, parsed ONCE.
 *
 * Parsing the vendored tree costs ~10ms of blocked event loop; doing it per
 * RPC would put that in front of every call.
 */
let cached: ReturnType<typeof loadBanyanDBProto> | undefined;
function definition(): ReturnType<typeof loadBanyanDBProto> {
  cached ??= loadBanyanDBProto();
  return cached;
}

/** proto-loader types its definitions loosely; this is the one place the
 *  loaded shape is narrowed to the method signature grpc-js wants. */
function methodOf<Req, Res>(service: string, rpc: string): MethodDefinition<Req, Res> {
  const def = definition();
  const svc = def[service];
  const method = svc && (svc as Record<string, unknown>)[rpc];
  if (!method) {
    throw new BanyanDBError('internal', `no such method in the vendored contract: ${service}/${rpc}`);
  }
  return method as unknown as MethodDefinition<Req, Res>;
}

export class BanyanDBChannel {
  private readonly client: Client;

  constructor(private readonly opts: BanyanDBOptions) {
    this.client = new Client(opts.address, buildCredentials(opts), {
      'grpc.max_receive_message_length': opts.maxReceiveBytes ?? DEFAULT_MAX_RECEIVE_BYTES,
    });
  }

  /** Wait for the channel to be usable. Without this the first call absorbs
   *  connection setup into its own deadline and fails as a timeout. */
  async connect(deadlineMs = this.opts.deadlineMs): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.client.waitForReady(Date.now() + deadlineMs, (err) =>
        err ? reject(wrapGrpcError(err, `connecting to ${this.opts.address}`)) : resolve(),
      );
    });
  }

  close(): void {
    this.client.close();
  }

  private callOptions(deadlineMs?: number): CallOptions {
    return { deadline: Date.now() + (deadlineMs ?? this.opts.deadlineMs) };
  }

  /** The credentials, as the two plaintext lowercase keys BanyanDB reads —
   *  not an `authorization` header, no scheme, no encoding. A fresh object per
   *  call, because grpc-js may mutate the one it is given. */
  private metadata(): Metadata {
    const md = new Metadata();
    if (this.opts.username !== undefined) md.set('username', this.opts.username);
    if (this.opts.password !== undefined) md.set('password', this.opts.password);
    return md;
  }

  async unary<Req, Res>(service: string, rpc: string, req: Req, deadlineMs?: number): Promise<Res> {
    const m = methodOf<Req, Res>(service, rpc);
    return new Promise<Res>((resolve, reject) => {
      this.client.makeUnaryRequest<Req, Res>(
        m.path,
        m.requestSerialize,
        m.responseDeserialize,
        req,
        this.metadata(),
        this.callOptions(deadlineMs),
        (err, res) =>
          err ? reject(wrapGrpcError(err, `${service}/${rpc}`)) : resolve(res as Res),
      );
    });
  }

  /** Open a bidirectional stream. The caller drives it; see `write.ts` for the
   *  send-all-then-half-close shape the write RPCs require. */
  duplex<Req, Res>(service: string, rpc: string, deadlineMs?: number): ClientDuplexStream<Req, Res> {
    const m = methodOf<Req, Res>(service, rpc);
    return this.client.makeBidiStreamRequest<Req, Res>(
      m.path,
      m.requestSerialize,
      m.responseDeserialize,
      this.metadata(),
      this.callOptions(deadlineMs),
    );
  }
}
