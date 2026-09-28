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
 * Drift gate for the UI's copy of the layer-grant grammar. A copy that falls
 * behind the BFF shows a layer tab the server refuses, or hides one it allows.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LAYER_ALIAS, LAYER_SCOPED_VERBS, canonicalLayerKey, layerGrantCovers, parseLayerGrant } from './verbGrammar';

// Vitest runs with `--root src/`, so this resolves from the process cwd (apps/ui).
const BFF = resolve(process.cwd(), '../bff/src');

describe('the layer-grant grammar', () => {
  it('names the same layer-scoped verbs as the BFF', () => {
    const src = readFileSync(resolve(BFF, 'rbac/verbs.ts'), 'utf8');
    const block = /LAYER_SCOPED_VERBS[^=]*=\s*new Set<Verb>\(\[([^\]]*)\]\)/.exec(src);
    expect(block, 'could not find LAYER_SCOPED_VERBS in the BFF — did it move?').not.toBeNull();
    const bff = [...(block?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect([...LAYER_SCOPED_VERBS].sort()).toEqual(bff);
  });

  it('folds the same OAP layer aliases as the BFF', () => {
    const src = readFileSync(resolve(BFF, 'logic/templates/identity.ts'), 'utf8');
    const block = /const LAYER_ALIAS[^=]*=\s*\{([^}]*)\}/.exec(src);
    expect(block, 'could not find LAYER_ALIAS in the BFF — did it move?').not.toBeNull();
    const bff = Object.fromEntries([...(block?.[1] ?? '').matchAll(/(\w+):\s*'([^']+)'/g)].map((m) => [m[1], m[2]]));
    expect({ ...LAYER_ALIAS }).toEqual(bff);
    expect(canonicalLayerKey('database')).toBe('VIRTUAL_DATABASE');
    expect(canonicalLayerKey('general')).toBe('GENERAL');
  });

  it('parses a layer and its groups, `-` being the ungrouped services', () => {
    expect(parseLayerGrant('metrics:read@general')).toEqual({ verb: 'metrics:read', layer: 'GENERAL' });
    expect(parseLayerGrant('metrics:read@GENERAL[payments, risk]')).toEqual({
      verb: 'metrics:read',
      layer: 'GENERAL',
      groups: ['payments', 'risk'],
    });
    expect(parseLayerGrant('logs:read@GENERAL[-]')?.groups).toEqual(['']);
    expect(parseLayerGrant('metrics:read')).toBeNull();
  });

  it('refuses a malformed qualifier rather than widening it', () => {
    for (const bad of ['metrics:read@', '@GENERAL', 'metrics:read@GENERAL[]', 'metrics:read@GENERAL[a,,b]', 'metrics:read@GENERAL[a]x']) {
      expect(parseLayerGrant(bad), bad).toBeNull();
    }
  });

  it('covers only per-service reads, and nothing through admin', () => {
    const cover = (g: string, v: string) => {
      const parsed = parseLayerGrant(g);
      return parsed !== null && layerGrantCovers(parsed, v);
    };
    expect(cover('*@GENERAL', 'traces:read')).toBe(true);
    expect(cover('*:read@GENERAL', 'logs:read')).toBe(true);
    expect(cover('*@GENERAL', 'audit:read')).toBe(false);
    expect(cover('*:read@GENERAL', 'cluster:read')).toBe(false);
    expect(cover('cluster:read@GENERAL', 'cluster:read')).toBe(false);
    expect(cover('admin@GENERAL', 'metrics:read')).toBe(false);
  });
});
