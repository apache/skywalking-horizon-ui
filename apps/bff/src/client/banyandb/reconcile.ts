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
import {
  GroupRegistry,
  indexRuleBindingRegistry,
  indexRuleRegistry,
  measureRegistry,
  streamRegistry,
  type ModRevision,
} from './registry.js';
import {
  toGroupProto,
  toIndexRuleBindingProto,
  toIndexRuleProto,
  toMeasureProto,
  shardingKeyProblem,
  toStreamProto,
  undeclaredEntityTags,
  type GroupDef,
  type IndexRuleBindingDef,
  type IndexRuleDef,
  type MeasureDef,
  type StreamDef,
} from './schema.js';

/**
 * Bring a declared resource into existence, or bring an existing one into
 * line with the declaration.
 *
 * PostgreSQL gets this from syntax — `CREATE TABLE IF NOT EXISTS` and
 * `ADD COLUMN IF NOT EXISTS` are idempotent, so init and update are one
 * statement. BanyanDB has no such form and `Create` is not idempotent, so
 * get-compare-create-or-update is the client's work.
 */

export type ReconcileAction = 'created' | 'updated' | 'unchanged';

export interface ReconcileResult {
  action: ReconcileAction;
  modRevision: ModRevision;
  changed: string[];
}

/** One difference between what was declared and what exists. `updatable`
 *  false means the server would refuse the change, so it is reported rather
 *  than attempted. */
export interface Drift {
  field: string;
  want: unknown;
  have: unknown;
  updatable: boolean;
}

export class SchemaConflictError extends BanyanDBError {
  constructor(
    readonly resource: string,
    readonly drift: Drift[],
  ) {
    super(
      'invalid',
      `${resource} exists with a shape that cannot be updated: ` +
        drift.map((d) => `${d.field} is ${JSON.stringify(d.have)}, declared ${JSON.stringify(d.want)}`).join('; '),
    );
    this.name = 'SchemaConflictError';
  }
}

/**
 * Structural equality that does not depend on key order.
 *
 * A plain `JSON.stringify` comparison makes `{num, unit}` differ from
 * `{unit, num}`, so a definition written in the other order reports drift on
 * every boot and issues a group Update that changes nothing — forever.
 */
function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonical(val)}`).join(',')}}`;
}

export function compareGroup(def: GroupDef, live: banyandb.common.v1.Group): Drift[] {
  const opts = live.resource_opts;
  const drift: Drift[] = [];
  const check = (field: string, want: unknown, have: unknown): void => {
    if (!same(want, have)) drift.push({ field, want, have, updatable: true });
  };
  // Catalog is the one group property that cannot move: the data node loads by
  // catalog, so a resource in the wrong one is simply never loaded.
  if (def.catalog !== live.catalog) {
    drift.push({ field: 'catalog', want: def.catalog, have: live.catalog, updatable: false });
  }
  check('shardNum', def.shardNum, opts?.shard_num);
  check('segmentInterval', def.segmentInterval, {
    unit: opts?.segment_interval?.unit,
    num: opts?.segment_interval?.num,
  });
  check('ttl', def.ttl, { unit: opts?.ttl?.unit, num: opts?.ttl?.num });
  check('replicas', def.replicas, opts?.replicas ?? 0);
  return drift;
}

function compareFamilies(
  want: StreamDef['families'],
  have: banyandb.database.v1.TagFamilySpec[] | undefined,
): Drift[] {
  const drift: Drift[] = [];
  const live = new Map((have ?? []).map((f) => [f.name ?? '', f.tags ?? []]));

  // Walk the LIVE side too. Comparing only what is desired makes a removal
  // invisible: dropping a tag reports `unchanged` and never happens, while a
  // removal alongside an addition happens by accident, because the update
  // replaces the resource with whatever was sent. Removals are reported so the
  // update is deliberate and the server gets to accept or refuse it.
  const wanted = new Map(want.map((f) => [f.name, new Set(f.tags.map((t) => t.name))]));
  for (const [familyName, tags] of live) {
    const keep = wanted.get(familyName);
    if (!keep) {
      drift.push({ field: `family ${familyName}`, want: 'absent', have: 'present', updatable: true });
      continue;
    }
    for (const tag of tags) {
      if (tag.name && !keep.has(tag.name)) {
        drift.push({ field: `tag ${familyName}.${tag.name}`, want: 'absent', have: tag.type, updatable: true });
      }
    }
  }

  for (const family of want) {
    const liveTags = live.get(family.name);
    if (!liveTags) {
      drift.push({ field: `family ${family.name}`, want: 'present', have: 'absent', updatable: true });
      continue;
    }
    const byName = new Map(liveTags.map((t) => [t.name ?? '', t.type]));
    for (const tag of family.tags) {
      if (!byName.has(tag.name)) {
        // Adding a tag is accepted by the server.
        drift.push({ field: `tag ${family.name}.${tag.name}`, want: tag.type, have: 'absent', updatable: true });
      } else if (byName.get(tag.name) !== tag.type) {
        // The server WOULD accept this — it does not compare existing tag
        // specs — and then old rows decode against the new type. Refused here
        // rather than silently corrupting what is already stored.
        drift.push({
          field: `tag ${family.name}.${tag.name}`,
          want: tag.type,
          have: byName.get(tag.name),
          updatable: false,
        });
      }
    }
  }
  return drift;
}

