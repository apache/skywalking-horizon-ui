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
 * `i18n:validate` gates every bundled catalog in CI, so its NEGATIVE
 * cases are what matter: a run over the shipped catalogs only ever
 * proves the happy path. Each case below is one well-formed source
 * template plus one catalog with a single defect, so a finding can only
 * come from that defect.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDir, type Finding } from './validate.js';

const widget = (id: string, title: string) => ({ id, title, type: 'line', expressions: [`${id}_e`] });

const SOURCE = {
  key: 'DEMO',
  alias: 'Demo',
  dashboards: { service: [widget('cpu', 'CPU'), widget('mem', 'Memory'), widget('disk', 'Disk')] },
};

/** Write a source template + one zh-CN catalog into a fresh temp dir and
 *  validate it. Only findings for that catalog are returned — the
 *  missing-overlay-per-locale check fires for the other six locales and
 *  is not what these cases are about. */
function check(overlay: unknown, source: unknown = SOURCE): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'i18n-validate-'));
  writeFileSync(join(dir, 'demo.json'), JSON.stringify(source));
  writeFileSync(join(dir, 'demo.i18n.zh-CN.json'), JSON.stringify(overlay));
  const findings: Finding[] = [];
  validateDir(dir, 'layers', findings);
  return findings
    .filter((f) => f.file.endsWith('demo.i18n.zh-CN.json'))
    .map((f) => `${f.path}: ${f.message}`);
}

const migrated = {
  alias: '演示',
  dashboards: { service: [{ id: 'cpu', title: '处理器' }, { id: 'mem', title: '内存' }] },
};

describe('i18n:validate — id-addressed catalogs', () => {
  it('passes a correctly migrated catalog', () => {
    expect(check(migrated)).toEqual([]);
  });

  it('reports an entry addressing a widget the source no longer has', () => {
    const overlay = { dashboards: { service: [{ id: 'gone', title: '不存在' }] } };
    expect(check(overlay)).toContain('dashboards.service.0: no source entry with id "gone"');
  });

  it('reports two entries claiming the same widget', () => {
    const overlay = { dashboards: { service: [{ id: 'cpu', title: '处理器' }, { id: 'cpu', title: '第二个' }] } };
    expect(check(overlay)).toContain('dashboards.service.1: duplicate overlay entry for id "cpu"');
  });

  it('reports an array mixing id-addressed and positional entries', () => {
    const overlay = { dashboards: { service: [{ title: '按位置' }, { id: 'mem', title: '内存' }] } };
    expect(check(overlay).join('\n')).toMatch(/mixes id-addressed and positional entries/);
  });

  it('reports a catalog that has not been migrated', () => {
    const overlay = { dashboards: { service: [{ title: '处理器' }, { title: '内存' }] } };
    expect(check(overlay).join('\n')).toMatch(/carry no "id"/);
  });

  it('reports an overlay array longer than its source', () => {
    const overlay = {
      dashboards: { service: [{ id: 'cpu', title: '处理器' }, null, null, null, null] },
    };
    expect(check(overlay)).toContain('dashboards.service: overlay has 5 entries for 3 source entries');
  });

  it('reports an id on an array whose source entries are not uniquely identified', () => {
    // `deployment.roleToRole[].metrics` repeats an id on purpose; such an
    // array matches by position and an id there means nothing.
    const source = { key: 'DEMO', metrics: [{ id: 'w', label: 'Write' }, { id: 'w', label: 'Write' }] };
    const overlay = { metrics: [{ id: 'w', label: '写入' }] };
    expect(check(overlay, source).join('\n')).toMatch(/not id-addressable/);
  });

  it('does not treat a structural id as an untranslatable-field violation', () => {
    expect(check(migrated).join('\n')).not.toMatch(/not in the translatable allowlist/);
  });

  it('still reports a genuinely non-translatable field', () => {
    const overlay = { dashboards: { service: [{ id: 'cpu', title: '处理器', type: '线' }] } };
    expect(check(overlay).join('\n')).toMatch(/field "type" is not in the translatable allowlist/);
  });

  it('still reports an id at a level that is not an array entry', () => {
    // An overview catalog carrying a top-level `id` would rename the
    // dashboard it translates if it were ever merged.
    expect(check({ id: 'demo', alias: '演示' }, { id: 'demo', key: 'DEMO', alias: 'Demo' }).join('\n')).toMatch(
      /field "id" is not in the translatable allowlist/,
    );
  });
});
