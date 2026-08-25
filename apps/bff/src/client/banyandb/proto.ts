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
 * The BanyanDB wire contract, loaded at runtime from the vendored `.proto`
 * tree in `./proto` (pinned by `proto-sources.json`, kept honest by
 * `pnpm proto:check`).
 *
 * Runtime loading rather than generated stubs: generated code would need ASF
 * headers it does not carry and NOTICE entries it does not earn, and it dates
 * the moment the pin moves. The cost is that `.proto` is a RUNTIME ASSET — no
 * bundler carries it — so `scripts/package.mjs` copies this directory to
 * `dist/proto`, the Dockerfile copies that into the image, and `INCLUDE_DIR`
 * below resolves whichever of the two is present.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSync, type Options, type PackageDefinition } from '@grpc/proto-loader';

const HERE = dirname(fileURLToPath(import.meta.url));

// One expression covers both layouts, because the vendored directory and the
// packaged directory share a basename: in dev `<HERE>` is this folder, and in
// the bundle esbuild has inlined this file into `dist/server.js`, so `<HERE>`
// is `dist/`. `process.cwd()` is the last resort ONLY — a dist relocated and
// started from its own directory. Never rely on it alone: the server is
// routinely started from somewhere else, and cwd would then silently miss.
const BASES = [join(HERE, 'proto'), join(process.cwd(), 'proto')];

/** Every file in the tree imports this one, so its presence proves the whole
 *  vendored tree landed rather than just the directory existing. */
const SENTINEL = join('banyandb', 'v1', 'banyandb-common.proto');

function resolveIncludeDir(): string {
  const found = BASES.find((base) => existsSync(join(base, SENTINEL)));
  if (found) return found;
  // Fail at load, not at first query: a missing proto tree is a packaging
  // fault, and an operator is better served by a boot error naming the paths
  // than by a connection that dials and then cannot encode anything.
  throw new Error(
    `BanyanDB proto tree not found — looked for ${SENTINEL} in: ${BASES.join(', ')}. ` +
      `In a source checkout run \`pnpm proto:sync\`; in a packaged build this means ` +
      `scripts/package.mjs did not copy it into dist/proto.`,
  );
}

/** The include root handed to protobuf's resolver. Exported so a test can
 *  assert the tree is present without loading every definition. */
export const INCLUDE_DIR = resolveIncludeDir();

/**
 * `keepCase` because BanyanDB's tags are snake_case on the wire and silently
 * camel-casing them would rename every tag we write. `longs: String` because
 * BanyanDB's INT tags are 64-bit: a JS number loses precision above 2^53, and
 * the audit row id is deliberately a full-width integer — carrying it as a
 * string is the same choice the Postgres store already made for its bigint id.
 */
const OPTIONS: Options = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};

/** Files that together cover the surface this client uses. `database` carries
 *  the registry services (`ensureSchema`), `stream`/`measure` the read and
 *  write paths, `schema` the barrier that makes a freshly created schema safe
 *  to write to on a cluster, and `common`/`model` the shared messages the rest
 *  depend on. `banyandb-bydbql.proto` is vendored but deliberately not loaded:
 *  the query language is not how this client talks to the store. */
export const PROTO_FILES = [
  'banyandb/v1/banyandb-common.proto',
  'banyandb/v1/banyandb-model.proto',
  'banyandb/v1/banyandb-database.proto',
  'banyandb/v1/banyandb-stream.proto',
  'banyandb/v1/banyandb-measure.proto',
  'banyandb/v1/banyandb-schema.proto',
] as const;

/** Load the wire contract. Synchronous and intended to be called once at
 *  client construction — protobuf parsing is not something to repeat per RPC. */
export function loadBanyanDBProto(): PackageDefinition {
  return loadSync([...PROTO_FILES], { ...OPTIONS, includeDirs: [INCLUDE_DIR] });
}
