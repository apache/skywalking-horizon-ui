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
import type { MeasureDef, StreamDef } from './schema.js';
import { int64Value, pbTimestamp, tagValue, fieldValue, type TagInput } from './values.js';

/**
 * Building write requests from a schema definition.
 *
 * Two rules govern everything here, and both fail SILENTLY when broken.
 *
 * Values are positional within a tag family, and the families are positional
 * too — the wire carries no names, only the order the spec declares. So the
 * definition, not the caller's object, decides what goes where.
 *
 * And the spec travels on the FIRST message of every stream, where the server
 * latches it. Without one it matches tags positionally against whatever schema
 * it has stored, padding a short list with nulls — so a tag added anywhere but
 * the end shifts every column after it, with no error on either side.
 */

/** A row for an append-only stream. */
export interface StreamRow {
  timestampMs: number;
  /**
   * A write-side idempotency key: the server hashes it, so re-sending the same
   * value collapses rather than duplicating. It is NOT readable — the query
   * path returns the hash — so identity that must survive the round trip
   * belongs in a tag.
   */
  elementId: string;
  /** By tag name; encoded using the type the definition declares. */
  tags: Record<string, TagInput>;
}

/** A row for a measure, where a write is an upsert. */
export interface MeasureRow {
  timestampMs: number;
  tags: Record<string, TagInput>;
  fields: Record<string, TagInput>;
  /**
   * Which write wins when two share a series and a timestamp — the merge keeps
   * the HIGHER version. Left unset the server substitutes the message id,
   * which is time-derived and so usually right; set it explicitly whenever a
   * correction must beat the row it replaces.
   */
  version?: string;
}

function familiesForWrite(
  families: StreamDef['families'],
  tags: Record<string, TagInput>,
): banyandb.model.v1.TagFamilyForWrite[] {
  return families.map((family) => ({
    tags: family.tags.map((tag) => tagValue(tag.type, tags[tag.name], tag.name)),
  }));
}

/**
 * An entity value may not be absent.
 *
 * Every other tag can legitimately be null. These cannot: they ARE the series,
 * and a missing one is encoded as NULL and hashed like any other value — so
 * two rows that should belong to different series collapse into one, silently,
 * and the write still succeeds. The sharding key has the same problem for the
 * same reason.
 */
function requireKeyValues(
  def: { entity: string[]; shardingKey?: string[]; group: string; name: string },
  tags: Record<string, TagInput>,
): void {
  const keys = new Set([...def.entity, ...(def.shardingKey ?? [])]);
  const missing = [...keys].filter((name) => tags[name] === undefined || tags[name] === null);
  if (missing.length > 0) {
    throw new TypeError(
      `${def.group}/${def.name}: no value for ${missing.join(', ')} — an entity or sharding-key tag ` +
        'cannot be absent, or rows of different series collapse into one',
    );
  }
}

/**
 * The WRITE spec, which is NOT the schema spec.
 *
 * Three different messages are called `TagFamilySpec`. The registry takes
 * `database.v1`, carrying full `TagSpec`s with names and types. Both write
 * paths take their own — `stream.v1` and `measure.v1` — carrying only
 * `tag_names`, because the types already live in the stored schema.
 *
 * Sending the registry's shape here costs nothing at the wire level and
 * everything at the server: `tags` is an unknown field and is dropped, so the
 * spec arrives with an EMPTY name list, every tag resolves to NULL, and the
 * row's series becomes `hash(subject + NULL)` rather than its real key. The
 * write still returns STATUS_SUCCEED and the element still lands on disk —
 * it simply can never be found again.
 */
function writeTagFamilySpec(families: StreamDef['families']): banyandb.stream.v1.TagFamilySpec[] {
  return families.map((f) => ({ name: f.name, tag_names: f.tags.map((t) => t.name) }));
}

// Derived from the GENERATED request types rather than restated. Hand-written
// copies are what let the wrong `TagFamilySpec` through `tsc` in the first
// place; deriving them means the compiler checks against the real contract.
export type StreamWriteRequest = banyandb.stream.v1.WriteRequest & { message_id: string };
export type MeasureWriteRequest = banyandb.measure.v1.WriteRequest & { message_id: string };

export function toStreamWriteRequests(
  def: StreamDef,
  rows: readonly StreamRow[],
  nextMessageId: () => string,
): StreamWriteRequest[] {
  const metadata = { group: def.group, name: def.name };
  const spec = writeTagFamilySpec(def.families);
  for (const row of rows) {
    requireKeyValues(def, row.tags);
    // An empty id is not "no id": the server mints a fresh one per write, so
    // the dedup that makes a retry safe silently stops working and a re-sent
    // batch duplicates every row.
    if (!row.elementId) {
      throw new TypeError(`${def.group}/${def.name}: elementId is empty — a retry would duplicate the row`);
    }
  }
  return rows.map((row, i) => ({
    // Both are latched on the first message and apply to the rest of the
    // stream; a reconnect starts a new stream and must send them again.
    ...(i === 0 ? { metadata, tag_family_spec: spec } : {}),
    element: {
      element_id: row.elementId,
      timestamp: pbTimestamp(row.timestampMs),
      tag_families: familiesForWrite(def.families, row.tags),
    },
    message_id: nextMessageId(),
  }));
}

export function toMeasureWriteRequests(
  def: MeasureDef,
  rows: readonly MeasureRow[],
  nextMessageId: () => string,
): MeasureWriteRequest[] {
  const metadata = { group: def.group, name: def.name };
  // The spec carries field NAMES only — types, encoding and compression stay
  // in the stored schema. Order still matters: `fields` below is emitted in
  // the same order these names are.
  const spec: banyandb.measure.v1.DataPointSpec = {
    tag_family_spec: writeTagFamilySpec(def.families),
    field_names: def.fields.map((f) => f.name),
  };
  for (const row of rows) requireKeyValues(def, row.tags);
  return rows.map((row, i) => ({
    ...(i === 0 ? { metadata, data_point_spec: spec } : {}),
    data_point: {
      timestamp: pbTimestamp(row.timestampMs),
      tag_families: familiesForWrite(def.families, row.tags),
      fields: def.fields.map((f) => fieldValue(f.type, row.fields[f.name], f.name)),
      // Validated like any other 64-bit value: this one decides which write
      // WINS, so a silently truncated or wrapped version loses to the row it
      // was meant to replace.
      ...(row.version ? { version: int64Value(row.version, 'version') } : {}),
    },
    message_id: nextMessageId(),
  }));
}
