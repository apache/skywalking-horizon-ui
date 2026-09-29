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
import { describe, expect, it } from 'vitest';
import type { TemplateSyncRow } from '@/api/scopes/template-sync';
import {
  draftFromNamed,
  draftProblems,
  namedContent,
  namedPagesFromRows,
  pageIdProblem,
  pageNotServed,
  pinIdentity,
  pinLabel,
  sameContent,
  storedPageContent,
  takenPageIds,
  type PageDraft,
} from './alertPages';

function row(key: string, content: unknown, opts: { disabled?: boolean; kind?: TemplateSyncRow['kind']; locale?: string } = {}): TemplateSyncRow {
  const kind = opts.kind ?? 'alert';
  const name = `horizon.${kind}.${key}${opts.locale ? `.i18n.${opts.locale}` : ''}`;
  return {
    name,
    kind,
    key,
    ...(opts.locale ? { locale: opts.locale } : {}),
    status: opts.disabled ? 'disabled' : 'remote-only',
    effective: opts.disabled ? null : 'remote',
    remote: { id: `id-${key}`, configuration: JSON.stringify({ content, kind, name, version: 1 }), disabled: opts.disabled ?? false },
    bundled: null,
  };
}

const page = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, title, pinnedLayers: ['GENERAL'], ...extra });

describe('namedPagesFromRows', () => {
  const rows = [
    row('default', { pinnedLayers: ['GENERAL'], defaultWindowMs: 1_200_000, overviewAlarmsLimit: 200 }),
    row('page-setup', { pinnedLayers: ['MESH'] }),
    row('zeta', page('zeta', 'Zeta', { order: 5 })),
    row('b', page('b', 'Same')),
    row('a', page('a', 'Same')),
    row('first', page('first', 'Zzz', { order: 0 })),
    row('gone', page('gone', 'Gone'), { disabled: true }),
    row('services', { id: 'services' }, { kind: 'overview' }),
    row('zeta', { title: 'Zeta DE' }, { locale: 'de' }),
    row('moved', page('elsewhere', 'Moved')),
  ];

  it('keeps the enabled named pages only, sorted by order, title, id', () => {
    expect(namedPagesFromRows(rows).map((p) => p.id)).toEqual(['first', 'zeta', 'moved', 'a', 'b']);
  });

  it('reads the optional fields as absent, and flags a row whose content names another page', () => {
    const byId = new Map(namedPagesFromRows(rows).map((p) => [p.id, p]));
    expect(byId.get('a')).toMatchObject({ order: null, defaultWindowMs: null, mismatched: false });
    expect(byId.get('moved')?.mismatched).toBe(true);
  });

  it('counts every alert row as a taken id, disabled ones included', () => {
    expect([...takenPageIds(rows)].sort()).toEqual(['a', 'b', 'default', 'first', 'gone', 'moved', 'page-setup', 'zeta']);
  });

  it('reads the content of an enabled row only', () => {
    expect(storedPageContent(rows, 'zeta')).toEqual(page('zeta', 'Zeta', { order: 5 }));
    expect(storedPageContent(rows, 'gone')).toBeUndefined();
    expect(storedPageContent(rows, 'nope')).toBeUndefined();
  });
});

// The editor reads a stored page leniently, so what it cannot hold must still
// show: a row a save would write differently is flagged, and one it would
// write the same is not.
describe('a stored page the editor would write differently', () => {
  const one = (content: unknown) => namedPagesFromRows([row('team', content)])[0]!;

  it.each([
    ['an order that is not an integer', page('team', 'Team', { order: '10' })],
    ['a window that is not a choice', page('team', 'Team', { defaultWindowMs: 3_600_000 })],
    ['a field the page does not have', page('team', 'Team', { color: 'red' })],
    ['a pin that is not a string', page('team', 'Team', { pinnedLayers: ['GENERAL', 7] })],
    ['a title that is not a string', page('team', 'Team', { title: 7 })],
    ['a null order', page('team', 'Team', { order: null })],
    ['a title over the limit as stored', page('team', ` ${'x'.repeat(64)} `)],
    ['content that is not an object', ['GENERAL']],
  ])('needs a rewrite: %s', (_, content) => {
    const p = one(content);
    expect(p.needsRewrite).toBe(true);
    expect(pageNotServed(p)).toBe(true);
  });

  it('is served as stored, key order and spaces around a title aside', () => {
    const p = one({ pinnedLayers: ['GENERAL'], title: ' Team ', order: 10, defaultWindowMs: 7_200_000, id: 'team' });
    expect(p.needsRewrite).toBe(false);
    expect(pageNotServed(p)).toBe(false);
  });

  it.each([
    ['a blank title', page('team', '  ')],
    ['an order out of range', page('team', 'Team', { order: 2_000_000 })],
    ['no pin', page('team', 'Team', { pinnedLayers: [] })],
    ['a pin that does not parse', page('team', 'Team', { pinnedLayers: ['GENERAL[]'] })],
    ['the same pin twice', page('team', 'Team', { pinnedLayers: ['GENERAL', 'general'] })],
  ])('is not served when it breaks a page rule: %s', (_, content) => {
    const p = one(content);
    expect(p.needsRewrite).toBe(false);
    expect(pageNotServed(p)).toBe(true);
  });
});