export function compareStream(def: StreamDef, live: banyandb.database.v1.Stream): Drift[] {
  const drift: Drift[] = [];
  if (!same(def.entity, live.entity?.tag_names ?? [])) {
    drift.push({ field: 'entity', want: def.entity, have: live.entity?.tag_names, updatable: false });
  }
  drift.push(...compareFamilies(def.families, live.tag_families));
  return drift;
}

export function compareMeasure(def: MeasureDef, live: banyandb.database.v1.Measure): Drift[] {
  const drift: Drift[] = [];
  if (!same(def.entity, live.entity?.tag_names ?? [])) {
    drift.push({ field: 'entity', want: def.entity, have: live.entity?.tag_names, updatable: false });
  }
  if ((def.interval ?? '') !== (live.interval ?? '')) {
    drift.push({ field: 'interval', want: def.interval, have: live.interval, updatable: false });
  }
  if (!same(def.shardingKey ?? [], live.sharding_key?.tag_names ?? [])) {
    drift.push({
      field: 'shardingKey',
      want: def.shardingKey ?? [],
      have: live.sharding_key?.tag_names ?? [],
      updatable: false,
    });
  }
  if ((def.indexMode ?? false) !== (live.index_mode ?? false)) {
    drift.push({ field: 'indexMode', want: def.indexMode ?? false, have: live.index_mode ?? false, updatable: false });
  }
  drift.push(...compareFamilies(def.families, live.tag_families));

  const wantedFields = new Set(def.fields.map((f) => f.name));
  for (const f of live.fields ?? []) {
    if (f.name && !wantedFields.has(f.name)) {
      drift.push({ field: `field ${f.name}`, want: 'absent', have: f.field_type, updatable: true });
    }
  }
  const liveFields = new Map((live.fields ?? []).map((f) => [f.name ?? '', f]));
  for (const field of def.fields) {
    const have = liveFields.get(field.name);
    if (!have) {
      drift.push({ field: `field ${field.name}`, want: field.type, have: 'absent', updatable: true });
      continue;
    }
    const wantSpec = { field_type: field.type, encoding_method: field.encoding, compression_method: field.compression };
    const haveSpec = {
      field_type: have.field_type,
      encoding_method: have.encoding_method,
      compression_method: have.compression_method,
    };
    if (!same(wantSpec, haveSpec)) {
      drift.push({ field: `field ${field.name}`, want: wantSpec, have: haveSpec, updatable: false });
    }
  }
  return drift;
}

function settle(resource: string, drift: Drift[]): string[] {
  const blocked = drift.filter((d) => !d.updatable);
  if (blocked.length > 0) throw new SchemaConflictError(resource, blocked);
  return drift.map((d) => d.field);
}

export async function reconcileGroup(ch: BanyanDBChannel, def: GroupDef): Promise<ReconcileResult> {
  const registry = new GroupRegistry(ch);
  const live = await registry.get(def.name);
  if (!live) {
    const { created, modRevision } = await registry.createIfAbsent(toGroupProto(def));
    return { action: created ? 'created' : 'unchanged', modRevision, changed: [] };
  }
  const changed = settle(`group ${def.name}`, compareGroup(def, live));
  if (changed.length === 0) {
    return { action: 'unchanged', modRevision: live.metadata?.mod_revision ?? '0', changed: [] };
  }
  // An Update REPLACES the whole group, so anything not sent is reset — and
  // `stages` / `default_stages` are lifecycle tiering this client does not
  // model but an operator may well have configured. Start from what the server
  // holds and overwrite only the fields this definition owns, so an update
  // triggered by a TTL change cannot quietly delete someone's tiering.
  const merged = toGroupProto(def);
  merged.resource_opts = { ...live.resource_opts, ...merged.resource_opts };
  return { action: 'updated', modRevision: await registry.update(merged), changed };
}

