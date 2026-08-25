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

import type { banyandb, google } from './proto.pb.js';

/**
 * Encoding and decoding of BanyanDB tag and field values.
 *
 * A `TagValue` is a oneof, and the server picks the arm to read by the tag's
 * DECLARED type in the schema — not by what arrived. If the arm and the
 * declared type disagree it stores NULL and still reports success, so every
 * encoder here takes the declared type as its first argument rather than
 * inferring one from the JavaScript value.
 */

/**
 * The tag types this client supports.
 *
 * `TAG_TYPE_TIMESTAMP` is deliberately absent. The measure and stream write
 * paths have no branch for it and reach a panic in the data node, and nothing
 * rejects it when the schema is created — so the type is unusable rather than
 * merely unused. Carry a time as an INT of epoch milliseconds, or as the
 * element's own timestamp.
 */
export type TagType = Exclude<
  banyandb.database.v1.TagType,
  'TAG_TYPE_UNSPECIFIED' | 'TAG_TYPE_TIMESTAMP'
>;

export type FieldType = Exclude<banyandb.database.v1.FieldType, 'FIELD_TYPE_UNSPECIFIED'>;

/** What a caller may hand over for a tag. `null` and `undefined` both mean
 *  "absent", which on this wire is an explicit NULL arm, not an omitted field. */
export type TagInput = string | number | bigint | readonly string[] | readonly number[] | Buffer | null | undefined;

export type TagOutput = string | number | string[] | Buffer | null;

type TagValue = banyandb.model.v1.TagValue;
type FieldValue = banyandb.model.v1.FieldValue;

const NULL_TAG: TagValue = { null: 'NULL_VALUE' };

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * 64-bit integers cross the wire as decimal strings (`longs: String`), and
 * every way of getting one wrong is silent.
 *
 * The serializer does not validate: `"abc"` is written as 0, `"12.5"` as 12,
 * and 2^63 wraps to its own negative. A `number` above 2^53 has already lost
 * precision before it arrives. So the value is parsed and range-checked here,
 * where the caller still has a stack to blame, rather than becoming a
 * plausible-looking wrong number in storage.
 */
function int64(v: string | number | bigint, what: string): string {
  let n: bigint;
  if (typeof v === 'bigint') {
    n = v;
  } else if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) {
      throw new RangeError(`${what}: ${v} is not a safe integer — pass a bigint or a decimal string`);
    }
    n = BigInt(v);
  } else {
    if (!/^-?\d+$/.test(v)) {
      throw new TypeError(`${what}: ${JSON.stringify(v)} is not a decimal integer`);
    }
    n = BigInt(v);
  }
  if (n < INT64_MIN || n > INT64_MAX) {
    throw new RangeError(`${what}: ${n} is outside the signed 64-bit range`);
  }
  return n.toString();
}

export function tagValue(type: TagType, v: TagInput, name = 'tag'): TagValue {
  if (v === null || v === undefined) return NULL_TAG;
  switch (type) {
    case 'TAG_TYPE_STRING':
      return { str: { value: String(v) } };
    case 'TAG_TYPE_INT':
      return { int: { value: int64(v as string | number | bigint, name) } };
    case 'TAG_TYPE_STRING_ARRAY':
      return { str_array: { value: (v as readonly unknown[]).map(String) } };
    case 'TAG_TYPE_INT_ARRAY':
      return {
        int_array: { value: (v as readonly (string | number | bigint)[]).map((n) => int64(n, name)) },
      };
    case 'TAG_TYPE_DATA_BINARY':
      return { binary_data: v as Buffer };
  }
}

/**
 * Read a decoded tag back.
 *
 * The oneof discriminator is itself called `value`, and so is each arm's
 * payload wrapper — a decoded string tag reads `t.value === 'str'` and
 * `t.str.value === '…'`. Switching on the discriminator rather than probing
 * the arms is what keeps that straight, and it is also the only way to tell an
 * explicit NULL from an arm that simply decoded empty.
 */
export function decodeTagValue(tv: TagValue | null | undefined): TagOutput {
  if (!tv) return null;
  switch (tv.value) {
    case 'str':
      return tv.str?.value ?? null;
    case 'int':
      return tv.int?.value ?? null;
    case 'str_array':
      return tv.str_array?.value ?? [];
    case 'int_array':
      return tv.int_array?.value ?? [];
    case 'binary_data':
      return tv.binary_data ?? null;
    case 'null':
    default:
      return null;
  }
}

export function fieldValue(type: FieldType, v: TagInput, name = 'field'): FieldValue {
  if (v === null || v === undefined) return { null: 'NULL_VALUE' };
  switch (type) {
    case 'FIELD_TYPE_STRING':
      return { str: { value: String(v) } };
    case 'FIELD_TYPE_INT':
      return { int: { value: int64(v as string | number | bigint, name) } };
    case 'FIELD_TYPE_FLOAT':
      return { float: { value: Number(v) } };
    case 'FIELD_TYPE_DATA_BINARY':
      return { binary_data: v as Buffer };
  }
}

export function decodeFieldValue(fv: FieldValue | null | undefined): TagOutput {
  if (!fv) return null;
  switch (fv.value) {
    case 'str':
      return fv.str?.value ?? null;
    case 'int':
      return fv.int?.value ?? null;
    case 'float':
      return fv.float?.value ?? null;
    case 'binary_data':
      return fv.binary_data ?? null;
    case 'null':
    default:
      return null;
  }
}

/** Read one tag family back as a plain object keyed by tag name. */
export function decodeTagFamily(family: banyandb.model.v1.TagFamily): Record<string, TagOutput> {
  const out: Record<string, TagOutput> = {};
  for (const tag of family.tags ?? []) {
    if (tag.key) out[tag.key] = decodeTagValue(tag.value);
  }
  return out;
}

/**
 * Whole milliseconds only. The server rejects any nanos that is not a multiple
 * of a million — on a write as an invalid-timestamp status, on a query as an
 * argument error — so a sub-millisecond instant must be rounded by the caller
 * rather than silently truncated here.
 */
export function pbTimestamp(epochMs: number): google.protobuf.Timestamp {
  if (!Number.isInteger(epochMs)) {
    throw new RangeError(`timestamp must be whole milliseconds, got ${epochMs}`);
  }
  return { seconds: String(Math.floor(epochMs / 1000)), nanos: (epochMs % 1000) * 1_000_000 };
}

export function fromPbTimestamp(ts: google.protobuf.Timestamp | null | undefined): number {
  if (!ts) return 0;
  return Number(ts.seconds ?? '0') * 1000 + Math.floor((ts.nanos ?? 0) / 1_000_000);
}
