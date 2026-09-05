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
 * Drift gate for the UI's copy of the retired-verb aliases. The Roles board
 * reads RAW policy grants, so if this copy falls behind the BFF the board
 * tells an administrator a working role is denied — the failure the alias
 * exists to prevent, reintroduced one layer up.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VERB_ALIASES, aliasesFor } from './verbAliases';

const BFF_VERBS = resolve(process.cwd(), '../bff/src/rbac/verbs.ts');

/** Every `'key': [ 'a', 'b' ]` entry inside one BFF alias table. */
function bffTable(src: string, name: string): Record<string, string[]> {
  const start = src.indexOf(name);
  expect(start, `could not find ${name} in the BFF — did it move?`).toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf('\n};', start));
  const out: Record<string, string[]> = {};
  for (const m of body.matchAll(/'([^']+)':\s*\[([^\]]*)\]/g)) {
    out[m[1] as string] = [...(m[2] ?? '').matchAll(/'([^']+)'/g)].map((q) => q[1] as string);
  }
  return out;
}

describe('the retired-verb aliases', () => {
  it('match the BFF, which is the side that enforces', () => {
    const src = readFileSync(BFF_VERBS, 'utf8');
    const exact = bffTable(src, 'VERB_ALIASES');
    // `overview:*` is defined by reference to VERB_ALIASES['overview:write'],
    // so only the layer entry is a literal on that side.
    const areas = bffTable(src, 'RETIRED_AREA_ALIASES');
    const expected: Record<string, string[]> = {
      ...exact,
      ...areas,
      'overview:*': exact['overview:write'] ?? [],
    };
    for (const [grant, verbs] of Object.entries(expected)) {
      expect([...aliasesFor(grant)].sort(), `alias for ${grant}`).toEqual([...verbs].sort());
    }
    expect(Object.keys(VERB_ALIASES).sort()).toEqual(Object.keys(expected).sort());
  });

  it('a grant named after a prototype member resolves to nothing', () => {
    // A role may legally grant any string; `in` would have found Object's own
    // `toString` here and handed the caller a function to iterate.
    for (const g of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      expect(aliasesFor(g)).toEqual([]);
    }
  });
});
