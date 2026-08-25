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
import { BanyanDBError } from './errors.js';
import { decodeTagFamily, decodeFieldValue, fromPbTimestamp, pbTimestamp, tagValue, type TagInput, type TagOutput, type TagType } from './values.js';

type Criteria = banyandb.model.v1.Criteria;
type BinaryOp = banyandb.model.v1.Condition.BinaryOp;

/**
 * Query building and decoding.
 *
 * The defaults here are not conveniences — each replaces a server behaviour
 * that fails quietly. `limit` unset is not "no limit" but 20 on a stream and
 * 100 on a measure; a stream query without a projection is refused outright;
 * and an empty `criteria` object matches neither arm of its oneof and errors,
 * where OMITTING the field is what means "no filter".
 */

/** Both edges are INCLUSIVE, on stream and measure alike — the proto comment
 *  describing a half-open range is stale. A caller with an exclusive upper
 *  bound must subtract a millisecond before calling. */
export interface TimeRange {
  beginMs: number;
  endMs: number;
}

export interface StreamQuery {
  group: string;
  name: string;
  timeRange: TimeRange;
  /** Required by the server. */
  projection: { family: string; tags: string[] }[];
  criteria?: Criteria;
  limit: number;
  offset?: number;
  /** An empty rule name with a sort orders by TIMESTAMP and needs no index
   *  rule at all. A named rule must be bound to this subject. */
  orderBy?: { indexRuleName?: string; sort: 'SORT_ASC' | 'SORT_DESC' };
  /**
   * Which lifecycle stages to read. Omitted means the group's default stages,
   * which is what an ordinary query wants; naming them is how a caller reaches
   * data that has already aged into a warm or cold tier.
   */
  stages?: string[];
}

export interface MeasureQuery extends Omit<StreamQuery, 'projection'> {
  projection?: { family: string; tags: string[] }[];
  fieldProjection?: string[];
}

export interface StreamElement {
  /** Hashed by the server and returned as hex — never the string that was
   *  written. Use a tag for identity that must survive the round trip. */
  elementId: string;
  timestampMs: number;
  tags: Record<string, TagOutput>;
}

export interface MeasureDataPoint {
  timestampMs: number;
  tags: Record<string, TagOutput>;
  fields: Record<string, TagOutput>;
}

function condition(name: string, op: BinaryOp, type: TagType, value: TagInput): Criteria {
  return { condition: { name, op, value: tagValue(type, value, name) } };
}

export const eq = (n: string, t: TagType, v: TagInput): Criteria => condition(n, 'BINARY_OP_EQ', t, v);
export const ne = (n: string, t: TagType, v: TagInput): Criteria => condition(n, 'BINARY_OP_NE', t, v);
export const lt = (n: string, t: TagType, v: TagInput): Criteria => condition(n, 'BINARY_OP_LT', t, v);
export const gt = (n: string, t: TagType, v: TagInput): Criteria => condition(n, 'BINARY_OP_GT', t, v);
export const le = (n: string, t: TagType, v: TagInput): Criteria => condition(n, 'BINARY_OP_LE', t, v);
export const ge = (n: string, t: TagType, v: TagInput): Criteria => condition(n, 'BINARY_OP_GE', t, v);
/**
 * Membership. On an entity tag this and `eq` are the only operators accepted.
 *
 * The value must go in an ARRAY arm — a scalar arm would stringify the list to
 * `a,b` and match nothing, with no error from either side. So the tag's own
 * type is widened to its array form here rather than taken as given.
 */
export const in_ = (n: string, t: TagType, v: readonly string[] | readonly number[]): Criteria => {
  const arrayType: TagType =
    t === 'TAG_TYPE_INT' || t === 'TAG_TYPE_INT_ARRAY' ? 'TAG_TYPE_INT_ARRAY' : 'TAG_TYPE_STRING_ARRAY';
  return condition(n, 'BINARY_OP_IN', arrayType, v);
};

/** There is no repeated form: an N-term expression is a nested binary tree.
 *  `undefined` for an empty list, because the field must then be omitted. */
