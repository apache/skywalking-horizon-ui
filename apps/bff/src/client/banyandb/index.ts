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
 * A BanyanDB client for Node.
 *
 * A wrapper over the generated gRPC services, in BanyanDB's own vocabulary:
 * groups and their retention, streams and measures, tag families, entities,
 * index rules and their bindings, mod revisions, the schema barrier. It knows
 * nothing about what is stored in it — deciding which resources exist, and
 * what they mean, belongs to the caller.
 *
 * Measure and Stream only. Property, Trace, TopN and the query language are
 * not wrapped.
 */

import { BanyanDBChannel, type BanyanDBOptions } from './channel.js';
import {
  GroupRegistry,
  indexRuleBindingRegistry,
  indexRuleRegistry,
  measureRegistry,
  streamRegistry,
} from './registry.js';
import { awaitRevisionApplied, awaitSchemaApplied } from './barrier.js';
import { SchemaManager } from './schema-manager.js';
import type { MeasureDef, StreamDef } from './schema.js';
import { queryMeasure, queryStream } from './query.js';
import { sendBatch, createMessageIds } from './write.js';
import { toMeasureWriteRequests, toStreamWriteRequests, type MeasureRow, type StreamRow } from './rows.js';
import type { MeasureQuery, StreamQuery } from './query.js';
import type { ModRevision } from './registry.js';
import type { SchemaKey } from './barrier.js';

export class BanyanDBClient {
  private readonly ch: BanyanDBChannel;
  readonly nextMessageId = createMessageIds();

  constructor(opts: BanyanDBOptions) {
    this.ch = new BanyanDBChannel(opts);
    this.schema = new SchemaManager(this.ch);
  }

  readonly channel = (): BanyanDBChannel => this.ch;

  async connect(): Promise<void> {
    await this.ch.connect();
  }

  close(): void {
    this.ch.close();
  }

  get groups(): GroupRegistry {
    return new GroupRegistry(this.ch);
  }
  get streams() {
    return streamRegistry(this.ch);
  }
  get measures() {
    return measureRegistry(this.ch);
  }
  get indexRules() {
    return indexRuleRegistry(this.ch);
  }
  get indexRuleBindings() {
    return indexRuleBindingRegistry(this.ch);
  }

  /** Create or update the declared schema, one resource at a time. */
  readonly schema: SchemaManager;

  awaitSchemaApplied = (keys: readonly { key: SchemaKey; minRevision: ModRevision }[], timeoutMs: number) =>
    awaitSchemaApplied(this.ch, keys, timeoutMs);
  awaitRevisionApplied = (minRevision: ModRevision, timeoutMs: number) =>
    awaitRevisionApplied(this.ch, minRevision, timeoutMs);

  queryStream = (q: StreamQuery, deadlineMs?: number) => queryStream(this.ch, q, deadlineMs);
  queryMeasure = (q: MeasureQuery, deadlineMs?: number) => queryMeasure(this.ch, q, deadlineMs);

  /**
   * Append rows to a stream, one short-lived gRPC stream per batch.
   *
   * A stream is append-only: nothing collapses on series and timestamp, so two
   * rows sharing both are two rows. The only de-duplication is `elementId`,
   * which makes re-sending a batch after an uncertain outcome safe.
   */
  insertStream = (def: StreamDef, rows: readonly StreamRow[], deadlineMs?: number) =>
    sendBatch(
      this.ch,
      'banyandb.stream.v1.StreamService',
      toStreamWriteRequests(def, rows, this.nextMessageId),
      deadlineMs,
    );

  /**
   * Write rows to a measure. There is no separate update: a write IS an
   * upsert, and rows sharing a series and a timestamp collapse to the one with
   * the higher `version`. That is why a measure — and never a stream — is what
   * carries a value meant to be corrected in place.
   */
  writeMeasure = (def: MeasureDef, rows: readonly MeasureRow[], deadlineMs?: number) =>
    sendBatch(
      this.ch,
      'banyandb.measure.v1.MeasureService',
      toMeasureWriteRequests(def, rows, this.nextMessageId),
      deadlineMs,
    );

  /** Escape hatch for a caller assembling its own requests. */
  sendBatch = <Req extends { message_id: string }>(
    service: string,
    reqs: readonly Req[],
    deadlineMs?: number,
  ) => sendBatch(this.ch, service, reqs, deadlineMs);
}

export { BanyanDBChannel, type BanyanDBOptions } from './channel.js';
export { BanyanDBError, type BanyanDBErrorCode } from './errors.js';
export { SchemaManager, SchemaConflictError, type Drift, type SchemaChange, type SchemaAction } from './schema-manager.js';
export * from './schema.js';
export * from './values.js';
export * from './status.js';
export { and, or, eq, ne, lt, gt, le, ge, in_ } from './query.js';
export type { StreamQuery, MeasureQuery, StreamElement, MeasureDataPoint, TimeRange } from './query.js';
export type { WriteOutcome } from './write.js';
export type { StreamRow, MeasureRow } from './rows.js';
export type { ModRevision } from './registry.js';
export type { SchemaKey, BarrierResult, NodeLaggard } from './barrier.js';
