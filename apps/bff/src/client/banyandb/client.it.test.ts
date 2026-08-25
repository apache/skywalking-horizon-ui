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
 * Integration tests for the BanyanDB client, against a REAL server.
 *
 *     pnpm test:it
 *
 * That is the whole thing: the fixture starts a BanyanDB, the tests run, and
 * it is stopped again — there is nothing to bring up first and nothing left
 * behind. The version is the one `test/e2e/script/env` pins, so these and the
 * e2e suite exercise the same server.
 *
 * `pnpm test:unit` cannot reach these files (see vitest.config.ts), and there
 * is no `skipIf` anywhere: a tier that passes by running nothing is worse than
 * one that fails loudly.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, in_ } from './index.js';
import { familiesThatStoreNothing, startBanyanDB, testGroup, type BanyanDBFixture } from './testing.js';
import type { GroupDef, StreamDef, MeasureDef } from './schema.js';

let fixture: BanyanDBFixture;
// One namespace per run, so a crashed run never poisons the next.
const NS = `horizon_it_${Date.now().toString(36)}`;

const streamGroup: GroupDef = testGroup(`${NS}_log`, 'CATALOG_STREAM');
const measureGroup: GroupDef = testGroup(`${NS}_stat`, 'CATALOG_MEASURE');

const logStream: StreamDef = {
  group: streamGroup.name,
  name: 'log',
  entity: ['principal'],
  families: [
    {
      name: 'searchable',
      tags: [
        { name: 'principal', type: 'TAG_TYPE_STRING' },
        { name: 'kind', type: 'TAG_TYPE_STRING' },
        { name: 'seq', type: 'TAG_TYPE_INT' },
      ],
    },
    {
      name: 'data',
      tags: [
        { name: 'detail', type: 'TAG_TYPE_STRING' },
        { name: 'labels', type: 'TAG_TYPE_STRING_ARRAY' },
      ],
    },
  ],
};

const counter: MeasureDef = {
  group: measureGroup.name,
  name: 'counter',
  entity: ['bucket', 'node'],
  families: [
    {
      name: 'searchable',
      tags: [
        { name: 'bucket', type: 'TAG_TYPE_INT' },
        { name: 'node', type: 'TAG_TYPE_STRING' },
        // A family holding ONLY entity tags stores nothing: entity values live
        // in the series key, not in the column data, so the family is dropped
        // for having no values left — and a read whose projection then
        // intersects to empty abandons the block. Every projected family needs
        // at least one non-entity tag.
        { name: 'label', type: 'TAG_TYPE_STRING' },
      ],
    },
  ],
  fields: [
    { name: 'total', type: 'FIELD_TYPE_INT', encoding: 'ENCODING_METHOD_GORILLA', compression: 'COMPRESSION_METHOD_ZSTD' },
    { name: 'ratio', type: 'FIELD_TYPE_FLOAT', encoding: 'ENCODING_METHOD_GORILLA', compression: 'COMPRESSION_METHOD_ZSTD' },
    { name: 'note', type: 'FIELD_TYPE_STRING', encoding: 'ENCODING_METHOD_GORILLA', compression: 'COMPRESSION_METHOD_ZSTD' },
  ],
};

const now = Date.now();
let client: BanyanDBFixture['client'];

beforeAll(async () => {
  fixture = await startBanyanDB();
  client = fixture.client;
}, 180_000);

afterAll(async () => {
  await fixture?.stop();
});

describe('fixture', () => {
  it('declares families that can actually store something', () => {
    // A family of pure entity tags stores nothing and its rows can never be
    // read back. Asserting it here means a future schema edit fails on this
    // line rather than as an inexplicably empty query three tests later.
    expect(familiesThatStoreNothing(logStream)).toEqual([]);
    expect(familiesThatStoreNothing(counter)).toEqual([]);
  });
});