function fold(op: banyandb.model.v1.LogicalExpression.LogicalOp, parts: (Criteria | undefined)[]): Criteria | undefined {
  const kept = parts.filter((c): c is Criteria => c !== undefined);
  if (kept.length === 0) return undefined;
  return kept.reduce((left, right) => ({ le: { op, left, right } }));
}

export const and = (...parts: (Criteria | undefined)[]): Criteria | undefined =>
  fold('LOGICAL_OP_AND', parts);
export const or = (...parts: (Criteria | undefined)[]): Criteria | undefined =>
  fold('LOGICAL_OP_OR', parts);

function timeRange(r: TimeRange): banyandb.model.v1.TimeRange {
  return { begin: pbTimestamp(r.beginMs), end: pbTimestamp(r.endMs) };
}

function projection(p: { family: string; tags: string[] }[]): banyandb.model.v1.TagProjection {
  return { tag_families: p.map((f) => ({ name: f.family, tags: f.tags })) };
}

/** A gated query answers SUCCESS with zero rows, so an unreported group status
 *  reads as "nothing happened" — the one failure that must never be silent. */
function assertGroups(statuses: Record<string, string> | undefined, what: string): void {
  for (const [group, status] of Object.entries(statuses ?? {})) {
    if (status !== 'STATUS_SUCCEED') {
      throw new BanyanDBError('rejected', `${what}: group ${group} returned ${status}`);
    }
  }
}

export async function queryStream(
  ch: BanyanDBChannel,
  q: StreamQuery,
  deadlineMs?: number,
): Promise<StreamElement[]> {
  const res = await ch.unary<
    Record<string, unknown>,
    { elements?: banyandb.stream.v1.Element[]; group_statuses?: Record<string, string> }
  >(
    'banyandb.stream.v1.StreamService',
    'Query',
    {
      groups: [q.group],
      name: q.name,
      time_range: timeRange(q.timeRange),
      projection: projection(q.projection),
      limit: q.limit,
      ...(q.offset ? { offset: q.offset } : {}),
      ...(q.criteria ? { criteria: q.criteria } : {}),
      ...(q.orderBy
        ? { order_by: { index_rule_name: q.orderBy.indexRuleName ?? '', sort: q.orderBy.sort } }
        : {}),
      ...(q.stages?.length ? { stages: q.stages } : {}),
    },
    deadlineMs,
  );
  assertGroups(res.group_statuses, `stream ${q.group}/${q.name}`);
  return (res.elements ?? []).map((el) => ({
    elementId: el.element_id ?? '',
    timestampMs: fromPbTimestamp(el.timestamp),
    tags: Object.assign({}, ...(el.tag_families ?? []).map(decodeTagFamily)) as Record<string, TagOutput>,
  }));
}

export async function queryMeasure(
  ch: BanyanDBChannel,
  q: MeasureQuery,
  deadlineMs?: number,
): Promise<MeasureDataPoint[]> {
  const res = await ch.unary<
    Record<string, unknown>,
    { data_points?: banyandb.measure.v1.DataPoint[]; group_statuses?: Record<string, string> }
  >(
    'banyandb.measure.v1.MeasureService',
    'Query',
    {
      groups: [q.group],
      name: q.name,
      time_range: timeRange(q.timeRange),
      limit: q.limit,
      ...(q.offset ? { offset: q.offset } : {}),
      ...(q.projection ? { tag_projection: projection(q.projection) } : {}),
      ...(q.fieldProjection ? { field_projection: { names: q.fieldProjection } } : {}),
      ...(q.criteria ? { criteria: q.criteria } : {}),
      ...(q.orderBy
        ? { order_by: { index_rule_name: q.orderBy.indexRuleName ?? '', sort: q.orderBy.sort } }
        : {}),
      ...(q.stages?.length ? { stages: q.stages } : {}),
    },
    deadlineMs,
  );
  assertGroups(res.group_statuses, `measure ${q.group}/${q.name}`);
  return (res.data_points ?? []).map((dp) => ({
    timestampMs: fromPbTimestamp(dp.timestamp),
    tags: Object.assign({}, ...(dp.tag_families ?? []).map(decodeTagFamily)) as Record<string, TagOutput>,
    fields: Object.fromEntries(
      (dp.fields ?? []).map((f) => [f.name ?? '', decodeFieldValue(f.value)]),
    ),
  }));
}
