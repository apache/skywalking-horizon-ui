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
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceMapStore } from './store.js';

/** Distinct, valid Source Map v3 JSON of a controllable size. `seed`
 *  varies the content so each map gets a distinct content-addressed id. */
function makeMap(seed: string, padBytes = 0): string {
  return JSON.stringify({
    version: 3,
    file: `${seed}.js`,
    sources: [`${seed}.ts`],
    names: [],
    mappings: 'AAAA',
    sourcesContent: ['x'.repeat(Math.max(1, padBytes))],
  });
}

const ONE_MAP = makeMap('a', 40);
const MAP_BYTES = Buffer.byteLength(ONE_MAP, 'utf8');

function bigBudget() {
  return { enabled: true, maxFileBytes: 1 << 20, maxTotalBytes: 1 << 30, maxFileCount: 1000 };
}

describe('SourceMapStore — validation', () => {
  it('rejects when disabled', () => {
    const s = new SourceMapStore(() => ({ ...bigBudget(), enabled: false }));
    expect(s.addUpload('a.map', makeMap('a', 40))).toEqual({ ok: false, error: 'disabled' });
  });

  it('rejects non-JSON / non-v3 content', () => {
    const s = new SourceMapStore(() => bigBudget());
    expect(s.addUpload('a.map', 'not json').ok).toBe(false);
    expect(s.addUpload('a.map', JSON.stringify({ version: 2, mappings: '' })).ok).toBe(false);
    expect(s.addUpload('a.map', '').ok).toBe(false);
  });

  it('rejects a file larger than maxFileBytes', () => {
    const s = new SourceMapStore(() => ({ ...bigBudget(), maxFileBytes: 20 }));
    expect(s.addUpload('a.map', makeMap('a', 200))).toEqual({ ok: false, error: 'too_large' });
  });

  it('content-addresses ids — re-uploading the same file dedups', () => {
    const s = new SourceMapStore(() => bigBudget());
    const first = s.addUpload('a.map', ONE_MAP);
    const again = s.addUpload('a.map', ONE_MAP);
    expect(first.ok && again.ok && first.map.id === again.map.id).toBe(true);
    expect(s.list().length).toBe(1);
  });
});

describe('SourceMapStore — eviction', () => {
  it('evicts the least-recently-used upload past the byte budget', () => {
    // Budget fits two maps but not three.
    const s = new SourceMapStore(() => ({ ...bigBudget(), maxTotalBytes: MAP_BYTES * 2 + 10 }));
    const a = s.addUpload('a.map', makeMap('a', 40));
    const b = s.addUpload('b.map', makeMap('b', 40));
    const c = s.addUpload('c.map', makeMap('c', 40));
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(s.has(a.map.id)).toBe(false); // oldest evicted
    expect(s.has(b.map.id)).toBe(true);
    expect(s.has(c.map.id)).toBe(true);
    expect(s.usage().usedBytes).toBeLessThanOrEqual(MAP_BYTES * 2 + 10);
  });

  it('evicts past the file-count cap independent of bytes', () => {
    const s = new SourceMapStore(() => ({ ...bigBudget(), maxFileCount: 2 }));
    const a = s.addUpload('a.map', makeMap('a', 10));
    s.addUpload('b.map', makeMap('b', 10));
    s.addUpload('c.map', makeMap('c', 10));
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(s.list().length).toBe(2);
    expect(s.has(a.map.id)).toBe(false);
  });

  it('rejects an upload larger than maxTotalBytes (even under maxFileBytes)', () => {
    const s = new SourceMapStore(() => ({ enabled: true, maxFileBytes: 1 << 20, maxTotalBytes: 50, maxFileCount: 100 }));
    expect(s.addUpload('a.map', makeMap('a', 200))).toEqual({ ok: false, error: 'too_large' });
  });

  it('lowering maxTotalBytes via hot reload trims resident uploads on next read', () => {
    const cfg = { enabled: true, maxFileBytes: 1 << 20, maxTotalBytes: 1 << 30, maxFileCount: 100 };
    const s = new SourceMapStore(() => cfg);
    s.addUpload('a.map', makeMap('a', 40));
    s.addUpload('b.map', makeMap('b', 40));
    s.addUpload('c.map', makeMap('c', 40));
    expect(s.list().length).toBe(3);
    cfg.maxTotalBytes = MAP_BYTES + 5; // room for ~1 map
    expect(s.list().length).toBe(1); // trimmed on read
    expect(s.usage().usedBytes).toBeLessThanOrEqual(MAP_BYTES + 5);
  });
});

