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

import type { banyandb } from './proto.pb.js';
import type { BanyanDBChannel } from './channel.js';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { BanyanDBError } from './errors.js';

/**
 * The schema registries, as thin wrappers over the generated services.
 *
 * A server wall-clock nanosecond stamp, not an etcd revision — the proto
 * comment says otherwise and is stale. Kept as a string and compared with
 * `BigInt`: as a number it loses precision above 2^53.
 */
export type ModRevision = string;

const DB = 'banyandb.database.v1';

/** Create is not idempotent and there is no server-side "if not exists", so a
 *  racing replica is resolved here rather than by a lock. Matched on the status
 *  code: the `invalid` bucket also holds INVALID_ARGUMENT, and swallowing one
 *  of those would report `unchanged` with a zero revision that the barrier then
 *  treats as already satisfied. */
function isAlreadyExists(err: unknown): boolean {
  return err instanceof BanyanDBError && err.grpcCode === GrpcStatus.ALREADY_EXISTS;
}

/**
 * One registry, for the four resources whose request shapes are identical:
 * every method takes a single payload field, and Get/Exist take a Metadata.
 * Group is not one of them — see `GroupRegistry`.
 */
class Registry<T extends { metadata?: banyandb.common.v1.Metadata }> {
  constructor(
    private readonly ch: BanyanDBChannel,
    private readonly service: string,
    /** The request/response field carrying the resource, e.g. `stream`. */
    private readonly field: string,
  ) {}

  async create(resource: T): Promise<ModRevision> {
    const res = await this.ch.unary<Record<string, unknown>, { mod_revision?: string }>(
      this.service,
      'Create',
      { [this.field]: resource },
    );
    return res.mod_revision ?? '0';
  }

  /** `true` if this call created it, `false` if someone else won the race. */
  async createIfAbsent(resource: T): Promise<{ created: boolean; modRevision: ModRevision }> {
    try {
      return { created: true, modRevision: await this.create(resource) };
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      const live = await this.get(resource.metadata?.group ?? '', resource.metadata?.name ?? '');
      return { created: false, modRevision: live?.metadata?.mod_revision ?? '0' };
    }
  }

  /** A full replace, never a merge: a field left unset is reset, not retained. */
  async update(resource: T): Promise<ModRevision> {
    const res = await this.ch.unary<Record<string, unknown>, { mod_revision?: string }>(
      this.service,
      'Update',
      { [this.field]: resource },
    );
    return res.mod_revision ?? '0';
  }

  async get(group: string, name: string): Promise<T | null> {
    try {
      const res = await this.ch.unary<
        { metadata: banyandb.common.v1.Metadata },
        Record<string, T | undefined>
      >(this.service, 'Get', { metadata: { group, name } });
      return res[this.field] ?? null;
    } catch (err) {
      if (err instanceof BanyanDBError && err.code === 'not_found') return null;
      throw err;
    }
  }

  async delete_(group: string, name: string): Promise<void> {
    await this.ch.unary(this.service, 'Delete', { metadata: { group, name } });
  }
}

/**
 * Groups are hand-written because their request shapes genuinely differ: Get
 * and Exist take a bare `group` string rather than a Metadata, and Delete
 * carries its own flags.
 */
export class GroupRegistry {
  constructor(private readonly ch: BanyanDBChannel) {}

  async create(group: banyandb.common.v1.Group): Promise<ModRevision> {
    const res = await this.ch.unary<{ group: banyandb.common.v1.Group }, { mod_revision?: string }>(
      `${DB}.GroupRegistryService`,
      'Create',
      { group },
    );
    return res.mod_revision ?? '0';
  }

  async createIfAbsent(
    group: banyandb.common.v1.Group,
  ): Promise<{ created: boolean; modRevision: ModRevision }> {
    try {
      return { created: true, modRevision: await this.create(group) };
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      const live = await this.get(group.metadata?.name ?? '');
      return { created: false, modRevision: live?.metadata?.mod_revision ?? '0' };
    }
  }

  async update(group: banyandb.common.v1.Group): Promise<ModRevision> {
    const res = await this.ch.unary<{ group: banyandb.common.v1.Group }, { mod_revision?: string }>(
      `${DB}.GroupRegistryService`,
      'Update',
      { group },
    );
    return res.mod_revision ?? '0';
  }

  async get(name: string): Promise<banyandb.common.v1.Group | null> {
    try {
      const res = await this.ch.unary<{ group: string }, { group?: banyandb.common.v1.Group }>(
        `${DB}.GroupRegistryService`,
        'Get',
        { group: name },
      );
      return res.group ?? null;
    } catch (err) {
      if (err instanceof BanyanDBError && err.code === 'not_found') return null;
      throw err;
    }
  }

  async list(): Promise<banyandb.common.v1.Group[]> {
    const res = await this.ch.unary<Record<string, never>, { group?: banyandb.common.v1.Group[] }>(
      `${DB}.GroupRegistryService`,
      'List',
      {},
    );
    return res.group ?? [];
  }
}

export const streamRegistry = (ch: BanyanDBChannel) =>
  new Registry<banyandb.database.v1.Stream>(ch, `${DB}.StreamRegistryService`, 'stream');
export const measureRegistry = (ch: BanyanDBChannel) =>
  new Registry<banyandb.database.v1.Measure>(ch, `${DB}.MeasureRegistryService`, 'measure');
export const indexRuleRegistry = (ch: BanyanDBChannel) =>
  new Registry<banyandb.database.v1.IndexRule>(ch, `${DB}.IndexRuleRegistryService`, 'index_rule');
export const indexRuleBindingRegistry = (ch: BanyanDBChannel) =>
  new Registry<banyandb.database.v1.IndexRuleBinding>(
    ch,
    `${DB}.IndexRuleBindingRegistryService`,
    'index_rule_binding',
  );

export type { Registry };