describe('schema', () => {
  it('creates a group, stream and measure, and stores exactly what was declared', async () => {
    for (const g of [streamGroup, measureGroup]) {
      const res = await client.schema.group(g);
      expect(res.action).toBe('created');
      expect(BigInt(res.modRevision)).toBeGreaterThan(0n);

      // Read the metadata back: an action and a revision only prove the call
      // was accepted, not that the server stored what was asked for.
      const live = await client.groups.get(g.name);
      expect(live?.catalog).toBe(g.catalog);
      expect(live?.resource_opts?.shard_num).toBe(g.shardNum);
      expect(live?.resource_opts?.replicas ?? 0).toBe(g.replicas);
      expect(live?.resource_opts?.ttl).toMatchObject({ unit: g.ttl.unit, num: g.ttl.num });
      expect(live?.resource_opts?.segment_interval).toMatchObject({
        unit: g.segmentInterval.unit,
        num: g.segmentInterval.num,
      });
    }

    expect((await client.schema.stream(logStream)).action).toBe('created');
    const liveStream = await client.streams.get(logStream.group, logStream.name);
    expect(liveStream?.entity?.tag_names).toEqual(logStream.entity);
    expect(liveStream?.tag_families?.map((f) => f.name)).toEqual(logStream.families.map((f) => f.name));
    expect(liveStream?.tag_families?.[0]?.tags).toEqual(
      logStream.families[0]?.tags.map((t) => ({ name: t.name, type: t.type })),
    );

    expect((await client.schema.measure(counter)).action).toBe('created');
    const liveMeasure = await client.measures.get(counter.group, counter.name);
    expect(liveMeasure?.entity?.tag_names).toEqual(counter.entity);
    expect(liveMeasure?.fields?.map((f) => f.name)).toEqual(counter.fields.map((f) => f.name));
    expect(liveMeasure?.fields?.[0]).toMatchObject({
      name: 'total',
      field_type: 'FIELD_TYPE_INT',
      encoding_method: 'ENCODING_METHOD_GORILLA',
      compression_method: 'COMPRESSION_METHOD_ZSTD',
    });
  });

  it('is a no-op the second time — the same definition must not churn', async () => {
    expect((await client.schema.group(streamGroup)).action).toBe('unchanged');
    expect((await client.schema.stream(logStream)).action).toBe('unchanged');
    expect((await client.schema.measure(counter)).action).toBe('unchanged');
  });

  it('is still a no-op when the definition writes its fields in another order', async () => {
    // Drift is decided structurally, not by serialising the literal: a group
    // written `{num, unit}` rather than `{unit, num}` is the same group, and
    // reporting it as changed would issue a pointless Update on every boot.
    const reordered: GroupDef = {
      catalog: streamGroup.catalog,
      ttl: { num: streamGroup.ttl.num, unit: streamGroup.ttl.unit },
      segmentInterval: { num: streamGroup.segmentInterval.num, unit: streamGroup.segmentInterval.unit },
      replicas: streamGroup.replicas,
      shardNum: streamGroup.shardNum,
      name: streamGroup.name,
    };
    expect((await client.schema.group(reordered)).action).toBe('unchanged');
  });

  it('refuses an entity naming a tag no family declares', async () => {
    // The server ACCEPTS this and silently shortens the series key, so the
    // refusal has to come from the client or not at all.
    await expect(
      client.schema.stream({ ...logStream, name: 'bad', entity: ['nope'] }),
    ).rejects.toThrow(/undeclared tag/);
  });

  it('refuses a changed entity on an existing stream', async () => {
    await expect(
      client.schema.stream({ ...logStream, entity: ['kind'] }),
    ).rejects.toThrow(/cannot be updated/);
  });

  it('adds a tag to a live stream', async () => {
    const grown: StreamDef = {
      ...logStream,
      families: logStream.families.map((f) =>
        f.name === 'data' ? { ...f, tags: [...f.tags, { name: 'extra', type: 'TAG_TYPE_STRING' as const }] } : f,
      ),
    };
    const res = await client.schema.stream(grown);
    expect(res.action).toBe('updated');
    expect(res.changed).toContain('tag data.extra');
  });
});