describe('SourceMapStore — uploads vs mounts', () => {
  it('removes an upload but not a mount; getTraceMap parses both', async () => {
    const s = new SourceMapStore(() => bigBudget());
    const up = s.addUpload('app.js.map', ONE_MAP);
    expect(up.ok).toBe(true);
    if (!up.ok) return;
    expect(await s.getTraceMap(up.map.id)).toBeTruthy();
    expect(s.remove(up.map.id)).toBe(true);
    expect(s.has(up.map.id)).toBe(false);
    expect(await s.getTraceMap(up.map.id)).toBeNull();

    const dir = await mkdtemp(join(tmpdir(), 'sm-store-'));
    await writeFile(join(dir, 'mounted.js.map'), makeMap('mounted', 10), 'utf8');
    await writeFile(join(dir, 'ignore.txt'), 'not a map', 'utf8');
    await s.loadMountDir(dir);
    const mount = s.list().find((d) => d.origin === 'mount');
    expect(mount).toBeTruthy();
    if (!mount) return;
    expect(mount.label).toBe('mounted.js.map');
    expect(s.remove(mount.id)).toBe(false); // mounts are durable, not deletable
    expect(await s.getTraceMap(mount.id)).toBeTruthy(); // read from disk on demand
  });

  it('tolerates a missing mount dir', async () => {
    const s = new SourceMapStore(() => bigBudget());
    await expect(s.loadMountDir(join(tmpdir(), 'does-not-exist-xyz'))).resolves.toBeUndefined();
    expect(s.list().length).toBe(0);
  });

  it('validates mounted maps at index time — invalid/non-v3 are skipped', async () => {
    const s = new SourceMapStore(() => bigBudget());
    const dir = await mkdtemp(join(tmpdir(), 'sm-mount-validate-'));
    await writeFile(join(dir, 'good.js.map'), makeMap('good', 10), 'utf8');
    await writeFile(join(dir, 'garbage.js.map'), 'not json at all', 'utf8');
    await writeFile(join(dir, 'v2.js.map'), JSON.stringify({ version: 2, mappings: '' }), 'utf8');
    await s.loadMountDir(dir);
    const mounts = s.list().filter((d) => d.origin === 'mount');
    expect(mounts.map((m) => m.label)).toEqual(['good.js.map']);
  });

  it('caps the mounted set at maxFileCount', async () => {
    const s = new SourceMapStore(() => ({ ...bigBudget(), maxFileCount: 2 }));
    const dir = await mkdtemp(join(tmpdir(), 'sm-mount-cap-'));
    for (const seed of ['m1', 'm2', 'm3', 'm4']) {
      await writeFile(join(dir, `${seed}.js.map`), makeMap(seed, 10), 'utf8');
    }
    await s.loadMountDir(dir);
    expect(s.list().filter((d) => d.origin === 'mount').length).toBe(2);
  });
});

describe('SourceMapStore — live config (hot reload)', () => {
  it('reads enabled + budgets through the getter on every call', () => {
    const cfg = { enabled: true, maxFileBytes: 1 << 20, maxTotalBytes: 1 << 30, maxFileCount: 100 };
    const s = new SourceMapStore(() => cfg);
    expect(s.enabled).toBe(true);
    expect(s.addUpload('a.map', ONE_MAP).ok).toBe(true);
    // Flip config live — no reconstruction.
    cfg.enabled = false;
    expect(s.enabled).toBe(false);
    expect(s.addUpload('b.map', makeMap('b', 40))).toEqual({ ok: false, error: 'disabled' });
    cfg.enabled = true;
    expect(s.usage().maxFileCount).toBe(100);
    cfg.maxFileCount = 7;
    expect(s.usage().maxFileCount).toBe(7);
  });
});
