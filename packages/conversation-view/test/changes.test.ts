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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mountConversationView, type AszViewDocument, type AszWorkspaceChange, type ConversationView } from '../src/index.js';
import { changeRoots, ConversationModel, groupChanges, observationOf, tallyChanges } from '../src/model.js';

/** The OAP's workspace-changes fixture, which equals the Sessionizer's own
 *  scenario output: three records from two producers over four files, every
 *  record joined to a step. */
const fixture = JSON.parse(readFileSync(resolve('test/fixtures/workspace-changes.json'), 'utf8')) as AszViewDocument;
/** The original example, from before change records existed. */
const plain = JSON.parse(readFileSync(resolve('test/fixtures/asz-view-example.json'), 'utf8')) as AszViewDocument;

const BASH = 'tool/s2-tool';
const EDIT = 'tool/s3-tool';

let view: ConversationView | null = null;
let host: HTMLElement | null = null;

function mount(doc: AszViewDocument = fixture): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  view = mountConversationView(host, { document: doc });
  return host;
}

function openFold(root: HTMLElement): void {
  root.querySelector<HTMLButtonElement>('.acv-fold[data-work]')!.click();
}

function withRecords(doc: AszViewDocument, records: AszWorkspaceChange[]): AszViewDocument {
  const copy = JSON.parse(JSON.stringify(doc)) as AszViewDocument;
  copy.workspace_changes = records;
  copy.summary.changes = records.length;
  return copy;
}

const bashRecord = fixture.workspace_changes!.find((r) => r.step === BASH)!;

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

describe('the model over change records', () => {
  it('joins records to steps by `step`, and keeps the ones no step carries apart', () => {
    const m = new ConversationModel(fixture);
    expect(m.workspaceChanges).toHaveLength(3);
    expect(m.changesOf(BASH)).toHaveLength(1);
    expect(m.changesOf(EDIT)[0]!.captured_by).toBe('claude-code');
    expect(m.step(BASH)!.hasChanges).toBe(true);
    expect(m.step('call/s2-call')!.hasChanges).toBe(false);
    const gap: AszWorkspaceChange = { ...bashRecord, id: 'gap/r/1', step: '', tool: undefined, basis: 'unattributed' };
    const withGap = new ConversationModel(withRecords(fixture, [gap]));
    expect(withGap.workspaceChanges).toHaveLength(1);
    expect(withGap.changesOf(BASH)).toHaveLength(0);
  });

  it('counts unique files, and carries line counts only when one record covers the step', () => {
    const one = tallyChanges([bashRecord]);
    expect(one).toEqual({ files: 2, incomplete: false, additions: 2, deletions: 1, observation: 'files' });
    // The plugin's record of the same call: the same file, its own net.
    const plugin: AszWorkspaceChange = { ...bashRecord, captured_by: 'asz-plugin', changes: [bashRecord.changes![0]!] };
    const both = tallyChanges([bashRecord, plugin]);
    expect(both.files).toBe(2);
    expect(both.additions).toBeNull();
    expect(both.deletions).toBeNull();
  });

  it('tells a skipped, an unknown and an empty observation apart', () => {
    expect(observationOf({ ...bashRecord, basis: 'skipped_read_only', changes: [], changed_files: null })).toBe('skipped');
    expect(observationOf({ ...bashRecord, changes: [], changed_files: null })).toBe('unknown');
    expect(observationOf({ ...bashRecord, changes: [], changed_files: 0 })).toBe('none');
    expect(observationOf(bashRecord)).toBe('files');
    expect(tallyChanges([{ ...bashRecord, basis: 'skipped_read_only', changes: [], changed_files: null }]).observation).toBe('skipped');
  });

  it('groups a step’s records by workspace root, the runtime’s record preferred', () => {
    const other: AszWorkspaceChange = { ...bashRecord, id: `${bashRecord.id}/r2`, root: { path: '/Users/dev/other' } };
    const runtime: AszWorkspaceChange = { ...bashRecord, captured_by: 'claude-code', basis: 'runtime_reported' };
    const groups = groupChanges([bashRecord, other, runtime]);
    expect(groups.map((g) => g.root)).toEqual(['/Users/dev/scenario', '/Users/dev/other']);
    expect(groups[0]!.records).toHaveLength(2);
    expect(groups[0]!.preferred).toBe(runtime);
  });

  it('lists a shared file once under its root, with every record that saw it', () => {
    const a: AszWorkspaceChange = { ...bashRecord, changes: [{ ...bashRecord.changes![0]!, attribution: 'shared', windows: ['a', 'b'] }] };
    const b: AszWorkspaceChange = { ...a, id: 'b', captured_by: 'asz-plugin' };
    const roots = changeRoots([a, b]);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.files).toHaveLength(1);
    expect(roots[0]!.files[0]!.entries).toHaveLength(2);
    expect(roots[0]!.files[0]!.entries.every((e) => e.change.attribution === 'shared')).toBe(true);
  });

  it('treats a scan that stopped early as an incomplete observation, never as nothing changed', () => {
    const partial: AszWorkspaceChange = { ...bashRecord, coverage: 'partial', gaps: ['scan timed out'], changes: [], changed_files: 0 };
    expect(observationOf(partial)).toBe('unknown');
    const withFiles: AszWorkspaceChange = { ...bashRecord, coverage: 'partial', gaps: ['scan timed out'] };
    const t = tallyChanges([withFiles]);
    expect(t.observation).toBe('files');
    expect(t.incomplete).toBe(true);
    expect(tallyChanges([bashRecord]).incomplete).toBe(false);
  });
});

