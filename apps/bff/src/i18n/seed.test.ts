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
 * The seeder rewrites every bundled catalog in place, so the properties
 * that matter are the ones a bad rewrite would silently break: an
 * existing translation must survive, it must stay attached to its own
 * widget across a source reorder, and a second run must change nothing.
 *
 * Fixtures use prose with no lexicon entry, so any value in the output
 * came from the existing catalog rather than a lexicon fill.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedDir } from './seed.js';

const widget = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  type: 'line',
  expressions: [`${id}_expr`],
  ...extra,
});

const SOURCE = {
  key: 'DEMO',
  alias: 'Zzz Demo Layer',
  dashboards: {
    service: [
      widget('cpu', 'Zzz Processor Load'),
      widget('mem', 'Zzz Memory Use'),
      widget('disk', 'Zzz Disk Use'),
    ],
  },
};

/** Seed one temp dir and return the rewritten catalog. */
function seed(source: unknown, overlay: unknown): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'i18n-seed-'));
  writeFileSync(join(dir, 'demo.json'), JSON.stringify(source));
  writeFileSync(join(dir, 'demo.i18n.zh-CN.json'), JSON.stringify(overlay));
  seedDir(dir, 'zh-CN', false);
  return JSON.parse(readFileSync(join(dir, 'demo.i18n.zh-CN.json'), 'utf-8'));
}

const service = (o: Record<string, unknown>) =>
  (o.dashboards as { service: ({ id?: string; title?: string } | null)[] }).service;

describe('i18n:seed', () => {
  it('stamps ids onto a legacy positional catalog without moving anything', () => {
    const out = seed(SOURCE, {
      dashboards: { service: [{ title: '处理器负载' }, { title: '内存占用' }] },
    });
    expect(service(out)).toEqual([
      { id: 'cpu', title: '处理器负载' },
      { id: 'mem', title: '内存占用' },
    ]);
  });

  it('is idempotent — re-seeding an already migrated catalog changes nothing', () => {
    const once = seed(SOURCE, { dashboards: { service: [{ title: '处理器负载' }] } });
    const twice = seed(SOURCE, once);
    expect(twice).toEqual(once);
  });

  it('keeps every translation on its own widget when the source is reordered', () => {
    const migrated = seed(SOURCE, {
      dashboards: { service: [{ title: '处理器负载' }, { title: '内存占用' }, { title: '磁盘占用' }] },
    });
    const reordered = {
      ...SOURCE,
      dashboards: { service: [SOURCE.dashboards.service[2], SOURCE.dashboards.service[0], SOURCE.dashboards.service[1]] },
    };
    expect(service(seed(reordered, migrated))).toEqual([
      { id: 'disk', title: '磁盘占用' },
      { id: 'cpu', title: '处理器负载' },
      { id: 'mem', title: '内存占用' },
    ]);
  });

  it('holds a slot open for an untranslated widget so the catalog stays positionally aligned', () => {
    const out = seed(SOURCE, {
      dashboards: { service: [{ title: '处理器负载' }, null, { title: '磁盘占用' }] },
    });
    expect(service(out)).toEqual([{ id: 'cpu', title: '处理器负载' }, null, { id: 'disk', title: '磁盘占用' }]);
  });

  it('prunes scaffolding that translates nothing', () => {
    const out = seed(SOURCE, {
      dashboards: {
        service: [{ title: '处理器负载', expressions: [null] }, { title: '' }, {}],
      },
    });
    // The empty title, the empty object and the inert `expressions` are
    // all dropped; only the real translation survives, and the trailing
    // emptied slots are trimmed rather than left as padding.
    expect(service(out)).toEqual([{ id: 'cpu', title: '处理器负载' }]);
  });

  it('drops an entry whose widget the source no longer has', () => {
    const out = seed(SOURCE, {
      dashboards: { service: [{ id: 'cpu', title: '处理器负载' }, { id: 'gone', title: '孤儿翻译' }] },
    });
    expect(JSON.stringify(out)).not.toContain('孤儿翻译');
    expect(service(out)).toEqual([{ id: 'cpu', title: '处理器负载' }]);
  });

  it('reports what it dropped rather than deleting it in silence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'i18n-seed-'));
    writeFileSync(join(dir, 'demo.json'), JSON.stringify(SOURCE));
    writeFileSync(
      join(dir, 'demo.i18n.zh-CN.json'),
      JSON.stringify({ dashboards: { service: [{ id: 'gone', title: '孤儿翻译' }] } }),
    );
    const [report] = seedDir(dir, 'zh-CN', false);
    expect(report.dropped.join('\n')).toMatch(/id "gone" is not in the source/);
  });

  it('does not count a structural id towards translation coverage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'i18n-seed-'));
    writeFileSync(join(dir, 'demo.json'), JSON.stringify(SOURCE));
    writeFileSync(
      join(dir, 'demo.i18n.zh-CN.json'),
      JSON.stringify({ dashboards: { service: [{ id: 'cpu', title: '处理器负载' }] } }),
    );
    const [report] = seedDir(dir, 'zh-CN', false);
    // One translated string, not two — `alias` and the other widgets are gaps.
    expect(report.filled).toBe(1);
  });

  it('leaves an array whose source repeats an id addressed by position', () => {
    const source = { key: 'DEMO', metrics: [{ id: 'w', label: 'Zzz Write' }, { id: 'w', label: 'Zzz Write' }] };
    const out = seed(source, { metrics: [{ label: '写入' }, null] });
    expect(out.metrics).toEqual([{ label: '写入' }]);
  });
});