describe('sameContent', () => {
  it('compares JSON deeply, ignoring key order', () => {
    expect(sameContent({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameContent({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameContent([1, 2], [2, 1])).toBe(false);
    expect(sameContent({}, [])).toBe(false);
    expect(sameContent(undefined, {})).toBe(false);
    // An inherited member is not a key.
    expect(sameContent({ constructor: 1 }, { toString: 1 })).toBe(false);
  });
});

describe('pageIdProblem', () => {
  const taken = new Set(['oncall', 'gone']);
  it.each([
    ['payments', null],
    ['p', null],
    ['9-lives_x', null],
    ['a'.repeat(64), null],
    ['a'.repeat(65), 'format'],
    ['Payments', 'format'],
    ['-lead', 'format'],
    ['has space', 'format'],
    ['', 'format'],
    ['default', 'reserved'],
    ['page-setup', 'reserved'],
    ['oncall', 'taken'],
    ['gone', 'taken'],
  ])('%s -> %s', (id, problem) => {
    expect(pageIdProblem(id, taken)).toBe(problem);
  });
});

describe('draftProblems', () => {
  const named: PageDraft = draftFromNamed({ title: 'On-call', order: null, pinnedLayers: ['GENERAL'], defaultWindowMs: null });

  it('needs a title, a valid order and 1..8 pins on a named page', () => {
    expect(draftProblems(named, false)).toEqual({});
    expect(draftProblems({ ...named, title: '  ' }, false)).toEqual({ title: 'blank' });
    expect(draftProblems({ ...named, title: 'x'.repeat(65) }, false)).toEqual({ title: 'long' });
    expect(draftProblems({ ...named, orderText: '1.5' }, false)).toEqual({ order: 'integer' });
    expect(draftProblems({ ...named, orderText: '1000001' }, false)).toEqual({ order: 'range' });
    expect(draftProblems({ ...named, pinnedLayers: [] }, false)).toEqual({ pins: 'none' });
    expect(draftProblems({ ...named, pinnedLayers: Array.from({ length: 9 }, (_, i) => `L${i}`) }, false)).toEqual({ pins: 'many' });
  });

  it('allows no pins on the default page, and checks its widget cap', () => {
    const def: PageDraft = { title: '', orderText: '', pinnedLayers: [], windowMs: 1_200_000, limitText: '200' };
    expect(draftProblems(def, true)).toEqual({});
    expect(draftProblems({ ...def, limitText: '' }, true)).toEqual({ limit: 'integer' });
    expect(draftProblems({ ...def, limitText: '5' }, true)).toEqual({ limit: 'range' });
  });

  it('flags a pin that does not parse, and the same tile pinned twice, on every page', () => {
    const def: PageDraft = { title: '', orderText: '', pinnedLayers: [], windowMs: 1_200_000, limitText: '200' };
    for (const [d, isDefault] of [[named, false], [def, true]] as const) {
      expect(draftProblems({ ...d, pinnedLayers: ['GENERAL', 'MESH[a,,b]'] }, isDefault)).toEqual({ pins: 'invalid' });
      expect(draftProblems({ ...d, pinnedLayers: ['GENERAL[a, b]', 'MESH', 'general[b,a]'] }, isDefault)).toEqual({ pins: 'duplicate' });
      expect(draftProblems({ ...d, pinnedLayers: ['CACHE', 'VIRTUAL_CACHE'] }, isDefault)).toEqual({ pins: 'duplicate' });
      expect(draftProblems({ ...d, pinnedLayers: ['GENERAL', 'GENERAL[a]'] }, isDefault)).toEqual({});
    }
  });
});

describe('namedContent', () => {
  it('writes order and window only when set', () => {
    const d = draftFromNamed({ title: ' On-call ', order: null, pinnedLayers: ['GENERAL[payments, -]'], defaultWindowMs: null });
    expect(namedContent('oncall', d)).toEqual({ id: 'oncall', title: 'On-call', pinnedLayers: ['GENERAL[payments, -]'] });
    expect(namedContent('oncall', { ...d, orderText: '20', windowMs: 7_200_000 })).toEqual({
      id: 'oncall',
      title: 'On-call',
      order: 20,
      pinnedLayers: ['GENERAL[payments, -]'],
      defaultWindowMs: 7_200_000,
    });
  });
});

describe('pins', () => {
  it('treats the same groups in another order as the same pin', () => {
    expect(pinIdentity('GENERAL[b, a]')).toBe(pinIdentity('general[a,b]'));
    expect(pinIdentity('CACHE')).toBe(pinIdentity('VIRTUAL_CACHE'));
    expect(pinIdentity('GENERAL')).not.toBe(pinIdentity('GENERAL[a]'));
  });

  it('labels a pin the way its tile reads', () => {
    expect(pinLabel({ layer: 'K8S_SERVICE' }, 'no group')).toBe('K8s Service');
    expect(pinLabel({ layer: 'GENERAL', groups: ['payments', ''] }, 'no group')).toBe('payments, no group · General');
  });
});