describe('the strip and the panel', () => {
  it('counts the records in the strip and lists every file by root in the panel', () => {
    const root = mount();
    const toggle = root.querySelector<HTMLButtonElement>('.acv-changes-toggle')!;
    expect(toggle.textContent).toContain('3 changes');
    expect(root.querySelector<HTMLElement>('.acv-changes')!.hidden).toBe(true);
    toggle.click();
    const panel = root.querySelector<HTMLElement>('.acv-changes')!;
    expect(panel.hidden).toBe(false);
    expect(root.querySelector('.acv-changes-title')!.textContent).toContain('3 records · 3 files');
    expect(panel.textContent).toContain('server.go');
    expect(panel.textContent).toContain('config.yaml');
    expect(panel.textContent).toContain('notes.txt');
    expect(panel.querySelectorAll('[data-goto]').length).toBeGreaterThanOrEqual(3);
    expect(panel.querySelector('.acv-panel-hint')!.textContent).toBe('Click a record to open the step that made it, on its Changes tab.');
    expect(panel.querySelector('[data-goto]')!.textContent).toMatch(/ →$/);
    expect(panel.textContent).not.toContain('outside observed tool windows');
  });

  it('shows nothing about changes for a document that has none', () => {
    const root = mount(plain);
    expect(root.querySelector('.acv-changes-toggle')).toBeNull();
    expect(root.querySelector<HTMLElement>('[data-tab="changes"]')!.hidden).toBe(true);
    openFold(root);
    expect(root.querySelector('.acv-change-pill')).toBeNull();
    expect(root.querySelector('.acv-clip-mark')).toBeNull();
  });

  it('lists a tool record whose step the fold does not know under its root, not as an unobserved change', () => {
    const orphan: AszWorkspaceChange = { ...bashRecord, id: 'lost-tool', tool: 'lost-tool', step: '' };
    const root = mount(withRecords(fixture, [orphan]));
    root.querySelector<HTMLButtonElement>('.acv-changes-toggle')!.click();
    const panel = root.querySelector<HTMLElement>('.acv-changes')!;
    expect(panel.textContent).not.toContain('Changes outside observed tool windows');
    expect(panel.textContent).toContain('no step');
    expect(panel.textContent).toContain('server.go');
  });

  it('marks a file count as a floor when a record is incomplete', () => {
    const partial: AszWorkspaceChange = { ...bashRecord, coverage: 'partial', gaps: ['scan timed out'] };
    const root = mount(withRecords(fixture, [partial]));
    root.querySelector<HTMLButtonElement>('.acv-changes-toggle')!.click();
    expect(root.querySelector('.acv-changes-title')!.textContent).toContain('2+ files');
    openFold(root);
    expect(root.querySelector(`[data-card="${BASH}"] .acv-change-pill`)!.textContent).toContain('2+ files');
  });

  it('puts an unattributed record under the changes no observed window made', () => {
    const gap: AszWorkspaceChange = {
      ...bashRecord,
      id: 'gap/root/3',
      step: '',
      tool: undefined,
      tool_name: undefined,
      basis: 'unattributed',
      changes: [{ ...bashRecord.changes![0]!, path: 'README.md', attribution: 'outside_any_window' }],
    };
    const root = mount(withRecords(fixture, [...fixture.workspace_changes!, gap]));
    root.querySelector<HTMLButtonElement>('.acv-changes-toggle')!.click();
    const panel = root.querySelector<HTMLElement>('.acv-changes')!;
    expect(panel.textContent).toContain('Changes outside observed tool windows');
    expect(panel.textContent).toContain('README.md');
  });
});

