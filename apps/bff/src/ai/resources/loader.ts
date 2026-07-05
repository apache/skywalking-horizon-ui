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
 * AI resource loader. The assistant's PROSE — the system prompt, the RCA
 * playbooks — lives as plain .md / .json content under this directory, NOT as
 * template literals in the TS source, so it reads like documentation and can be
 * reviewed / edited as content. Files are read at runtime (same approach as
 * `bundled_templates`) with a candidate-path resolver that works in both the dev
 * source tree and the packaged bundle:
 *   - dev (tsx): this loader IS `src/ai/resources/loader.ts`, so `<HERE>` is the
 *     resources dir itself and `<HERE>/<rel>` resolves directly.
 *   - packaged bundle: esbuild inlines this file into `dist/server.js`, so
 *     `<HERE>` is `dist/`; `scripts/package.mjs` copies this dir to
 *     `dist/resources`, so `<HERE>/resources/<rel>` resolves.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// Ordered by how the code is running; the first that exists wins.
const BASES = [
  HERE, // dev source tree: <src>/ai/resources
  join(HERE, 'resources'), // packaged bundle: <dist>/resources
  join(process.cwd(), 'resources'), // a relocated dist run from its own dir
];

/** Read an AI resource file (relative to the resources dir), e.g.
 *  `prompts/system.md` or `skills/rca/latency.md`. Throws a clear error if the
 *  file can't be found in any candidate base — a fail-fast at boot beats a
 *  silently empty prompt. */
export function readResource(relPath: string): string {
  let lastErr: unknown;
  for (const base of BASES) {
    try {
      return readFileSync(join(base, relPath), 'utf8');
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `AI resource not found: ${relPath} (looked in ${BASES.map((b) => join(b, relPath)).join(', ')}) — ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}
