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
import type { FieldType, TagType } from './values.js';

/**
 * How a caller declares what it wants to exist in BanyanDB.
 *
 * These are the shapes a store writes its schema against; nothing here knows
 * what is stored. Each converts to the proto the registries take.
 */

export type Catalog = 'CATALOG_STREAM' | 'CATALOG_MEASURE';
export type IntervalUnit = 'UNIT_HOUR' | 'UNIT_DAY';

export interface IntervalDef {
  unit: IntervalUnit;
  num: number;
}

/**
 * A group is the container that carries retention and sharding, and its
 * catalog is fixed: a measure placed in a stream group is never loaded by the
 * data node, and every write to it fails with the resource reported missing.
 * Stream resources and measure resources therefore need separate groups.
 */
export interface GroupDef {
  name: string;
  catalog: Catalog;
  shardNum: number;
  segmentInterval: IntervalDef;
  ttl: IntervalDef;
  /** Defaults to 0 on the server — no replica unless asked for. Always sent,
   *  because an update is a full replace and omitting it resets it. */
  replicas: number;
  /**
   * Lifecycle tiering. BanyanDB has no global setting for this: stages are a
   * property of each group, so a deployment wanting hot/warm/cold has to
   * declare them on every group it owns.
   *
   * Omit for a hot-only group. Present here so a caller CAN express tiering —
   * an update replaces the whole resource, so a group whose stages this client
   * could not represent would have them erased by an unrelated TTL change.
   */
  stages?: banyandb.common.v1.LifecycleStage[];
  defaultStages?: string[];
}

export interface TagDef {
  name: string;
  type: TagType;
}

export interface FamilyDef {
  name: string;
  tags: TagDef[];
}

export interface FieldDef {
  name: string;
  type: FieldType;
  encoding: banyandb.database.v1.EncodingMethod;
  /** Validated as a defined enum value, so a real method must be chosen. */
  compression: banyandb.database.v1.CompressionMethod;
}

interface ResourceDef {
  group: string;
  name: string;
  families: FamilyDef[];
  /**
   * The series key. The server hashes these tag VALUES to place a row, and the
   * list is immutable for the resource's life.
   *
   * A name here that matches no declared tag is silently skipped rather than
   * rejected, which shortens the key and collapses rows that should have been
   * distinct — so it is checked before the schema is sent, not after.
   */
  entity: string[];
}

export type StreamDef = ResourceDef;

export interface MeasureDef extends ResourceDef {
  fields: FieldDef[];
  /** Must be a subset of `entity`, in the same relative order. */
  shardingKey?: string[];
  /** Single unit only. Frozen once the measure exists. */
  interval?: string;
  /**
   * Index-only storage — data lives in the index and not in the data files.
   * Always SENT, never left to the server's default: a measure update replaces
   * the whole resource, so an unsent value is reset rather than retained, and
   * this one is frozen once the measure exists.
   */
  indexMode?: boolean;
}

export interface IndexRuleDef {
  group: string;
  /** Identity is `(group, name)` — group-global, not scoped to a resource, so
   *  two resources in one group indexing a same-named tag share one rule. */
  name: string;
  tags: string[];
  type: banyandb.database.v1.IndexRule.Type;
  /** `keyword` is the no-op analyzer that makes equality mean equality. */
  analyzer?: string;
  noSort?: boolean;
}

export interface IndexRuleBindingDef {
  group: string;
  name: string;
  rules: string[];
  subject: { name: string; catalog: Catalog };
  beginAt: Date;
  expireAt: Date;
}

/**
 * Whether the sharding key is an ordered subset of the entity, which the
 * server requires. Returns the reason it is not, or null.
 */
export function shardingKeyProblem(def: MeasureDef): string | null {
  if (!def.shardingKey) return null;
  const positions = def.shardingKey.map((n) => def.entity.indexOf(n));
  const absent = def.shardingKey.filter((_, i) => positions[i] === -1);
  if (absent.length > 0) return `sharding key names ${absent.join(', ')}, which the entity does not`;
  const ordered = positions.every((p, i) => i === 0 || p > (positions[i - 1] ?? -1));
  return ordered ? null : 'sharding key is not in the same relative order as the entity';
}

/** Names a tag that no family declares — the mistake the server accepts. */
export function undeclaredEntityTags(def: ResourceDef): string[] {
  const declared = new Set(def.families.flatMap((f) => f.tags.map((t) => t.name)));
  return def.entity.filter((name) => !declared.has(name));
}

function toTagFamilies(families: FamilyDef[]): banyandb.database.v1.TagFamilySpec[] {
  return families.map((f) => ({
    name: f.name,
    tags: f.tags.map((t) => ({ name: t.name, type: t.type })),
  }));
}

function pbTime(d: Date): { seconds: string; nanos: number } {
  const ms = d.getTime();
  return { seconds: String(Math.floor(ms / 1000)), nanos: (ms % 1000) * 1_000_000 };
}

export function toGroupProto(def: GroupDef): banyandb.common.v1.Group {
  return {
    metadata: { name: def.name },
    catalog: def.catalog,
    resource_opts: {
      shard_num: def.shardNum,
      segment_interval: { unit: def.segmentInterval.unit, num: def.segmentInterval.num },
      ttl: { unit: def.ttl.unit, num: def.ttl.num },
      replicas: def.replicas,
      ...(def.stages ? { stages: def.stages } : {}),
      ...(def.defaultStages ? { default_stages: def.defaultStages } : {}),
    },
  };
}

export function toStreamProto(def: StreamDef): banyandb.database.v1.Stream {
  return {
    metadata: { group: def.group, name: def.name },
    tag_families: toTagFamilies(def.families),
    entity: { tag_names: def.entity },
  };
}

export function toMeasureProto(def: MeasureDef): banyandb.database.v1.Measure {
  return {
    metadata: { group: def.group, name: def.name },
    tag_families: toTagFamilies(def.families),
    entity: { tag_names: def.entity },
    fields: def.fields.map((f) => ({
      name: f.name,
      field_type: f.type,
      encoding_method: f.encoding,
      compression_method: f.compression,
    })),
    ...(def.shardingKey ? { sharding_key: { tag_names: def.shardingKey } } : {}),
    ...(def.interval ? { interval: def.interval } : {}),
    index_mode: def.indexMode ?? false,
  };
}

export function toIndexRuleProto(def: IndexRuleDef): banyandb.database.v1.IndexRule {
  return {
    metadata: { group: def.group, name: def.name },
    tags: def.tags,
    type: def.type,
    ...(def.analyzer ? { analyzer: def.analyzer } : {}),
    ...(def.noSort === undefined ? {} : { no_sort: def.noSort }),
  };
}

export function toIndexRuleBindingProto(
  def: IndexRuleBindingDef,
): banyandb.database.v1.IndexRuleBinding {
  return {
    metadata: { group: def.group, name: def.name },
    rules: def.rules,
    subject: { name: def.subject.name, catalog: def.subject.catalog },
    begin_at: pbTime(def.beginAt),
    expire_at: pbTime(def.expireAt),
  };
}
