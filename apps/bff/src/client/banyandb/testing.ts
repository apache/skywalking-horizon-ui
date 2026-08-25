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
 * The BanyanDB fixture the integration tests run against.
 *
 * Imported ONLY by `*.it.test.ts`; nothing the server bundles reaches it, and
 * `testcontainers` is a dev dependency, so an accidental import from
 * production code fails the build loudly rather than shipping a test harness.
 *
 * `pnpm test:it` is the only gate: it uses its own vitest config, and
 * `pnpm test:unit` excludes these files, so nothing here decides whether the
 * tests run.
 *
 * The server is always this fixture's own container, on an ephemeral port.
 * There is deliberately no way to point the tests at an existing one: a fixed
 * port collides with whatever a developer already has up for the app, and a
 * shared server makes one run's leftovers another run's failure. The container
 * is torn down even if the test process is killed.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { BanyanDBClient } from './index.js';
import type { GroupDef, MeasureDef, StreamDef } from './schema.js';

const GRPC_PORT = 17912;
const HTTP_PORT = 17913;

/**
 * The server version, read from the ONE place the repo declares it.
 *
 * Not duplicated here: the e2e suite and these tests must exercise the same
 * BanyanDB, or a green IT says nothing about the stack that ships. The file is
 * READ rather than sourced — it holds an argon2 hash whose `$` segments a
 * shell would expand away.
 */
export function pinnedBanyanDBImage(): string {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
  const env = readFileSync(resolve(repo, 'test/e2e/script/env'), 'utf8');
  const commit = /^SW_BANYANDB_COMMIT=(.+)$/m.exec(env)?.[1]?.trim();
  if (!commit) throw new Error('SW_BANYANDB_COMMIT not found in test/e2e/script/env');
  return `ghcr.io/apache/skywalking-banyandb:${commit}`;
}

export interface BanyanDBFixture {
  client: BanyanDBClient;
  address: string;
  /** A name nobody else in this run will use. Groups are the unit of isolation:
   *  tests share a server, and a fixed name makes one test's leftovers another
   *  test's mystery failure. */
  name(suffix: string): string;
  stop(): Promise<void>;
}

/**
 * Start (or attach to) a BanyanDB and return a connected client.
 *
 * Readiness is the container's own health check — the HTTP gateway's
 * `/api/healthz`, which proxies a real gRPC health request and so answers
 * only once the port behind it serves. Waiting on the TCP port instead reports
 * ready while the registry still refuses calls, which surfaces later as a
 * flaky first test rather than a slow start.
 */
export async function startBanyanDB(): Promise<BanyanDBFixture> {
  const runId = Date.now().toString(36);
  const container: StartedTestContainer = await new GenericContainer(pinnedBanyanDBImage())
    .withCommand(['standalone'])
    .withExposedPorts(GRPC_PORT, HTTP_PORT)
    .withWaitStrategy(
      Wait.forHttp('/api/healthz', HTTP_PORT).forResponsePredicate((body) => body.includes('SERVING')),
    )
    .withStartupTimeout(120_000)
    .start();
  const address = `${container.getHost()}:${container.getMappedPort(GRPC_PORT)}`;

  const client = new BanyanDBClient({ kind: 'banyandb', address, deadlineMs: 20_000 });
  await client.connect();
  // The health check proves the process serves; this proves the SCHEMA
  // registry answers, which is the surface every test actually uses.
  await client.groups.list();

  return {
    client,
    address,
    name: (suffix) => `it_${runId}_${suffix}`,
    async stop() {
      client.close();
      await container.stop();
    },
  };
}

/** A group whose retention is short and whose shape is the simplest that works:
 *  one shard, no replica. Tests care about behaviour, not about topology. */
export function testGroup(name: string, catalog: GroupDef['catalog']): GroupDef {
  return {
    name,
    catalog,
    shardNum: 1,
    segmentInterval: { unit: 'UNIT_DAY', num: 1 },
    ttl: { unit: 'UNIT_DAY', num: 1 },
    replicas: 0,
  };
}

/**
 * The families in a definition that would store NOTHING — empty when the
 * definition is sound.
 *
 * Entity tag values live in the series key, never in the column data, so a
 * family left holding only entity tags is dropped at write time — and a read
 * whose projection then intersects to empty abandons the block entirely. The
 * rows are on disk and no query can return them. The server accepts all of
 * this, so it is worth failing a test fixture on rather than debugging twice.
 */
export function familiesThatStoreNothing(def: StreamDef | MeasureDef): string[] {
  const entity = new Set(def.entity);
  return def.families
    .filter((f) => f.tags.every((t) => entity.has(t.name)))
    .map((f) => f.name);
}