describe('the tool card', () => {
  it('wears a pill with the file and line counts, opens the files inline, and keeps the selection', () => {
    const root = mount();
    openFold(root);
    const card = root.querySelector<HTMLElement>(`[data-card="${BASH}"]`)!;
    expect(card.tagName).toBe('DIV');
    expect(card.getAttribute('role')).toBe('button');
    const pill = card.querySelector<HTMLButtonElement>('.acv-change-pill')!;
    expect(pill.textContent).toContain('2 files');
    expect(pill.textContent).toContain('+2');
    expect(pill.textContent).toContain('−1');
    expect(pill.querySelector('use')!.getAttribute('href')).toBe('#acv-i-changes');
    const before = view!.getState().step;
    pill.click();
    expect(view!.getState().step).toBe(before);
    const rows = root.querySelectorAll<HTMLButtonElement>(`[data-card="${BASH}"] [data-change-file]`);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('server.go');
    rows[0]!.click();
    const diff = root.querySelector<HTMLElement>(`[data-card="${BASH}"] .acv-diff`)!;
    expect(diff.querySelector('.acv-diff-line.del')!.textContent).toBe('-var timeout = 10');
    expect(diff.querySelector('.acv-diff-line.add')!.textContent).toBe('+var timeout = 30');
    expect(view!.getState().step).toBe(before);
    // The Edit step's pill: one file, the runtime's own record.
    const edit = root.querySelector<HTMLElement>(`[data-card="${EDIT}"] .acv-change-pill`)!;
    expect(edit.textContent).toContain('1 file');
  });

  it('wears the read-only mark for a call the plugin classed read-only, and says so in the tab', () => {
    const skipped: AszWorkspaceChange = { ...bashRecord, basis: 'skipped_read_only', changes: [], changed_files: null };
    const root = mount(withRecords(fixture, [skipped]));
    openFold(root);
    const pill = root.querySelector<HTMLButtonElement>(`[data-card="${BASH}"] .acv-change-pill`)!;
    expect(pill.classList.contains('readonly')).toBe(true);
    expect(pill.getAttribute('title')).toContain('no scan ran');
    expect(pill.textContent).toContain('read-only');
    expect(pill.querySelector('use')!.getAttribute('href')).toBe('#acv-i-readonly');
    expect(root.querySelector(`.acv-clip[data-node="${BASH}"] use`)!.getAttribute('href')).toBe('#acv-i-readonly');
    view!.setState({ step: BASH });
    root.querySelector<HTMLButtonElement>('[data-tab="changes"]')!.click();
    expect(root.querySelector('.acv-inspector-body')!.textContent).toContain('not observed');
    expect(root.querySelector('.acv-inspector-body')!.textContent).not.toContain('no changed file');
  });

  it('says unknown and no files changed in their own words', () => {
    const unknown: AszWorkspaceChange = { ...bashRecord, changes: [], changed_files: null };
    let root = mount(withRecords(fixture, [unknown]));
    openFold(root);
    expect(root.querySelector(`[data-card="${BASH}"] .acv-change-pill`)!.textContent).toContain('files unknown');
    view!.destroy();
    host!.remove();
    const none: AszWorkspaceChange = { ...bashRecord, changes: [], changed_files: 0 };
    root = mount(withRecords(fixture, [none]));
    openFold(root);
    expect(root.querySelector(`[data-card="${BASH}"] .acv-change-pill`)!.textContent).toContain('no files changed');
  });

  it('keeps every root’s records apart when one call touched two roots', () => {
    const other: AszWorkspaceChange = {
      ...bashRecord,
      id: `${bashRecord.id}/r2`,
      root: { path: '/Users/dev/other' },
      changes: [{ ...bashRecord.changes![1]!, path: 'notes.md' }],
    };
    const root = mount(withRecords(fixture, [bashRecord, other]));
    openFold(root);
    const pill = root.querySelector<HTMLButtonElement>(`[data-card="${BASH}"] .acv-change-pill`)!;
    expect(pill.textContent).toContain('3 files');
    expect(pill.textContent).not.toContain('+');
    pill.click();
    const inline = root.querySelector<HTMLElement>(`[data-card="${BASH}"] .acv-changes-inline`)!;
    expect(inline.querySelectorAll('.acv-change-root')).toHaveLength(2);
    expect(inline.querySelectorAll('.acv-change-record')).toHaveLength(2);
  });

  it('marks the step’s clip on the timeline', () => {
    const root = mount();
    expect(root.querySelector(`.acv-clip[data-node="${BASH}"] .acv-clip-mark`)).not.toBeNull();
    expect(root.querySelector(`.acv-clip[data-node="call/s2-call"] .acv-clip-mark`)).toBeNull();
  });
});