describe('index rule and binding', () => {
  it('creates a rule and the binding that activates it', async () => {
    const rule = await client.schema.indexRule({
      group: streamGroup.name,
      name: 'kind_idx',
      tags: ['kind'],
      type: 'TYPE_INVERTED',
      analyzer: 'keyword',
    });
    expect(['created', 'unchanged']).toContain(rule.action);
    const liveRule = await client.indexRules.get(streamGroup.name, 'kind_idx');
    expect(liveRule?.tags).toEqual(['kind']);
    expect(liveRule?.type).toBe('TYPE_INVERTED');
    expect(liveRule?.analyzer).toBe('keyword');

    const binding = await client.schema.indexRuleBinding({
      group: streamGroup.name,
      name: 'log_binding',
      rules: ['kind_idx'],
      subject: { name: 'log', catalog: 'CATALOG_STREAM' },
      beginAt: new Date(now - 86_400_000),
      expireAt: new Date('2099-01-01T00:00:00Z'),
    });
    expect(['created', 'updated']).toContain(binding.action);
    const liveBinding = await client.indexRuleBindings.get(streamGroup.name, 'log_binding');
    expect(liveBinding?.rules).toEqual(['kind_idx']);
    expect(liveBinding?.subject).toMatchObject({ name: 'log', catalog: 'CATALOG_STREAM' });
    // A binding whose window does not contain `now` makes every rule on the
    // subject inert while writes still succeed — so the window is asserted,
    // not assumed.
    expect(Number(liveBinding?.begin_at?.seconds)).toBeLessThan(Math.floor(now / 1000));
    expect(Number(liveBinding?.expire_at?.seconds)).toBeGreaterThan(Math.floor(now / 1000));
  });
});

describe('the schema barrier', () => {
  it('reports rather than throws when the server predates it', async () => {
    const res = await client.awaitSchemaApplied(
      [{ key: { kind: 'stream', group: streamGroup.name, name: 'log' }, minRevision: '1' }],
      5_000,
    );
    // 0.11+ applies it; an older server has no such RPC and says so.
    expect(res.applied || res.unimplemented === true).toBe(true);
  });
});

describe('write and query', () => {
  const rows = [
    { timestampMs: now - 2000, elementId: 'a', tags: { principal: 'alice', kind: 'local', seq: 1, detail: 'first', labels: ['x', 'y'] } },
    { timestampMs: now - 1000, elementId: 'b', tags: { principal: 'alice', kind: 'sso', seq: 2, detail: 'second', labels: [] } },
    { timestampMs: now, elementId: 'c', tags: { principal: 'bob', kind: 'local', seq: 3, detail: null, labels: [] } },
  ];

  it('inserts a batch and reports one outcome per row', async () => {
    const outcomes = await client.insertStream(logStream, rows);
    expect(outcomes).toHaveLength(3);
    for (const o of outcomes) expect(o.status).toBe('STATUS_SUCCEED');
  });

  it('reads every value back exactly as written', async () => {
    const got = await client.queryStream({
      group: streamGroup.name,
      name: 'log',
      timeRange: { beginMs: now - 60_000, endMs: now + 1000 },
      projection: [
        { family: 'searchable', tags: ['principal', 'kind', 'seq'] },
        { family: 'data', tags: ['detail', 'labels'] },
      ],
      limit: 50,
      orderBy: { sort: 'SORT_ASC' },
    });
    expect(got.length).toBeGreaterThanOrEqual(3);
    const alice = got.find((e) => e.tags.seq === '1');
    expect(alice).toBeDefined();
    expect(alice?.tags.principal).toBe('alice');
    expect(alice?.tags.kind).toBe('local');
    // int64 comes back as a decimal STRING, never a number.
    expect(alice?.tags.seq).toBe('1');
    expect(alice?.tags.labels).toEqual(['x', 'y']);
    // An absent optional tag reads back as null, not '' — the difference that
    // a mismatched oneof arm would silently erase.
    const bob = got.find((e) => e.tags.seq === '3');
    expect(bob?.tags.detail).toBeNull();
  });

  it('filters with IN, which needs an array arm rather than a joined string', async () => {
    // A scalar arm here would stringify the list to `alice,bob` and match
    // nothing at all, with no error from either side.
    const got = await client.queryStream({
      group: streamGroup.name,
      name: 'log',
      timeRange: { beginMs: now - 60_000, endMs: now + 1000 },
      projection: [{ family: 'searchable', tags: ['principal', 'seq'] }],
      criteria: in_('principal', 'TAG_TYPE_STRING', ['alice', 'bob']),
      limit: 50,
    });
    expect(got.length).toBeGreaterThanOrEqual(3);
    expect(new Set(got.map((e) => e.tags.principal))).toEqual(new Set(['alice', 'bob']));
  });

  it('filters on the INDEXED non-entity tag, which is what the binding activates', async () => {
    // Creating a rule and a binding proves neither works. This is the only
    // assertion that shows the index is live: `kind` is not an entity tag, so
    // the filter can only be served by `kind_idx`.
    const got = await client.queryStream({
      group: streamGroup.name,
      name: 'log',
      timeRange: { beginMs: now - 60_000, endMs: now + 1000 },
      projection: [{ family: 'searchable', tags: ['principal', 'kind', 'seq'] }],
      criteria: eq('kind', 'TAG_TYPE_STRING', 'sso'),
      limit: 50,
    });
    expect(got).toHaveLength(1);
    expect(got[0]?.tags.kind).toBe('sso');
    expect(got[0]?.tags.principal).toBe('alice');
    expect(got[0]?.tags.seq).toBe('2');
  });

  it('filters on an entity tag', async () => {
    const got = await client.queryStream({
      group: streamGroup.name,
      name: 'log',
      timeRange: { beginMs: now - 60_000, endMs: now + 1000 },
      projection: [{ family: 'searchable', tags: ['principal', 'seq'] }],
      criteria: eq('principal', 'TAG_TYPE_STRING', 'bob'),
      limit: 50,
    });
    expect(got.length).toBe(1);
    expect(got[0]?.tags.principal).toBe('bob');
  });
});

