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
 * What the audit feature stores in BanyanDB.
 *
 * Three resources across two groups, because a group's catalog is fixed and a
 * measure placed in a stream group is never loaded.
 *
 * The shapes follow from what the feature does, not from how anything else
 * stores it. A sign-in is an event about a PERSON, so the person is the series
 * and every sign-in of theirs appends to it. The statistics are per-interval
 * counts that are summed on read, so they append too. Token use is one running
 * total per credential per hour per process, which is an upsert — the only one
 * here, and the reason that resource is a measure.
 */

import type {
  GroupDef,
  IndexRuleBindingDef,
  IndexRuleDef,
  MeasureDef,
  StreamDef,
} from '../../../client/banyandb/index.js';

/** Everything the feature owns is prefixed, so two deployments sharing one
 *  BanyanDB do not share one audit log. */
export interface AuditSchemaNames {
  namespace: string;
  retentionDays: number;
}

/**
 * One shard — bundled, and deliberately not configurable.
 *
 * A sign-in is a rare event: a fifty-person team writes on the order of a
 * hundred rows a DAY, which one shard serves without noticing. Set against
 * that, exposing the number would be a way to break the audit log rather than
 * to tune it — BanyanDB fixes a group's shard count at creation and does not
 * move data when it changes, so raising it routes new rows away from the old
 * ones and lowering it strands whole shards.
 *
 * REPLICATION is left unmanaged rather than pinned, which is a different
 * decision for a different reason. Unlike shards it can be changed safely, and
 * an operator who wants the audit log replicated can pre-create these groups
 * with the replica count they want: Horizon then leaves it alone instead of
 * flattening it back on the next boot.
 */
const SHARDS = 1;

const SEARCHABLE = 'searchable';
const DATA = 'data';

/** Retention is the group's TTL, expressed in whole days — BanyanDB drops
 *  whole segments, so the segment interval is what decides how much longer
 *  than `retentionDays` a row can survive. */
function group(name: string, catalog: GroupDef['catalog'], n: AuditSchemaNames): GroupDef {
  const { retentionDays } = n;
  return {
    name,
    catalog,
    shardNum: SHARDS,
    segmentInterval: { unit: 'UNIT_DAY', num: retentionDays <= 7 ? 1 : retentionDays <= 30 ? 3 : 7 },
    ttl: { unit: 'UNIT_DAY', num: retentionDays },
  };
}

/** `horizon_audit`, or `<namespace>_horizon_audit` when a deployment sets one.
 *  Two deployments sharing a BanyanDB must set different namespaces, or they
 *  share one audit log without either of them being told. */
function named(n: AuditSchemaNames, suffix: string): string {
  const base = `horizon_audit${suffix}`;
  return n.namespace ? `${n.namespace}_${base}` : base;
}

export function streamGroup(n: AuditSchemaNames): GroupDef {
  return group(named(n, ''), 'CATALOG_STREAM', n);
}

/** Separate because a group's catalog is fixed: a measure in a stream group is
 *  never loaded and every write to it fails. */
export function measureGroup(n: AuditSchemaNames): GroupDef {
  return group(named(n, '_metrics'), 'CATALOG_MEASURE', n);
}

/**
 * One sign-in.
 *
 * `username` is the series: the log is a record of what people did, and a
 * person signing in repeatedly belongs together. It is a verified principal —
 * never text a caller supplied — so the number of series is the number of
 * people, not the number of strings anyone typed at a login box.
 *
 * `kind` is the only other thing the page filters on, so it is the only tag
 * that earns an index. Time is the element's own timestamp. Identity is the
 * `element_id` the query returns.
 */
export function logStream(n: AuditSchemaNames): StreamDef {
  return {
    group: streamGroup(n).name,
    name: 'log',
    entity: ['username'],
    families: [
      {
        name: SEARCHABLE,
        tags: [
          { name: 'username', type: 'TAG_TYPE_STRING' },
          { name: 'kind', type: 'TAG_TYPE_STRING' },
          { name: 'outcome', type: 'TAG_TYPE_INT' },
        ],
      },
      {
        name: DATA,
        tags: [
          { name: 'provider', type: 'TAG_TYPE_STRING' },
          { name: 'protocol', type: 'TAG_TYPE_STRING' },
          { name: 'reason', type: 'TAG_TYPE_STRING' },
          { name: 'mail', type: 'TAG_TYPE_STRING' },
          { name: 'roles', type: 'TAG_TYPE_STRING' },
          { name: 'client_ip', type: 'TAG_TYPE_STRING' },
          { name: 'horizon_ip', type: 'TAG_TYPE_STRING' },
          { name: 'horizon_node', type: 'TAG_TYPE_STRING' },
        ],
      },
    ],
  };
}

