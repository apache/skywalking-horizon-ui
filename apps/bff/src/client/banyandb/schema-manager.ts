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
 * Creating a declared resource, or bringing an existing one into line with the
 * declaration.
 *
 * PostgreSQL gets this from syntax: `CREATE TABLE IF NOT EXISTS` and
 * `ADD COLUMN IF NOT EXISTS` are idempotent, so init and update are one
 * statement that can be run on every boot. BanyanDB has no such form and
 * `Create` is not idempotent, so get-compare-create-or-update is the client's
 * work — and this is where it lives.
 *
 * It runs at boot and then stops. There is no watch, no retry loop and nothing
 * that revisits a resource later.
 */

export type SchemaAction = 'created' | 'updated' | 'unchanged';

export interface SchemaChange {
  action: SchemaAction;
  modRevision: ModRevision;
  /** The fields that differed. Empty when the action is `created` — nothing
   *  differed, there was nothing to differ from. */
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
  /**
   * This drift would DELETE something the server currently holds.
   *
   * Kept apart from ordinary drift because the two are not symmetric risks
   * under a rolling upgrade. Every node applies the schema at boot, the
   * registry offers no compare-and-set, and two versions of a definition are
   * live at once — so an addition an older node does not know about is
   * harmless to it, while a removal an older node believes in destroys a tag
   * the newer ones are actively writing.
   */
  removes?: true;
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
  // Tiering is a property of the group and of nothing else, so a change to it
  // is the ONLY signal that a lifecycle edit happened — unreported, the update
  // never runs and the configuration silently stays as it was.
  // Only compared when the definition manages them. Comparing `undefined` as
  // `[]` reported drift that the update then could not act on, because an
  // unmanaged value is not sent — drift on every boot, forever.
  if (def.stages !== undefined) check('stages', def.stages, opts?.stages ?? []);
  if (def.defaultStages !== undefined) {
    check('defaultStages', def.defaultStages, opts?.default_stages ?? []);
  }
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
      drift.push({ field: `family ${familyName}`, want: 'absent', have: 'present', updatable: true, removes: true });
      continue;
    }
    for (const tag of tags) {
      if (tag.name && !keep.has(tag.name)) {
        drift.push({ field: `tag ${familyName}.${tag.name}`, want: 'absent', have: tag.type, updatable: true, removes: true });
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
      drift.push({ field: `field ${f.name}`, want: 'absent', have: f.field_type, updatable: true, removes: true });
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

/**
 * Decide what to do with the differences found, and report what changed.
 *
 * A removal is applied only when the caller has said it means one. Without
 * that, a removal is REPORTED and the resource is left alone — because at boot
 * the likeliest reason the server holds something this definition does not is
 * that another node is running a newer one, and there is no compare-and-set to
 * arbitrate between them.
 */
function settle(
  resource: string,
  drift: Drift[],
  allowRemovals: boolean,
): { changed: string[]; act: boolean; union: boolean } {
  const blocked = drift.filter((d) => !d.updatable);
  if (blocked.length > 0) throw new SchemaConflictError(resource, blocked);
  const removals = drift.filter((d) => d.removes);
  if (removals.length > 0 && !allowRemovals) {
    // The additions still have to land. Sending the definition as written
    // would perform the removal too, so the update carries the UNION of what
    // the server holds and what this definition adds: live A+B plus desired
    // A+C becomes A+B+C, which is the state both an old and a new node can
    // work with.
    return {
      changed: drift.map((d) => (d.removes ? `${d.field} (kept)` : d.field)),
      act: drift.length > removals.length,
      union: true,
    };
  }
  return { changed: drift.map((d) => d.field), act: drift.length > 0, union: false };
}

/** The definition plus whatever the server holds that it does not mention. */
function unionFamilies(
  want: StreamDef['families'],
  have: banyandb.database.v1.TagFamilySpec[] | undefined,
): banyandb.database.v1.TagFamilySpec[] {
  // Typed against the PROTO, not the client's narrowed TagType: a tag already
  // on the server may carry a type this client would never declare, and
  // carrying it through unchanged is the whole point.
  const out: banyandb.database.v1.TagFamilySpec[] = want.map((f) => ({
    name: f.name,
    tags: f.tags.map((t) => ({ name: t.name, type: t.type })),
  }));
  const byName = new Map(out.map((f) => [f.name, f]));
  for (const liveFamily of have ?? []) {
    const target = byName.get(liveFamily.name ?? '');
    if (!target) {
      out.push({
        name: liveFamily.name ?? '',
        tags: liveFamily.tags ?? [],
      });
      continue;
    }
    const known = new Set((target.tags ?? []).map((t) => t.name));
    for (const t of liveFamily.tags ?? []) {
      if (t.name && !known.has(t.name)) target.tags?.push({ name: t.name, type: t.type });
    }
  }
  return out;
}

async function applyGroup(ch: BanyanDBChannel, def: GroupDef, allowRemovals: boolean): Promise<SchemaChange> {
  const registry = new GroupRegistry(ch);
  let live = await registry.get(def.name);
  if (!live) {
    const { created, modRevision } = await registry.createIfAbsent(toGroupProto(def));
    if (created) return { action: 'created', modRevision, changed: [] };
    // Another replica won the race. That is not agreement: it may be running an
    // older definition, so what it created falls through to the ordinary
    // comparison below rather than being accepted for existing.
    live = await registry.get(def.name);
    if (!live) return { action: 'unchanged', modRevision, changed: [] };
  }
  const { changed, act } = settle(`group ${def.name}`, compareGroup(def, live), allowRemovals);
  if (!act) {
    return { action: 'unchanged', modRevision: live.metadata?.mod_revision ?? '0', changed };
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

async function applyStream(ch: BanyanDBChannel, def: StreamDef, allowRemovals: boolean): Promise<SchemaChange> {
  const missing = undeclaredEntityTags(def);
  if (missing.length > 0) {
    throw new BanyanDBError(
      'invalid',
      `stream ${def.group}/${def.name}: entity names undeclared tag(s) ${missing.join(', ')} — ` +
        'the server accepts this and silently shortens the series key',
    );
  }
  const registry = streamRegistry(ch);
  let live = await registry.get(def.group, def.name);
  if (!live) {
    const { created, modRevision } = await registry.createIfAbsent(toStreamProto(def));
    if (created) return { action: 'created', modRevision, changed: [] };
    // Another replica won the race, possibly on an older definition — so what
    // it created is compared like any other existing resource.
    live = await registry.get(def.group, def.name);
    if (!live) return { action: 'unchanged', modRevision, changed: [] };
  }
  const { changed, act, union } = settle(
    `stream ${def.group}/${def.name}`,
    compareStream(def, live),
    allowRemovals,
  );
  if (!act) {
    return { action: 'unchanged', modRevision: live.metadata?.mod_revision ?? '0', changed };
  }
  const proto = toStreamProto(def);
  if (union) proto.tag_families = unionFamilies(def.families, live.tag_families);
  return { action: 'updated', modRevision: await registry.update(proto), changed };
}

async function applyMeasure(ch: BanyanDBChannel, def: MeasureDef, allowRemovals: boolean): Promise<SchemaChange> {
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
  let live = await registry.get(def.group, def.name);
  if (!live) {
    const { created, modRevision } = await registry.createIfAbsent(toMeasureProto(def));
    if (created) return { action: 'created', modRevision, changed: [] };
    // Another replica won the race, possibly on an older definition — so what
    // it created is compared like any other existing resource.
    live = await registry.get(def.group, def.name);
    if (!live) return { action: 'unchanged', modRevision, changed: [] };
  }
  const { changed, act, union } = settle(
    `measure ${def.group}/${def.name}`,
    compareMeasure(def, live),
    allowRemovals,
  );
  if (!act) {
    return { action: 'unchanged', modRevision: live.metadata?.mod_revision ?? '0', changed };
  }
  const proto = toMeasureProto(def);
  if (union) {
    proto.tag_families = unionFamilies(def.families, live.tag_families);
    const known = new Set(def.fields.map((f) => f.name));
    proto.fields = [...(proto.fields ?? []), ...(live.fields ?? []).filter((f) => f.name && !known.has(f.name))];
  }
  return { action: 'updated', modRevision: await registry.update(proto), changed };
}

async function applyIndexRule(
  ch: BanyanDBChannel,
  def: IndexRuleDef,
): Promise<SchemaChange> {
  const registry = indexRuleRegistry(ch);
  const proto = toIndexRuleProto(def);
  let live = await registry.get(def.group, def.name);
  if (!live) {
    const { created, modRevision } = await registry.createIfAbsent(proto);
    if (created) return { action: 'created', modRevision, changed: [] };
    live = await registry.get(def.group, def.name);
    if (!live) return { action: 'unchanged', modRevision, changed: [] };
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
async function applyIndexRuleBinding(
  ch: BanyanDBChannel,
  def: IndexRuleBindingDef,
): Promise<SchemaChange> {
  const registry = indexRuleBindingRegistry(ch);
  const proto = toIndexRuleBindingProto(def);
  let live = await registry.get(def.group, def.name);
  if (!live) {
    const { created, modRevision } = await registry.createIfAbsent(proto);
    if (created) return { action: 'created', modRevision, changed: [] };
    live = await registry.get(def.group, def.name);
    if (!live) return { action: 'unchanged', modRevision, changed: [] };
  }
  return { action: 'updated', modRevision: await registry.update(proto), changed: ['window', 'rules'] };
}

/**
 * The schema side of the client, gathered behind one object.
 *
 * Each method is get-compare-create-or-update for one resource. Deciding WHICH
 * resources should exist is the caller's: this offers no `applyAll`, because
 * the order they are created in, and what belongs together, is a property of
 * the thing being stored rather than of BanyanDB.
 */
export class SchemaManager {
  /**
   * Schema work runs one at a time, in call order.
   *
   * Every method is read-then-decide, so two running at once both read "absent"
   * and both create — one of them then losing a race it need never have
   * entered. Serialising costs nothing, because the schema is a fixed, small
   * set applied once at boot rather than a hot path.
   *
   * This orders THIS process. Across replicas the create is still contended,
   * which is why losing that race falls through to the ordinary comparison
   * rather than accepting whatever the winner made.
   */
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * @param allowRemovals whether a difference that DELETES something the
   *   server holds may be acted on. Off by default: every node applies the
   *   schema at boot, so during a rolling upgrade the likeliest reason the
   *   server holds a tag this definition lacks is that another node is running
   *   a newer definition — and removing it destroys a column that node is
   *   writing to. Turn it on for a deliberate migration, where one actor
   *   applies the change and no older definition is still running.
   */
  constructor(
    private readonly ch: BanyanDBChannel,
    private readonly allowRemovals = false,
  ) {}

  private serial<T>(op: () => Promise<T>): Promise<T> {
    // Chained through a settled tail either way: one failure must not stop
    // everything queued behind it from running.
    const run = this.tail.then(op, op);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  group = (def: GroupDef): Promise<SchemaChange> =>
    this.serial(() => applyGroup(this.ch, def, this.allowRemovals));
  stream = (def: StreamDef): Promise<SchemaChange> =>
    this.serial(() => applyStream(this.ch, def, this.allowRemovals));
  measure = (def: MeasureDef): Promise<SchemaChange> =>
    this.serial(() => applyMeasure(this.ch, def, this.allowRemovals));
  indexRule = (def: IndexRuleDef): Promise<SchemaChange> =>
    this.serial(() => applyIndexRule(this.ch, def));
  indexRuleBinding = (def: IndexRuleBindingDef): Promise<SchemaChange> =>
    this.serial(() => applyIndexRuleBinding(this.ch, def));
}
