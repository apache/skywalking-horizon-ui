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

import type { BanyanDBChannel } from './channel.js';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { banyandb } from './proto.pb.js';
import { BanyanDBError } from './errors.js';
import type { ModRevision } from './registry.js';

const SVC = 'banyandb.schema.v1.SchemaBarrierService';

export type SchemaKind = 'group' | 'stream' | 'measure' | 'index_rule' | 'index_rule_binding';

export interface SchemaKey {
  kind: SchemaKind;
  group: string;
  name: string;
}

export interface NodeLaggard {
  node: string;
  currentModRevision: ModRevision;
  missingKeys: SchemaKey[];
}

export interface BarrierResult {
  applied: boolean;
  laggards: NodeLaggard[];
  /** The server predates the barrier. Reported rather than thrown: an older
   *  server is a capability fact, and the caller may reasonably proceed. */
  unimplemented?: true;
}

// Derived from the generated declarations rather than restated: the schema
// proto is generated now, so a hand-written copy would be a second source that
// `proto:check` cannot keep honest.
type WireKey = banyandb.schema.v1.SchemaKey;
type WireLaggard = banyandb.schema.v1.NodeLaggard;

function toLaggards(raw: WireLaggard[] | undefined): NodeLaggard[] {
  return (raw ?? []).map((l) => ({
    node: l.node ?? '',
    currentModRevision: l.current_mod_revision ?? '0',
    // The generated fields are optional because protobuf scalars always are;
    // the client's own SchemaKey is not, so the absent case is named here
    // rather than leaking `undefined` into a reported laggard.
    missingKeys: (l.missing_keys ?? []).map((k) => ({
      kind: (k.kind ?? '') as SchemaKind,
      group: k.group ?? '',
      name: k.name ?? '',
    })),
  }));
}

/** Durations cross the wire as seconds plus nanos, not milliseconds. */
function duration(ms: number): { seconds: string; nanos: number } {
  return { seconds: String(Math.floor(ms / 1000)), nanos: (ms % 1000) * 1_000_000 };
}

/**
 * Block until every data node has the named schema at or above its revision.
 *
 * This is what makes a write safe immediately after a create: the registry
 * accepts the schema at the liaison, but a data node that has not yet seen it
 * rejects the row. On a standalone server the two are one process and the
 * wait is trivially satisfied — which is exactly why a green standalone test
 * proves the call is well-formed, not that propagation works.
 *
 * A timeout is NOT an error: it returns `applied: false` with the nodes that
 * lagged, so the caller decides whether to proceed or refuse.
 */
export async function awaitSchemaApplied(
  ch: BanyanDBChannel,
  keys: readonly { key: SchemaKey; minRevision: ModRevision }[],
  timeoutMs: number,
): Promise<BarrierResult> {
  if (keys.length === 0) return { applied: true, laggards: [] };
  try {
    const res = await ch.unary<
      { keys: WireKey[]; min_revisions: string[]; timeout: { seconds: string; nanos: number } },
      { applied?: boolean; laggards?: WireLaggard[] }
    >(
      SVC,
      'AwaitSchemaApplied',
      {
        keys: keys.map(({ key }) => ({ kind: key.kind, group: key.group, name: key.name })),
        min_revisions: keys.map(({ minRevision }) => minRevision),
        timeout: duration(timeoutMs),
      },
      timeoutMs + 5_000,
    );
    return { applied: res.applied === true, laggards: toLaggards(res.laggards) };
  } catch (err) {
    if (isUnimplemented(err)) return { applied: false, laggards: [], unimplemented: true };
    // A genuine NOT_FOUND means the schema is absent, which a caller must not
    // mistake for "this server is too old to tell me".
    throw err;
  }
}

function isUnimplemented(err: unknown): boolean {
  return err instanceof BanyanDBError && err.grpcCode === GrpcStatus.UNIMPLEMENTED;
}

/** The coarser form: wait until every node's watermark passes one revision,
 *  without naming which keys it should cover. */
export async function awaitRevisionApplied(
  ch: BanyanDBChannel,
  minRevision: ModRevision,
  timeoutMs: number,
): Promise<BarrierResult> {
  try {
    const res = await ch.unary<
      { min_revision: string; timeout: { seconds: string; nanos: number } },
      { applied?: boolean; laggards?: WireLaggard[] }
    >(SVC, 'AwaitRevisionApplied', { min_revision: minRevision, timeout: duration(timeoutMs) }, timeoutMs + 5_000);
    return { applied: res.applied === true, laggards: toLaggards(res.laggards) };
  } catch (err) {
    if (isUnimplemented(err)) return { applied: false, laggards: [], unimplemented: true };
    throw err;
  }
}