describe('measure upsert', () => {
  it('collapses two writes of one series and timestamp to the later value', async () => {
    const at = now - (now % 1000);
    const row = { timestampMs: at, tags: { bucket: 20260825, node: 'n1', label: 'x' }, fields: { total: 5, ratio: 0.25, note: 'first' } };
    expect((await client.writeMeasure(counter, [row]))[0]?.status).toBe('STATUS_SUCCEED');
    expect(
      (await client.writeMeasure(counter, [{ ...row, fields: { total: 9, ratio: 0.75, note: 'second' }, version: (BigInt(Date.now()) * 1_000_000n).toString() }]))[0]
        ?.status,
    ).toBe('STATUS_SUCCEED');

    const got = await client.queryMeasure({
      group: measureGroup.name,
      name: 'counter',
      timeRange: { beginMs: at - 60_000, endMs: at + 60_000 },
      projection: [{ family: 'searchable', tags: ['bucket', 'node', 'label'] }],
      fieldProjection: ['total', 'ratio', 'note'],
      limit: 50,
    });
    const mine = got.filter((d) => d.tags.node === 'n1');
    expect(mine).toHaveLength(1);
    expect(mine[0]?.fields.total).toBe('9');
  });

  it('round-trips every field type, and keeps them ordered against the spec', async () => {
    // Fields are positional against DataPointSpec.field_names, so a reordering
    // bug shows up as values landing in the wrong field rather than as an error.
    const at = now - (now % 1000) - 60_000;
    await client.writeMeasure(counter, [
      { timestampMs: at, tags: { bucket: 20260825, node: 'n2', label: 'y' },
        fields: { total: 7, ratio: 1.5, note: 'seven' } },
    ]);
    const got = await client.queryMeasure({
      group: measureGroup.name,
      name: 'counter',
      timeRange: { beginMs: at - 60_000, endMs: at + 60_000 },
      projection: [{ family: 'searchable', tags: ['bucket', 'node', 'label'] }],
      fieldProjection: ['total', 'ratio', 'note'],
      limit: 50,
    });
    const mine = got.filter((d) => d.tags.node === 'n2');
    expect(mine).toHaveLength(1);
    // INT arrives as a decimal string, FLOAT as a number, STRING as itself.
    expect(mine[0]?.fields.total).toBe('7');
    expect(mine[0]?.fields.ratio).toBe(1.5);
    expect(mine[0]?.fields.note).toBe('seven');
  });

  it('refuses a FIELD used as a query condition — fields are results, not filters', async () => {
    // A condition names a TAG. Pointing one at a field is not a filter that
    // matches nothing, it is a request the server rejects outright, which is
    // the behaviour worth pinning: a silent empty page would look like data.
    const at = now - (now % 1000);
    await expect(
      client.queryMeasure({
        group: measureGroup.name,
        name: 'counter',
        timeRange: { beginMs: at - 60_000, endMs: at + 60_000 },
        projection: [{ family: 'searchable', tags: ['bucket'] }],
        fieldProjection: ['total'],
        criteria: eq('total', 'TAG_TYPE_INT', 9),
        limit: 10,
      }),
    ).rejects.toThrow();
  });
});
