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

function mount(
  state?: PublicState,
  onStateChange?: (s: PublicState) => void,
  doc: AszViewDocument = fixture,
): { root: HTMLElement; view: ConversationView } {
  host = document.createElement('div');
  document.body.appendChild(host);
  view = mountConversationView(host, { document: doc, state, onStateChange });
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

  it('mounted on a step from the URL, lands on that step and reports the position once', () => {
    const m = new ConversationModel(fixture);
    const inject = [...m.stepById.values()].find((s) => s.kind !== 'message.external' && s.talk)!;
    const states: PublicState[] = [];
    const { root } = mount({ step: inject.id }, (s) => states.push(s));
    expect(view!.getState().step).toBe(inject.id);
    expect(view!.getState().talk).toBe(inject.talk);
    expect(root.querySelector('.acv-clip.selected')?.getAttribute('data-node')).toBe(inject.id);
    expect(states).toEqual([view!.getState()]);
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

  it('captions a child stream with its own talk, and the way back restores the parent talk', () => {
    const { root } = mount();
    const before = view!.getState().talk;
    root.querySelector<HTMLButtonElement>('.acv-clip.nested[data-folder]')!.click();
    (root.querySelector('[data-dive-in]') as HTMLButtonElement).click();
    const child = fixture.streams.find((s) => s.role === 'child')!.name;
    const childTalk = fixture.talks.find((t) => t.stream === child)!;
    expect(view!.getState().stream).toBe(child);
    expect(view!.getState().talk).toBe(childTalk.id);
    expect(root.querySelector('.acv-talk-caption')!.textContent).toContain('child stream');
    root.querySelector<HTMLButtonElement>('[data-opener-step]')!.click();
    expect(view!.getState().talk).toBe(before);
  });

  it('names the step behind a talk’s opening and reply cards, so selecting either scrolls to it', () => {
    const { root } = mount();
    const m = new ConversationModel(fixture);
    const talk = m.firstTalk()!;
    const opening = m.stepsOfTalk(talk.id).find((s) => s.kind === 'message.external')!;
    expect(root.querySelector(`.acv-human[data-talk="${talk.id}"]`)!.getAttribute('data-step')).toBe(opening.id);
    expect(root.querySelector(`[data-step="${opening.id}"]`)).not.toBeNull();
  });

  it('keeps a step with no recorded time on the axis, at the time of the step read before it', () => {
    const m = new ConversationModel(fixture);
    const main = fixture.streams.find((s) => s.role === 'main')!.name;
    const steps = m.steps(main);
    const victim = steps[2]!;
    const strip = (n: { id?: string; at?: number; children?: unknown[] }): void => {
      if (n.id === victim.id) n.at = 0;
      for (const c of (n.children ?? []) as Array<{ id?: string; at?: number; children?: unknown[] }>) strip(c);
    };
    const doc = JSON.parse(JSON.stringify(fixture)) as AszViewDocument;
    for (const t of doc.talks) strip(t);
    host = document.createElement('div');
    document.body.appendChild(host);
    view = mountConversationView(host, { document: doc });
    const clip = host.querySelector<HTMLElement>(`.acv-tl-items .acv-clip[data-node="${victim.id}"]`);
    expect(clip).not.toBeNull();
    const left = parseFloat(clip!.style.left);
    const width = parseFloat(host.querySelector<HTMLElement>('.acv-tl-canvas')!.style.width);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThan(width);
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

  it('says that nothing folded, with the problems open, when the document is empty', () => {
    const empty: AszViewDocument = {
      ...fixture,
      talks: [],
      loose: [],
      streams: [],
      relations: [],
      summary: { ...fixture.summary, state: 'incomplete', talks: 0, steps: 0, streams: 0, problems: ['round 1 is missing; the chain stops at round 0'] },
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    view = mountConversationView(host, { document: empty });
    expect(host.querySelector<HTMLElement>('.acv-problems')!.hidden).toBe(false);
    expect(host.querySelector('.acv-problems')!.textContent).toContain('round 1 is missing');
    expect(host.querySelector('.acv-transcript-list')!.textContent).toContain('Nothing of this conversation could be folded');
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

describe('tool inputs and results', () => {
  const clipped = JSON.parse(readFileSync(resolve('test/fixtures/clipped-bash-input.json'), 'utf8')) as { text: string; bytes: number };
  const ID = 'tool/tool-run-make-build';
  const CARD = `[data-card="${ID}"]`;

  /** The example with the make-build call's input replaced. */
  function withInput(text: string, bytes: number): AszViewDocument {
    const doc = JSON.parse(JSON.stringify(fixture)) as AszViewDocument;
    const walk = (o: unknown): void => {
      if (Array.isArray(o)) o.forEach(walk);
      else if (o && typeof o === 'object') {
        const n = o as Record<string, unknown>;
        if (n.id === ID) Object.assign(n, { text, bytes });
        Object.values(n).forEach(walk);
      }
    };
    walk(doc);
    return doc;
  }

  function openWork(root: HTMLElement): void {
    root.querySelector<HTMLButtonElement>('.acv-fold[data-work="talk/main/s1-cycle"]')!.click();
  }

  it("draws a tool call's input as the fields it holds", () => {
    const { root } = mount();
    openWork(root);
    const card = root.querySelector(CARD)!;
    expect([...card.querySelectorAll('.acv-field-key')].map((k) => k.textContent)).toEqual(['command', 'description']);
    expect([...card.querySelectorAll('.acv-field-value')].map((k) => k.textContent)).toEqual(['make build', 'build the project']);
    expect(card.querySelector('.acv-text.result')!.textContent).toBe('build succeeded');
    expect(card.querySelector('[data-text-toggle]')).toBeNull();
  });

  it('clamps a long command, opens it in place, and says where the document clipped it', () => {
    const { root } = mount(undefined, undefined, withInput(clipped.text, clipped.bytes));
    openWork(root);
    let card = root.querySelector<HTMLElement>(CARD)!;
    expect(card.querySelector('.acv-text.clamped')).not.toBeNull();
    expect(card.querySelector('.acv-field.block .acv-field-text')!.textContent).toContain("cat > probe.ts <<'EOF'\n");
    card.querySelector<HTMLButtonElement>('[data-text-toggle]')!.click();
    card = root.querySelector<HTMLElement>(CARD)!;
    expect(card.querySelector('.acv-text.open')).not.toBeNull();
    expect(card.querySelector('[data-text-toggle]')).toBeNull();
    expect(card.querySelector('.acv-clip-note')!.textContent).toMatch(/^clipped: 2,?000 of 2,?021 bytes$/);
    card.click();
    const details = root.querySelector('.acv-inspector-body')!;
    expect(details.querySelector('.acv-block .acv-field-text')!.textContent).toContain('EOF');
    expect(details.querySelector('.acv-clip-note')).not.toBeNull();
  });
});

describe('the inspector popped out', () => {
  it('lays over the page behind a scrim on the button and docks again on Escape', () => {
    const { root } = mount();
    const btn = root.querySelector<HTMLButtonElement>('.acv-pop-btn')!;
    const scrim = root.querySelector<HTMLElement>('.acv-scrim')!;
    expect(scrim.hidden).toBe(true);
    btn.click();
    expect(root.querySelector('.acv-workbench')!.classList.contains('acv-popped')).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(scrim.hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('.acv-workbench')!.classList.contains('acv-popped')).toBe(false);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(scrim.hidden).toBe(true);
  });

  it('is a modal dialog while popped: the rest is inert and Tab wraps inside it', () => {
    const { root } = mount();
    const inspector = root.querySelector<HTMLElement>('.acv-inspector')!;
    root.querySelector<HTMLButtonElement>('.acv-pop-btn')!.click();
    expect(inspector.getAttribute('role')).toBe('dialog');
    expect(inspector.getAttribute('aria-modal')).toBe('true');
    expect(root.querySelector<HTMLElement>('.acv-transcript')!.hasAttribute('inert')).toBe(true);
    expect(root.querySelector<HTMLElement>('.acv-dock')!.hasAttribute('inert')).toBe(true);
    const tabs = Array.from(inspector.querySelectorAll<HTMLElement>('button:not([hidden])'));
    tabs[tabs.length - 1]!.focus();
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    root.querySelector<HTMLButtonElement>('.acv-pop-btn')!.click();
    expect(inspector.hasAttribute('role')).toBe(false);
    expect(root.querySelector<HTMLElement>('.acv-transcript')!.hasAttribute('inert')).toBe(false);
  });

  it('docks on a click on the scrim, before Escape reaches anything under it', () => {
    const { root } = mount();
    root.querySelector<HTMLButtonElement>('.acv-overview-toggle')!.click();
    root.querySelector<HTMLButtonElement>('.acv-pop-btn')!.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('.acv-workbench')!.classList.contains('acv-popped')).toBe(false);
    expect(root.querySelector<HTMLElement>('.acv-overview')!.hidden).toBe(false);
    root.querySelector<HTMLButtonElement>('.acv-pop-btn')!.click();
    root.querySelector<HTMLElement>('.acv-scrim')!.click();
    expect(root.querySelector('.acv-workbench')!.classList.contains('acv-popped')).toBe(false);
  });

  it('keeps a copy button from selecting the card it sits in', () => {
    const { root } = mount();
    root.querySelector<HTMLButtonElement>('.acv-fold[data-work="talk/main/s1-cycle"]')!.click();
    const card = root.querySelector<HTMLElement>('[data-card="tool/tool-run-make-build"]')!;
    card.querySelector<HTMLButtonElement>('[data-copy]')!.click();
    expect(root.querySelector('[data-card="tool/tool-run-make-build"]')!.classList.contains('selected')).toBe(false);
  });
});

describe('copying a whole result', () => {
  const ID = 'tool/tool-run-make-build';

  it('offers a copy on the result label of the card and of the Details tab, for a result that is one text', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t: string) => (written.push(t), Promise.resolve()) }, configurable: true });
    const { root, view } = mount();
    root.querySelector<HTMLButtonElement>('.acv-fold[data-work="talk/main/s1-cycle"]')!.click();
    const label = root.querySelector<HTMLElement>(`[data-card="${ID}"] .acv-result-block .acv-result-label`)!;
    expect(label.textContent).toContain('result');
    const onCard = label.querySelector<HTMLButtonElement>('[data-copy]')!;
    expect(onCard.title).toBe('copy result');
    onCard.click();
    await Promise.resolve();
    expect(written).toEqual(['build succeeded']);
    view.setState({ step: ID });
    const kicker = root.querySelector<HTMLElement>('.acv-inspector-body .acv-kicker[style]')!;
    expect(kicker.textContent).toContain('result');
    kicker.querySelector<HTMLButtonElement>('[data-copy]')!.click();
    await Promise.resolve();
    expect(written).toEqual(['build succeeded', 'build succeeded']);
  });

  it('leaves a result drawn as fields to their own copy buttons', () => {
    const doc = structuredClone(fixture) as AszViewDocument;
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object') return;
      const o = n as Record<string, unknown>;
      if (o.id === ID && typeof o.result === 'string') o.result = '{"stdout":"ok","stderr":""}';
      for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
    };
    walk(doc);
    const { root } = mount(undefined, undefined, doc);
    root.querySelector<HTMLButtonElement>('.acv-fold[data-work="talk/main/s1-cycle"]')!.click();
    const block = root.querySelector<HTMLElement>(`[data-card="${ID}"] .acv-result-block`)!;
    expect(block.querySelector('.acv-result-label [data-copy]')).toBeNull();
    expect(block.querySelectorAll('.acv-field [data-copy]').length).toBe(2);
  });
});

describe('the Details tab names where a step sits', () => {
  it('reads by activity window, agent, talk, run and step, keeping the ids in the tooltip', () => {
    const { root, view } = mount();
    view.setState({ step: 'tool/tool-run-make-build' });
    const path = root.querySelector<HTMLElement>('.acv-inspector-body .acv-path')!;
    expect(path.textContent).toMatch(/^Segment \d+\/\d+ › Main agent › Talk \d+\/\d+ · .+ › Run \d+\/\d+ › .*Bash$/);
    expect(path.textContent).not.toContain('tool/tool-run-make-build');
    expect(path.getAttribute('title')).toContain('tool/tool-run-make-build');
    expect(path.getAttribute('title')).toContain('talk/main/s1-cycle');
  });
});
