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

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateInfra3dConfig, stripCommentKeys } from './validate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED = join(HERE, '../../bundled_templates/infra-3d/config.json');

describe('the shipped 3D-map config passes the boundary that publishes it', () => {
  // The regression this pins: the file carries `$comment` / `$note` authoring
  // notes, `.strict()` counted them as unknown fields, and the same validator
  // guards `push-bundled` and `sync-all` — so "reset to bundled" 400'd and a
  // sync silently skipped the row. The map could never be restored to what
  // Horizon ships.
  it('validates with its authoring notes in place', () => {
    const raw: unknown = JSON.parse(readFileSync(BUNDLED, 'utf8'));
    expect((raw as Record<string, unknown>)['$comment']).toBeTypeOf('string');

    const result = validateInfra3dConfig(raw);
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it('still refuses an unknown field that is not an authoring note', () => {
    const raw = JSON.parse(readFileSync(BUNDLED, 'utf8')) as Record<string, unknown>;
    raw.notAKnownField = 1;

    const result = validateInfra3dConfig(raw);
    expect(result.ok).toBe(false);
  });

  // Exact names, not a `$` prefix: a typo has to surface rather than be
  // swallowed by a wildcard.
  it('does not silently accept a mistyped note key', () => {
    const raw = JSON.parse(readFileSync(BUNDLED, 'utf8')) as Record<string, unknown>;
    raw.$note2 = 'typo';

    expect(validateInfra3dConfig(raw).ok).toBe(false);
  });

  it('strips notes at every depth, leaving everything else untouched', () => {
    const stripped = stripCommentKeys({
      $comment: 'gone',
      keep: 1,
      nested: { $note: 'gone', deep: [{ $comment: 'gone', value: 'kept' }] },
    });

    expect(stripped).toEqual({ keep: 1, nested: { deep: [{ value: 'kept' }] } });
  });
});