export function kindIndex(n: AuditSchemaNames): IndexRuleDef {
  return {
    group: streamGroup(n).name,
    name: 'audit_kind',
    tags: ['kind'],
    type: 'TYPE_INVERTED',
    // The no-op analyzer: it returns the whole value as one token, which is
    // what makes equality mean equality rather than a word match.
    analyzer: 'keyword',
  };
}

export function kindIndexBinding(n: AuditSchemaNames): IndexRuleBindingDef {
  return {
    group: streamGroup(n).name,
    name: 'audit_log_index',
    rules: [kindIndex(n).name],
    subject: { name: 'log', catalog: 'CATALOG_STREAM' },
    // A binding is only live inside its window, and outside it every rule on
    // the subject is inert while writes still succeed — so the window is wide
    // and re-asserted whenever the schema is applied.
    beginAt: new Date(0),
    expireAt: new Date('2099-01-01T00:00:00Z'),
  };
}

/**
 * Sign-in counts for one hour, as one process counted them.
 *
 * A measure, because this is a metric: a count per interval, read by summing.
 *
 * The series is the PROCESS and the timestamp is the HOUR — a point is keyed
 * by both, so one process's figure for one hour is one point. Each process
 * reports only its own share and the deployment's figure is their sum, which
 * is the only arrangement that survives more than one replica: a single row
 * per hour that every process overwrote would report whichever wrote last and
 * would go DOWN as the hour progressed.
 *
 * Keying on the interval rather than dating the point is what makes a write
 * idempotent — the same process reporting the same hour again lands on the
 * same point and replaces it, so a flush repeated after an uncertain outcome
 * leaves the same number rather than counting twice.
 */
export function statMeasure(n: AuditSchemaNames): MeasureDef {
  return {
    group: measureGroup(n).name,
    name: 'sign_in',
    // The series is the PROCESS. The hour is the data point's timestamp, not a
    // tag and not part of the key — a measure is keyed by (series, timestamp),
    // so naming the interval in the entity as well would duplicate it and make
    // the series grow forever instead of staying bounded by the reporters.
    entity: ['horizon_node'],
    families: [
      {
        name: SEARCHABLE,
        tags: [
          { name: 'horizon_node', type: 'TAG_TYPE_STRING' },
          // Not the key, and not how the window is selected — that is the time
          // range. Carried so a row states which hour it counted without a
          // reader deriving it, and so this family holds more than the entity
          // and therefore stores columns at all.
          { name: 'hour_bucket', type: 'TAG_TYPE_INT' },
        ],
      },
    ],
    fields: [
      // One field per series the page draws, so a column is read without
      // unpacking anything. `rejected` counts a refusal by policy; the login
      // fields count accepted sign-ins only, or a column's total would exceed
      // the rows in its hour.
      field('login_local'),
      field('login_ldap'),
      field('login_oidc'),
      field('login_oauth'),
      field('rejected'),
      field('over_budget'),
    ],
  };
}

function field(name: string): MeasureDef['fields'][number] {
  return {
    name,
    type: 'FIELD_TYPE_INT',
    encoding: 'ENCODING_METHOD_GORILLA',
    compression: 'COMPRESSION_METHOD_ZSTD',
  };
}

/**
 * One credential's running total, for one hour, as one process saw it.
 *
 * A measure because this is the one thing here that is an upsert: the same
 * process writing the same hour again means the same row with a larger number,
 * not a second row. The series is what makes that identity — credential, hour,
 * and the process that counted, because each process only ever reports its own
 * share and the hour's real total is their sum.
 */
export function tokenUsageMeasure(n: AuditSchemaNames): MeasureDef {
  return {
    group: measureGroup(n).name,
    name: 'token_usage',
    // Credential and process, for the same reason the sign-in counts use the
    // process: the hour is the timestamp.
    entity: ['token_id', 'horizon_node'],
    families: [
      {
        name: SEARCHABLE,
        tags: [
          { name: 'token_id', type: 'TAG_TYPE_STRING' },
          { name: 'hour_bucket', type: 'TAG_TYPE_INT' },
          { name: 'horizon_node', type: 'TAG_TYPE_STRING' },
          // Not part of the identity: which account a credential acts as is
          // recorded so a reader need not join against a config file that may
          // since have changed. It also keeps this family from holding nothing
          // but entity tags, which would store no columns at all.
          { name: 'username', type: 'TAG_TYPE_STRING' },
        ],
      },
    ],
    fields: [field('count')],
  };
}
