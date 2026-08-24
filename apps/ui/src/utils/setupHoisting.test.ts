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
 * A `<script setup>` binding must be declared ABOVE anything that runs during
 * setup and reads it.
 *
 * `watch(..., { immediate: true })` and `onMounted` callbacks that fire
 * synchronously execute while the module body is still being evaluated, so a
 * `let`/`const` declared further down is still in its temporal dead zone. The
 * result is `ReferenceError: Cannot access 'x' before initialization`, setup
 * aborts, and the page renders blank — with nothing in the console pointing at
 * the cause. It type-checks and it builds; only running it reveals the fault.
 *
 * This scans for the shape rather than the symptom, because the shape is what
 * a reviewer can see. It is the rule CLAUDE.md states under "Dead-route /
 * parameter jumps".
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `apps/ui/src` — this file's own directory, one level up. */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(vue|ts)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** Request-ticket counters and the resettable refs that pair with them — the
 *  bindings most often introduced next to the loader that reads them, i.e.
 *  below the watch that fires it. */
const DECLARATION = /^\s*(?:let|const)\s+(\w*(?:Generation|RequestGeneration))\s*=/;
const RUNS_DURING_SETUP = /immediate:\s*true|onMounted\(/;

describe('bindings a synchronous setup callback reads', () => {
  it('are declared before anything that runs during setup', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(ROOT)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      const firstSetupRun = lines.findIndex((l) => RUNS_DURING_SETUP.test(l));
      if (firstSetupRun < 0) continue;

      for (let i = firstSetupRun + 1; i < lines.length; i += 1) {
        const m = DECLARATION.exec(lines[i]);
        if (!m) continue;
        // Only a binding the setup-time code could actually reach matters, so
        // require it to be referenced at or above that callback.
        const above = lines.slice(0, firstSetupRun + 1).join('\n');
        if (!above.includes(m[1])) {
          offenders.push(`${relative(ROOT, file)}:${i + 1} declares ${m[1]} after line ${firstSetupRun + 1}`);
        }
      }
    }

    // Every entry here is a blank page waiting to happen; hoist the
    // declaration above the watch or onMounted that reaches it.
    expect(offenders).toEqual([]);
  });
});
