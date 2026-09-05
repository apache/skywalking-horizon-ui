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
import {
  isSupportedDocument,
  mountConversationView,
  type AszViewDocument,
  type ConversationView,
  type PublicState,
} from '../src/index.js';
import { ConversationModel } from '../src/model.js';

/** The Sessionizer's own example document: three talks across a main stream
 *  and a child agent, a tool, a synthetic error and a context reset. The OAP
 *  repository keeps the same file as its fixture and asserts equality with it.
 *  Paths are taken from the working directory, which pnpm sets to this package:
 *  under the jsdom environment `import.meta.url` is not a file URL. */
const fixture = JSON.parse(readFileSync(resolve('test/fixtures/asz-view-example.json'), 'utf8')) as AszViewDocument;

let view: ConversationView | null = null;
let host: HTMLElement | null = null;

function mount(state?: PublicState, onStateChange?: (s: PublicState) => void): { root: HTMLElement; view: ConversationView } {
  host = document.createElement('div');
  document.body.appendChild(host);
  view = mountConversationView(host, { document: fixture, state, onStateChange });
  return { root: host, view };
}

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

describe('isSupportedDocument', () => {
  it('accepts a 1.x asz.view document and refuses another major version or format', () => {
    expect(isSupportedDocument(fixture)).toBe(true);
    expect(isSupportedDocument({ ...fixture, version: '1.7' })).toBe(true);
    expect(isSupportedDocument({ ...fixture, version: '2.0' })).toBe(false);
    expect(isSupportedDocument({ ...fixture, format: 'other' })).toBe(false);
    expect(isSupportedDocument(null)).toBe(false);
  });
});

describe('the model', () => {
  const m = new ConversationModel(fixture);

  it('indexes every talk and every step of the document', () => {
    expect(m.talks.map((t) => t.id)).toEqual(fixture.talks.map((t) => t.id));
    const walk = (n: { children?: unknown[]; kind: string }): number =>
      (['talk', 'run', 'stream', 'segment', 'session', 'epoch'].includes(n.kind) ? 0 : 1) +
      ((n.children ?? []) as Array<{ children?: unknown[]; kind: string }>).reduce((a, c) => a + walk(c), 0);
    const steps = fixture.talks.reduce((a, t) => a + walk(t), 0) + (fixture.loose ?? []).reduce((a, t) => a + walk(t), 0);
    expect(m.stepById.size).toBe(steps);
    expect(m.stepById.size).toBe(fixture.summary.steps);
  });

  it('keeps reading order by landed position, and the flow by time', () => {
    const main = fixture.streams.find((s) => s.role === 'main')!.name;
    const steps = m.steps(main);
    for (let i = 1; i < steps.length; i++) {
      const a = steps[i - 1]!;
      const b = steps[i]!;
      if (a.ref && b.ref) expect(a.ref.seq * 1e6 + a.ref.row).toBeLessThanOrEqual(b.ref.seq * 1e6 + b.ref.row);
    }
    const flow = m.flow(main);
    for (let i = 1; i < flow.length; i++) expect(flow[i - 1]!.at || 0).toBeLessThanOrEqual(flow[i]!.at || 0);
  });

  it('finds the child stream a call started, with the join quality', () => {
    const main = fixture.streams.find((s) => s.role === 'main')!.name;
    const folders = m.foldersFor(main);
    expect(folders.length).toBeGreaterThan(0);
    expect(folders[0]!.stream.role).toBe('child');
    expect(folders[0]!.from.kind).toBe('agent.call');
    expect(folders[0]!.quality).toBeTruthy();
  });

  it('holds the loose steps under their stream, outside any talk', () => {
    const looseStreams = new Set((fixture.loose ?? []).map((n) => n.stream));
    for (const s of looseStreams) expect(m.loose(s!).length).toBeGreaterThan(0);
    for (const step of m.loose([...looseStreams][0]!)) expect(step.talk).toBeNull();
  });
});

