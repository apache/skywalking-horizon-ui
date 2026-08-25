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
 * A binding that setup-time code reads must be declared above it.
 *
 * `watch(..., { immediate: true })` runs its callback synchronously, while the
 * module body is still evaluating, so a `let`/`const` further down is still in
 * its temporal dead zone. (`onMounted` is NOT such a case: it registers a
 * callback that fires at mount, by which point every module binding exists.) The result is `ReferenceError: Cannot access 'x'
 * before initialization`: setup aborts and the page renders blank, with nothing
 * in the console naming the cause. It type-checks and it bundles — only running
 * it reveals the fault, which is why this is asserted statically.
 *
 * The check follows the call: it takes the functions those callbacks invoke,
 * collects the identifiers each one reads, and requires every module-level
 * binding among them to be declared before the callback runs. Matching on
 * declaration names alone missed the real case — a `ref` with an ordinary name,
 * cleared inside a loader the watch calls.
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

/** `foo` in `() => void foo()` / `() => { foo(); }` — what the callback calls. */
const CALLS = /\b([a-z][A-Za-z0-9_]*)\s*\(/g;
/** A module-level binding. In a `<script setup>` that is column zero; in a
 *  composable the body sits one indent in. Anything deeper is some function's
 *  own local and cannot be in a dead zone at setup time. */
const BINDING_SFC = /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/;
const BINDING_TS = /^(?: {2})?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/;

/** Strings and comments name things without reading them — `loadFrom('local')`
 *  is not a reference to a binding called `local`. */
function code(body: string): string {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, ' ');
}
const SETUP_RUN = /immediate:\s*true/;

/** The body of `name`, however it is declared, or '' when not found. */
function bodyOf(src: string, name: string): string {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(|\\b(?:const|let)\\s+${name}\\s*=\\s*(?:async\\s*)?\\(`).exec(src);
  if (!m) return '';
  const open = src.indexOf('{', m.index);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i);
    }
  }
  return '';
}

describe('bindings that setup-time code reads', () => {
  it('are declared before the callback that reaches them', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(ROOT)) {
      const src = readFileSync(file, 'utf8');
      const lines = src.split('\n');

      // EVERY immediate watch, not just the first: the one that reaches a
      // late binding is often not the earliest in the file.
      for (let runsAt = 0; runsAt < lines.length; runsAt += 1) {
        if (!SETUP_RUN.test(lines[runsAt])) continue;

        // Everything declared after this callback fires is a candidate hazard.
        const binding = file.endsWith('.vue') ? BINDING_SFC : BINDING_TS;
        const declaredAfter = new Map<string, number>();
        for (let i = runsAt + 1; i < lines.length; i += 1) {
          const m = binding.exec(lines[i]);
          if (m && !declaredAfter.has(m[1])) declaredAfter.set(m[1], i + 1);
        }
        if (declaredAfter.size === 0) continue;

        // What this callback calls, and what those functions read.
        const window = lines.slice(Math.max(0, runsAt - 6), runsAt + 2).join('\n');
        const called = new Set(Array.from(window.matchAll(CALLS), (m) => m[1]));
        for (const fn of called) {
          const body = code(bodyOf(src, fn));
          if (!body.trim()) continue;
          for (const [name, at] of declaredAfter) {
            if (!new RegExp(`\\b${name}\\b`).test(body)) continue;
            // A name the function declares itself is its own local, not the
            // module binding that shares the spelling.
            if (new RegExp(`\\b(?:const|let)\\s+${name}\\b`).test(body)) continue;
            offenders.push(`${relative(ROOT, file)}:${at} — ${fn}() reads ${name}, declared after line ${runsAt + 1}`);
          }
        }
      }
    }

    // Every entry is a blank page waiting to happen: hoist the declaration
    // above the watch or onMounted whose callback reaches it.
    expect(offenders).toEqual([]);
  });
});