export async function reconcileStream(ch: BanyanDBChannel, def: StreamDef): Promise<ReconcileResult> {
  const missing = undeclaredEntityTags(def);
  if (missing.length > 0) {
    throw new BanyanDBError(
      'invalid',
      `stream ${def.group}/${def.name}: entity names undeclared tag(s) ${missing.join(', ')} — ` +
        'the server accepts this and silently shortens the series key',
    );
  }
  const registry = streamRegistry(ch);
  const live = await registry.get(def.group, def.name);
  if (!live) {
    const { created, modRevision } = await registry.createIfAbsent(toStreamProto(def));
    // Losing the race does not mean agreeing with the winner: another replica
    // may have created a resource this definition would refuse, so it is read
    // back and compared rather than accepted on the strength of existing.
    if (!created) {
      const won = await registry.get(def.group, def.name);
      if (won) settle(`stream ${def.group}/${def.name}`, compareStream(def, won));
    }
    return { action: created ? 'created' : 'unchanged', modRevision, changed: [] };
  }
  const changed = settle(`stream ${def.group}/${def.name}`, compareStream(def, live));
  if (changed.length === 0) {
    return { action: 'unchanged', modRevision: live.metadata?.mod_revision ?? '0', changed: [] };
  }
  return { action: 'updated', modRevision: await registry.update(toStreamProto(def)), changed };
}

export async function reconcileMeasure(ch: BanyanDBChannel, def: MeasureDef): Promise<ReconcileResult> {
  const missing = undeclaredEntityTags(def);
  if (missing.length > 0) {
    throw new BanyanDBError(
      'invalid',
      `measure ${def.group}/${def.name}: entity names undeclared tag(s) ${missing.join(', ')}`,
    );
  }
  const shardingProblem = shardingKeyProblem(def);
  if (shardingProblem) {
    throw new BanyanDBError('invalid', `measure ${def.group}/${def.name}: ${shardingProblem}`);
  }
  const registry = measureRegistry(ch);
  const live = await registry.get(def.group, def.name);
  if (!live) {
    const { created, modRevision } = await registry.createIfAbsent(toMeasureProto(def));
    // Losing the race does not mean agreeing with the winner: another replica
    // may have created a resource this definition would refuse, so it is read
    // back and compared rather than accepted on the strength of existing.
    if (!created) {
      const won = await registry.get(def.group, def.name);
      if (won) settle(`measure ${def.group}/${def.name}`, compareMeasure(def, won));
    }
    return { action: created ? 'created' : 'unchanged', modRevision, changed: [] };
  }
  const changed = settle(`measure ${def.group}/${def.name}`, compareMeasure(def, live));
  if (changed.length === 0) {
    return { action: 'unchanged', modRevision: live.metadata?.mod_revision ?? '0', changed: [] };
  }
  return { action: 'updated', modRevision: await registry.update(toMeasureProto(def)), changed };
}

export async function reconcileIndexRule(
  ch: BanyanDBChannel,
  def: IndexRuleDef,
): Promise<ReconcileResult> {
  const registry = indexRuleRegistry(ch);
  const proto = toIndexRuleProto(def);
  const live = await registry.get(def.group, def.name);
  if (!live) {
    const { created, modRevision } = await registry.createIfAbsent(proto);
    return { action: created ? 'created' : 'unchanged', modRevision, changed: [] };
  }
  // `analyzer` is what makes EQ mean equality rather than a token match, and a
  // rule's identity is group-global — so a wrong analyzer left uncorrected is
  // shared by every resource in the group.
  const drift: string[] = [];
  if (!same(live.tags ?? [], def.tags)) drift.push('tags');
  if (live.type !== def.type) drift.push('type');
  if ((live.analyzer ?? '') !== (def.analyzer ?? '')) drift.push('analyzer');
  if ((live.no_sort ?? false) !== (def.noSort ?? false)) drift.push('noSort');
  if (drift.length === 0) {
    return { action: 'unchanged', modRevision: live.metadata?.mod_revision ?? '0', changed: [] };
  }
  return { action: 'updated', modRevision: await registry.update(proto), changed: drift };
}

/**
 * A binding is what makes its rules take effect, and its window is checked
 * against `now` — outside it, every index on the subject is inert while
 * writes still succeed and queries silently return nothing. The window is
 * therefore re-asserted on every reconcile rather than trusted to have stayed
 * valid since it was written.
 */
export async function reconcileIndexRuleBinding(
  ch: BanyanDBChannel,
  def: IndexRuleBindingDef,
): Promise<ReconcileResult> {
  const registry = indexRuleBindingRegistry(ch);
  const proto = toIndexRuleBindingProto(def);
  const live = await registry.get(def.group, def.name);
  if (!live) {
    const { created, modRevision } = await registry.createIfAbsent(proto);
    return { action: created ? 'created' : 'unchanged', modRevision, changed: [] };
  }
  return { action: 'updated', modRevision: await registry.update(proto), changed: ['window', 'rules'] };
}