describe('mounting the fixture', () => {
  it('draws the status, the main stream’s talks, the timeline clips, and reports its position', () => {
    const states: PublicState[] = [];
    const { root } = mount(undefined, (s) => states.push(s));
    expect(root.classList.contains('acv')).toBe(true);
    expect(root.querySelector('.acv-integrity')!.textContent).toContain('verified');
    expect(root.querySelector('.acv-status')!.textContent).toContain(fixture.summary.title === '' ? '' : `${fixture.talks.length}`);
    const main = fixture.streams.find((s) => s.role === 'main')!.name;
    const mainTalks = fixture.talks.filter((t) => t.stream === main);
    expect(root.querySelectorAll('.acv-card.acv-human[data-talk]')).toHaveLength(mainTalks.length);
    expect(root.querySelectorAll('.acv-tl-items .acv-clip[data-node]')).toHaveLength(
      new ConversationModel(fixture).flow(main).length,
    );
    expect(root.querySelector('.acv-tl-items .acv-clip.nested')).not.toBeNull();
    expect(states.length).toBeGreaterThan(0);
    const last = states[states.length - 1]!;
    expect(last.talk).toBe(mainTalks[0]!.id);
    expect(last.stream).toBe(main);
    expect(last.step).toBeTruthy();
  });

  it('opens a fold to the talk’s steps, selects a tool, and answers its relations', () => {
    const { root } = mount();
    const fold = root.querySelector<HTMLButtonElement>('.acv-fold[data-work]')!;
    fold.click();
    const cards = root.querySelectorAll('.acv-fold-body .acv-card[data-card]');
    expect(cards.length).toBeGreaterThan(0);
    const m = new ConversationModel(fixture);
    const tool = [...m.stepById.values()].find((s) => s.kind === 'tool')!;
    const card = root.querySelector<HTMLButtonElement>(`[data-card="${tool.id}"]`);
    if (card) {
      card.click();
      expect(root.querySelector('.acv-inspector-title')!.textContent).toContain(tool.name ?? 'tool');
      expect(root.querySelector('.acv-inspector-body')!.textContent).toContain(tool.name ?? 'tool');
    }
    const call = [...m.stepById.values()].find((s) => s.kind === 'agent.call')!;
    view!.setState({ step: call.id });
    expect(root.querySelector('.acv-clip.selected')?.getAttribute('data-node')).toBe(call.id);
    (root.querySelector('[data-tab="relations"]') as HTMLButtonElement).click();
    expect(root.querySelector('.acv-inspector-body')!.textContent).toContain('starts');
    expect(root.querySelector('[data-open-child]')).not.toBeNull();
  });

  it('enters a child stream and offers the way back to the step that opened it', () => {
    const { root } = mount();
    const nested = root.querySelector<HTMLButtonElement>('.acv-clip.nested[data-folder]')!;
    nested.click();
    expect(root.querySelector('.acv-inspector-title')!.textContent).toBeTruthy();
    (root.querySelector('[data-dive-in]') as HTMLButtonElement).click();
    const child = fixture.streams.find((s) => s.role === 'child')!.name;
    expect(view!.getState().stream).toBe(child);
    expect(root.querySelector('.acv-stream-banner')).not.toBeNull();
    const back = root.querySelector<HTMLButtonElement>('[data-opener-step]')!;
    back.click();
    expect(view!.getState().stream).toBe(fixture.streams.find((s) => s.role === 'main')!.name);
    expect(view!.getState().step).toBe(back.dataset.openerStep);
  });

  it('shows the evidence of a step as the document carries it, and the load button only with a host that can read records', () => {
    const { root } = mount();
    const m = new ConversationModel(fixture);
    const withRef = [...m.stepById.values()].find((s) => s.ref && s.text)!;
    view!.setState({ step: withRef.id });
    (root.querySelector('[data-tab="evidence"]') as HTMLButtonElement).click();
    const body = root.querySelector('.acv-inspector-body')!;
    expect(body.textContent).toContain(`seq ${withRef.ref!.seq}`);
    expect(body.querySelector('[data-load-record]')).toBeNull();
  });

  it('starts on a broken chain with its problems on screen', () => {
    const broken: AszViewDocument = {
      ...fixture,
      summary: { ...fixture.summary, state: 'incomplete', problems: ['round 2 is missing before round 3'] },
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    view = mountConversationView(host, { document: broken });
    expect(host.querySelector('.acv-integrity')!.textContent).toContain('incomplete');
    expect(host.querySelector('.acv-integrity')!.textContent).toContain('1 problems');
    (host.querySelector('.acv-integrity') as HTMLElement).click();
    expect(host.querySelector<HTMLElement>('.acv-problems')!.hidden).toBe(false);
    expect(host.querySelector('.acv-problems')!.textContent).toContain('round 2 is missing');
  });

  it('destroy leaves the host empty and unstyled', () => {
    const { root } = mount();
    view!.destroy();
    view = null;
    expect(root.innerHTML).toBe('');
    expect(root.classList.contains('acv')).toBe(false);
  });
});

describe('the stylesheet', () => {
  it('names no colour of its own — every colour is a design token', () => {
    const css = readFileSync(resolve('src/styles.css'), 'utf8');
    const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(body.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(body.match(/\brgba?\(/g) ?? []).toEqual([]);
    expect(body).toContain('var(--sw-bg-0)');
  });
});
