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
 * The UI carries two copies of the BFF's verb matcher, so it also carries a
 * copy of the set of verbs a wildcard may not reach. This is the drift gate
 * between them: the BFF is the source of truth and the only side that
 * enforces, and a UI copy that disagrees produces the worst kind of RBAC bug —
 * a Roles board that promises a grant the server refuses.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WILDCARD_EXEMPT_VERBS } from './wildcardExempt';

// Vitest runs with `--root src/`, and under jsdom `import.meta.url` is not a
// file URL — so this resolves from the process cwd (apps/ui) instead.
const BFF_VERBS = resolve(process.cwd(), '../bff/src/rbac/verbs.ts');

describe('the wildcard-exempt set', () => {
  it('matches the BFF, which is the side that enforces', () => {
    const src = readFileSync(BFF_VERBS, 'utf8');
    const block = /WILDCARD_EXEMPT_VERBS[^=]*=\s*new Set<Verb>\(\[([^\]]*)\]\)/.exec(src);
    expect(block, 'could not find WILDCARD_EXEMPT_VERBS in the BFF — did it move?').not.toBeNull();
    const bff = [...(block?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect([...WILDCARD_EXEMPT_VERBS].sort()).toEqual(bff);
  });
});