describe('the inspector', () => {
  it('shows the Changes tab only for a step with records, with the record’s provenance', () => {
    const root = mount();
    view!.setState({ step: 'call/s2-call' });
    expect(root.querySelector<HTMLElement>('[data-tab="changes"]')!.hidden).toBe(true);
    view!.setState({ step: EDIT });
    const tab = root.querySelector<HTMLButtonElement>('[data-tab="changes"]')!;
    expect(tab.hidden).toBe(false);
    tab.click();
    const body = root.querySelector<HTMLElement>('.acv-inspector-body')!;
    expect(body.textContent).toContain('claude-code');
    expect(body.textContent).toContain('runtime_reported');
    expect(body.textContent).toContain('seq 1 · row 8 · block 1');
    expect(body.textContent).toContain('server.go');
    // Two producers, one call: both records, the runtime's first, never merged.
    view!.destroy();
    host!.remove();
    const plugin: AszWorkspaceChange = { ...fixture.workspace_changes!.find((r) => r.step === EDIT)!, captured_by: 'asz-plugin', basis: 'tool_window', tool_name: 'Edit' };
    const twice = mount(withRecords(fixture, [plugin, ...fixture.workspace_changes!]));
    view!.setState({ step: EDIT });
    twice.querySelector<HTMLButtonElement>('[data-tab="changes"]')!.click();
    const heads = [...twice.querySelectorAll('.acv-inspector-body .acv-producer')].map((el) => el.textContent);
    expect(heads).toEqual(['claude-code', 'asz-plugin']);
  });

  it('opens Evidence on the change record’s own landed position, and keeps the card and the tab in step', () => {
    const root = mount();
    openFold(root);
    view!.setState({ step: BASH });
    root.querySelector<HTMLButtonElement>('[data-tab="changes"]')!.click();
    // The plugin's record lives in a changes file the step's own refs never name.
    root.querySelector<HTMLButtonElement>('.acv-inspector-body [data-to-evidence]')!.click();
    const chips = [...root.querySelectorAll('.acv-ref-chip')].map((c) => c.textContent?.replace(/\s+/g, ' ').trim());
    expect(chips.some((c) => c?.includes('change record') && c.includes('seq 2 · row 1'))).toBe(true);
    // Opening a file from the tab opens it on the card too; the activated row keeps focus.
    root.querySelector<HTMLButtonElement>('[data-tab="changes"]')!.click();
    const row = root.querySelector<HTMLButtonElement>('.acv-inspector-body [data-change-file]')!;
    row.focus();
    row.click();
    expect(root.querySelector('.acv-inspector-body .acv-diff')).not.toBeNull();
    root.querySelector<HTMLButtonElement>(`[data-card="${BASH}"] .acv-change-pill`)!.click();
    expect(root.querySelector(`[data-card="${BASH}"] .acv-diff`)).not.toBeNull();
    expect((document.activeElement as HTMLElement | null)?.dataset.changesToggle).toBe(BASH);
  });

  it('matches the change record’s position by block, and drops it when the selection moves elsewhere', () => {
    const root = mount();
    openFold(root);
    view!.setState({ step: EDIT });
    root.querySelector<HTMLButtonElement>('[data-tab="changes"]')!.click();
    root.querySelector<HTMLButtonElement>('.acv-inspector-body [data-to-evidence]')!.click();
    // The Edit's own result record is seq 1 · row 8 · block 0; the runtime's patch is block 1 of it.
    const on = root.querySelector('.acv-ref-chip.on')!.textContent?.replace(/\s+/g, ' ');
    expect(on).toContain('change record');
    expect(on).toContain('seq 1 · row 8 · block 1');
    // Moving to the talk's opening card leaves the record behind.
    root.querySelector<HTMLButtonElement>('.acv-card.acv-human[data-talk]')!.click();
    root.querySelector<HTMLButtonElement>('[data-tab="evidence"]')!.click();
    expect(root.querySelector('.acv-inspector-body')!.textContent).not.toContain('change record');
  });

  it('lists a file outside any window once, in its own section', () => {
    const outside: AszWorkspaceChange = { ...bashRecord, changes: [{ ...bashRecord.changes![0]!, attribution: 'outside_any_window' }, bashRecord.changes![1]!] };
    const root = mount(withRecords(fixture, [outside]));
    root.querySelector<HTMLButtonElement>('.acv-changes-toggle')!.click();
    const panel = root.querySelector<HTMLElement>('.acv-changes')!;
    expect(panel.textContent).toContain('Changes outside observed tool windows');
    // The outside section prefixes the root, the root section does not; either way each file appears once.
    const paths = [...panel.querySelectorAll('.acv-file-path')].map((e) => e.textContent ?? '');
    expect(paths.filter((t) => t.endsWith('server.go'))).toHaveLength(1);
    expect(paths.filter((t) => t.endsWith('config.yaml'))).toHaveLength(1);
  });

  it('falls back to Details when the selection moves to a step without records', () => {
    const root = mount();
    view!.setState({ step: EDIT });
    root.querySelector<HTMLButtonElement>('[data-tab="changes"]')!.click();
    view!.setState({ step: 'call/s2-call' });
    expect(root.querySelector('[data-tab="details"]')!.getAttribute('aria-selected')).toBe('true');
  });
});
