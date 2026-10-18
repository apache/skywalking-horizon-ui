/*
 * Licensed to Apache Software Foundation (ASF) under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Apache Software Foundation (ASF) licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.

/**
 * Where a call's history changed, as the page shows it: the card the Sessionizer draws before the
 * call, and the Prompt tab's "What changed", which says what the document found rather than reading a
 * history from where messages sit in two bodies.
 *
 * The fixtures are three Sessionizer scenarios, built and parsed by asz with `asz scenario build
 * tests/scenarios/<name>.yaml --format sd --at 2026-01-01T00:00:00Z`, `asz parse` and `asz
 * conversation -json`: `history-forget` (an application trims its history, so the last call's history
 * changed), `history-threads` (Claude Code continues a provider thread, so a request holds only its new
 * messages), and `provider-bodies` (a reset with a summary). Each `.sd` is the session's one provider
 * file.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mountConversationView, type AszViewDocument, type ConversationView, type StoredFile } from '../src/index.js';
import { PromptStore } from '../src/prompt/store.js';
import { changedMarks, keptMarks } from '../src/view/prompt.js';

function fixture(name: string): { doc: AszViewDocument; file: Uint8Array } {
  return {
    doc: JSON.parse(readFileSync(resolve(`test/fixtures/history/${name}.json`), 'utf8')) as AszViewDocument,
    file: new Uint8Array(readFileSync(resolve(`test/fixtures/history/${name}.sd`))),
  };
}

let view: ConversationView | null = null;
let host: HTMLElement | null = null;

function mount(name: string, step: string): HTMLElement {
  const { doc, file } = fixture(name);
  host = document.createElement('div');
  document.body.appendChild(host);
  view = mountConversationView(host, {
    document: doc,
    loadFiles: async (request: { session: string; seqs: number[] }, onFile: (f: StoredFile) => void) => {
      for (const seq of request.seqs) onFile({ seq, file: `${request.session}/provider_body/x.sd`, bytes: file });
    },
    state: { step },
  });
  return host;
}

function mountDoc(doc: AszViewDocument, file: Uint8Array, step: string): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  view = mountConversationView(host, {
    document: doc,
    loadFiles: async (request: { session: string; seqs: number[] }, onFile: (f: StoredFile) => void) => {
      for (const seq of request.seqs) onFile({ seq, file: `${request.session}/provider_body/x.sd`, bytes: file });
    },
    state: { step },
  });
  return host;
}

/** Every node of a document, so a test can change one. */
function nodesOf(doc: AszViewDocument): Array<Record<string, unknown> & { id: string; children?: unknown[] }> {
  const out: Array<Record<string, unknown> & { id: string; children?: unknown[] }> = [];
  const walk = (nodes: unknown[]): void => {
    for (const n of nodes as Array<Record<string, unknown> & { id: string; children?: unknown[] }>) {
      out.push(n);
      walk(n.children ?? []);
    }
  };
  walk(doc.talks);
  walk(doc.loose ?? []);
  return out;
}

function panel(root: HTMLElement): HTMLElement {
  return root.querySelector<HTMLElement>('.acv-inspector-body')!;
}

/** The Prompt tab of the selected call, loaded, in its "What changed" mode. */
async function changes(root: HTMLElement): Promise<HTMLElement> {
  root.querySelector<HTMLButtonElement>('[data-tab="prompt"]')!.click();
  panel(root).querySelector<HTMLButtonElement>('[data-load-prompt]')!.click();
  await new Promise((r) => setTimeout(r, 0));
  panel(root).querySelector<HTMLButtonElement>('[data-prompt-whole="0"]')!.click();
  return panel(root);
}

function marks(body: HTMLElement): string[] {
  return [...body.querySelectorAll('.acv-history-mark')].map((m) => m.textContent ?? '');
}

afterEach(() => {
  view?.destroy();
  view = null;
  host?.remove();
  host = null;
});

const TRIMMED = 'call/s9-call-2d0e5ed6b2ef';

describe('the history.change card', () => {
  it('stands just before its call, in its own colour, and says what changed', () => {
    const root = mount('forget', TRIMMED);
    // the timeline draws it too, in the same colour, just before the call
    const clips = [...root.querySelectorAll<HTMLElement>('.acv-clip[data-node]')].map((c) => c.dataset['node']);
    expect(clips[clips.indexOf(TRIMMED) - 1]).toBe('history/s9-call-2d0e5ed6b2ef');
    expect(root.querySelector('.acv-clip[data-node="history/s9-call-2d0e5ed6b2ef"]')!.classList.contains('acv-kind-history')).toBe(true);
    root.querySelector<HTMLButtonElement>('.acv-fold[data-work="talk/main/s8-cycle"]')!.click();
    const cards = [...root.querySelectorAll<HTMLElement>('.acv-card[data-card]')];
    const card = cards.find((c) => c.classList.contains('acv-history'));
    expect(card).toBeDefined();
    expect(card!.textContent).toContain('History changed · cause unavailable');
    expect(card!.querySelector('.acv-history-line')!.textContent).toBe(
      '3 kept, 0 changed, 2 dropped, 2 added · the previous reply is included unchanged',
    );
    expect(card!.querySelector('.acv-title')!.classList.contains('acv-kind-history')).toBe(true);
    // the card selects the call it stands before, and is drawn right before that call's card
    expect(card!.dataset['card']).toBe(TRIMMED);
    const at = cards.indexOf(card!);
    expect(cards[at + 1]!.dataset['card']).toBe(TRIMMED);
    expect(cards[at + 1]!.classList.contains('acv-history')).toBe(false);
    // a history that only grew draws no card
    expect(cards.filter((c) => c.classList.contains('acv-history'))).toHaveLength(1);
  });

  it('comes before its call however the document lists the two, which share a record', () => {
    const { doc, file } = fixture('forget');
    const swap = (nodes: AszViewDocument['talks']): void => {
      for (const n of nodes) {
        const kids = n.children ?? [];
        const at = kids.findIndex((k) => k.id === 'history/s9-call-2d0e5ed6b2ef');
        if (at >= 0) kids.splice(at, 2, kids[at + 1]!, kids[at]!);
        swap(kids);
      }
    };
    swap(doc.talks);
    host = document.createElement('div');
    document.body.appendChild(host);
    view = mountConversationView(host, {
      document: doc,
      loadFiles: async (request: { session: string; seqs: number[] }, onFile: (f: StoredFile) => void) => {
        for (const seq of request.seqs) onFile({ seq, file: `${request.session}/provider_body/x.sd`, bytes: file });
      },
      state: { step: TRIMMED },
    });
    const clips = [...host.querySelectorAll<HTMLElement>('.acv-clip[data-node]')].map((c) => c.dataset['node']);
    expect(clips[clips.indexOf(TRIMMED) - 1]).toBe('history/s9-call-2d0e5ed6b2ef');
    host.querySelector<HTMLButtonElement>('.acv-fold[data-work="talk/main/s8-cycle"]')!.click();
    const cards = [...host.querySelectorAll<HTMLElement>('.acv-card[data-card]')];
    const card = cards.findIndex((c) => c.classList.contains('acv-history'));
    expect(cards[card + 1]!.dataset['card']).toBe(TRIMMED);
  });

  it('selects its call from the timeline as from the transcript, and itself when the call is not there', () => {
    const root = mount('forget', 'call/s4-call-2d0e5ed6b2ef');
    root.querySelector<HTMLElement>('.acv-clip[data-node="history/s9-call-2d0e5ed6b2ef"]')!.click();
    expect(view!.getState().step).toBe(TRIMMED);
    view?.destroy();
    host?.remove();

    const { doc, file } = fixture('forget');
    for (const n of nodesOf(doc)) {
      if (n.children) n.children = n.children.filter((k) => (k as { id: string }).id !== TRIMMED);
    }
    const alone = mountDoc(doc, file, 'call/s4-call-2d0e5ed6b2ef');
    alone.querySelector<HTMLButtonElement>('.acv-fold[data-work="talk/main/s8-cycle"]')!.click();
    expect(alone.querySelector<HTMLElement>('.acv-card.acv-history')!.dataset['card']).toBe('history/s9-call-2d0e5ed6b2ef');
    alone.querySelector<HTMLElement>('.acv-clip[data-node="history/s9-call-2d0e5ed6b2ef"]')!.click();
    expect(view!.getState().step).toBe('history/s9-call-2d0e5ed6b2ef');
  });

  it('says no count it does not carry', () => {
    const { doc, file } = fixture('forget');
    const card = nodesOf(doc).find((n) => n.id === 'history/s9-call-2d0e5ed6b2ef')!;
    delete (card['attrs'] as Record<string, unknown>)['kept'];
    const root = mountDoc(doc, file, TRIMMED);
    root.querySelector<HTMLButtonElement>('.acv-fold[data-work="talk/main/s8-cycle"]')!.click();
    expect(root.querySelector('.acv-history-line')!.textContent).toBe('the previous reply is included unchanged');
  });

  it('draws no card where a thread holds only the new messages', () => {
    const root = mount('threads', 'call/s7-call-0b51c11a1403');
    for (const fold of root.querySelectorAll<HTMLButtonElement>('.acv-fold[data-work]')) fold.click();
    expect(root.querySelectorAll('.acv-card[data-card]').length).toBeGreaterThan(0);
    expect(root.querySelectorAll('.acv-card.acv-history, .acv-clip.acv-kind-history')).toHaveLength(0);
  });
});

describe('what changed, in the Prompt tab', () => {
  it('marks each message of a changed history, and lists what was dropped', async () => {
    const body = await changes(mount('forget', TRIMMED));
    expect(body.textContent).toContain('The history of the call before changed: 3 kept, 0 changed, 2 dropped, 2 added');
    expect(marks(body)).toEqual(['kept', 'kept', 'kept', 'added', 'added', 'dropped', 'dropped']);
    expect(body.textContent).toContain('Dropped from the call before (2)');
    expect(body.textContent).not.toContain('replaced by a summary');
  });

  it('shows what a kept history added after the history before it', async () => {
    const body = await changes(mount('forget', 'call/s4-call-2d0e5ed6b2ef'));
    expect(body.textContent).toContain('its 1 message(s) come first, as it sent them');
    expect(body.textContent).toContain('the previous reply is included unchanged');
    expect(body.textContent).toContain('Added by this call (2)');
    expect(marks(body)).toEqual(['added', 'added']);
  });

  it('reads a request that continues a thread as holding only its new messages', async () => {
    // Before, this request's one message against the five of the call before read as a context
    // replaced by a summary: "5 message(s) became 1".
    const body = await changes(mount('threads', 'call/s7-call-0b51c11a1403'));
    expect(body.textContent).toContain('its 5 message(s) come first');
    expect(body.textContent).toContain('continues a provider thread');
    expect(body.textContent).toContain('the previous reply is included unchanged');
    expect(marks(body)).toEqual(['added']);
    expect(body.textContent).not.toContain('replaced by a summary');
    expect(body.textContent).not.toContain('rewritten');
  });

  it('says a reset only where the conversation has one, and a summary only where the reset has one', async () => {
    const reset = await changes(mount('reset', 'call/s9-call-fdae022ac306'));
    expect(reset.textContent).toContain('The context was reset here and replaced by a summary');
    view?.destroy();
    host?.remove();
    const first = await changes(mount('reset', 'call/s2-call-fdae022ac306'));
    expect(first.textContent).toContain('This is the first call of its stream since the context began');
    expect(first.textContent).not.toContain('reset');
  });

  it('finds the reset past a call the framework made for its own purpose', async () => {
    const { doc, file } = fixture('reset');
    // a summariser's calls after the reset, one with its class and one whose request carried no history,
    // so it says nothing: neither is a predecessor, so neither hides the reset
    (doc.loose ??= []).push(
      {
        id: 'call/internal', kind: 'llm.call', stream: 'main', ref: { seq: 1, row: 13 },
        attrs: { history: 'not_compared', history_reason: 'internal_call' },
      } as unknown as AszViewDocument['talks'][number],
      { id: 'call/older', kind: 'llm.call', stream: 'main', ref: { seq: 1, row: 13 } } as unknown as AszViewDocument['talks'][number],
    );
    const body = await changes(mountDoc(doc, file, 'call/s9-call-fdae022ac306'));
    expect(body.textContent).toContain('The context was reset here and replaced by a summary');
  });

  it('names a reason it does not know rather than taking it for the framework\'s', async () => {
    const { doc, file } = fixture('forget');
    const call = nodesOf(doc).find((n) => n.id === 'call/s4-call-2d0e5ed6b2ef')!;
    Object.assign(call['attrs'] as Record<string, unknown>, { history: 'not_compared', history_reason: 'a_later_reason' });
    const body = await changes(mountDoc(doc, file, 'call/s4-call-2d0e5ed6b2ef'));
    expect(body.textContent).toContain('a_later_reason');
    expect(body.textContent).not.toContain('framework');
  });

  it('marks a kept history by the call\'s own lengths, without the body of the call before', async () => {
    const { doc } = fixture('forget');
    const strip = (nodes: AszViewDocument['talks']): void => {
      for (const n of nodes) {
        if (n.id === 'call/s2-call-2d0e5ed6b2ef') delete (n as { provider_bodies?: unknown }).provider_bodies;
        strip(n.children ?? []);
      }
    };
    strip(doc.talks);
    const { file } = fixture('forget');
    host = document.createElement('div');
    document.body.appendChild(host);
    view = mountConversationView(host, {
      document: doc,
      loadFiles: async (request: { session: string; seqs: number[] }, onFile: (f: StoredFile) => void) => {
        for (const seq of request.seqs) onFile({ seq, file: `${request.session}/provider_body/x.sd`, bytes: file });
      },
      state: { step: 'call/s4-call-2d0e5ed6b2ef' },
    });
    const body = await changes(host);
    expect(marks(body)).toEqual(['added', 'added']);
    expect(body.textContent).not.toContain('Also changed');
  });
});

describe('the marks', () => {
  const e = (id: string | undefined, digest: string) => (id ? { id, digest } : { digest });

  it('marks a kept history by place: the earlier history first, then what was added', () => {
    expect(keptMarks(5, 3, 5, 5, false)).toEqual(['kept', 'kept', 'kept', 'added', 'added']);
    // a continue request holds its last messages only
    expect(keptMarks(7, 5, 1, 1, true)).toEqual(['added']);
    // without either length, or with lengths that do not fit, nothing is marked
    expect(keptMarks(undefined, 3, 2, 2, false)).toBeNull();
    expect(keptMarks(3, 4, 3, 3, false)).toBeNull();
    expect(keptMarks(2, 1, 3, 3, true)).toBeNull();
    // a body that holds fewer messages than its whole list, or than its manifest lists, has no places
    expect(keptMarks(5, 3, 2, 2, false)).toBeNull();
    expect(keptMarks(5, 3, 5, 4, false)).toBeNull();
    expect(keptMarks(7, 5, 2, null, true)).toBeNull();
  });

  it('marks a changed history by the counts the card gives', () => {
    const P = [e('0000000000000001', '0000000000000010'), e(undefined, '00000000000000c0'), e('0000000000000002', '0000000000000020')];
    const N = [e(undefined, '00000000000000c0'), e('0000000000000002', '0000000000000021'), e(undefined, '00000000000000d0')];
    expect(changedMarks(P, N)).toEqual({ marks: ['kept', 'changed', 'added'], dropped: [0] });
  });

  it('marks no message where which earlier message became which is not known', () => {
    const a = e('000000000000000a', '0000000000000001');
    const b = e('000000000000000a', '0000000000000002');
    const c = e('000000000000000a', '0000000000000003');
    // either earlier message under the id could have become the new one
    expect(changedMarks([a, b], [c])).toBeNull();
    expect(changedMarks([a], [b, c])).toBeNull();
    // two messages of one digest and no id: which one was dropped is not known
    const cont = e(undefined, '00000000000000c0');
    expect(changedMarks([cont, e(undefined, '0000000000000005'), cont], [e(undefined, '0000000000000005'), cont])).toBeNull();
  });

  it('takes a linear walk over a long history', () => {
    const P = Array.from({ length: 65536 }, (_, i) => e(i.toString(16).padStart(16, '0'), '0000000000000001'));
    const N = [...P.slice(1), e('ffffffffffffffff', '0000000000000002')];
    const started = performance.now();
    const found = changedMarks(P, N)!;
    expect(found.dropped).toEqual([0]);
    expect(found.marks.filter((m) => m === 'added')).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('a request\'s message list, as the store reads it', () => {
  const HEADER = '{"h":1,"schema":"sd/1","seq":1,"at":"2026-01-01T00:00:00Z","kind":"provider_body","adapter":"mock/0.2.0","dialect":"mock/1","src":".","session":"s"}';
  const EMPTY_OBJECT = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';
  const d = (n: number) => ({ digest: n.toString(16).padStart(16, '0') });
  const line = (id: string, role: string, fields: Record<string, unknown>) =>
    `{"ord":1,"id":"${id}","parts":[{"k":"data","data":${JSON.stringify({
      schema: 'provider_body/1', role, sha256: EMPTY_OBJECT, bytes: 2, depth: 0, segments: [{ lit: '{}' }], history_form: 'langchain/1', ...fields,
    })}}]}`;
  const storeOf = (lines: string[]) => {
    const s = new PromptStore();
    s.addFile({ seq: 1, file: 'x.sd', bytes: new TextEncoder().encode([HEADER, ...lines, '{"t":"end"}'].join('\n') + '\n') });
    return s;
  };

  it('builds a list against its base, and reads the scenario\'s lists as asz wrote them', () => {
    const s = storeOf([
      line('a', 'request', { messages: { entries: [d(1), d(2)] } }),
      line('b', 'request', { messages: { base: 'a', keep: 2, add: [d(3)] } }),
    ]);
    expect(s.listOf('b')).toEqual([d(1), d(2), d(3)]);
    const { file } = fixture('forget');
    const forget = new PromptStore();
    forget.addFile({ seq: 2, file: 'x.sd', bytes: file });
    // the trimmed call's request: five messages, the history-messages its call says
    expect(forget.listOf(forget.idAt(2, 7)!)).toHaveLength(5);
  });

  it('reads no list over a base that does not hold', () => {
    const s = storeOf([
      line('a', 'request', { messages: { entries: [d(1)] } }),
      line('r', 'response', { messages: { entries: [d(1), d(2)] } }),
      line('b', 'request', { messages: { base: 'r', keep: 2, add: [d(3)] } }),
      line('c', 'request', { messages: { base: 'a', keep: 2, add: [d(3)] } }),
      line('e', 'request', { messages: { base: 'c', keep: 1, add: [d(4)] } }),
      line('f', 'request', { messages: { base: 'g', keep: 1, add: [d(4)] } }),
      line('g', 'request', { messages: { entries: [d(1)] } }),
    ]);
    expect(s.listOf('b')).toBeNull(); // a response is no base
    expect(s.listOf('c')).toBeNull(); // it keeps more than its base holds
    expect(s.listOf('e')).toBeNull(); // nor is a list over such a list read, however little it keeps
    expect(s.listOf('f')).toBeNull(); // a base landed after it
  });

  it('reads a list only in exactly one shape, as the Sessionizer reads it', () => {
    const s = storeOf([
      line('a', 'request', { messages: { entries: [d(1), d(2)] } }),
      line('b', 'request', { messages: { entries: [d(1)], base: 'a', keep: 1, add: [] } }),
      line('c', 'request', { messages: { entries: [d(1)], unavailable: 'too_large', count: 1 } }),
      line('e', 'request', { messages: { base: 'a', keep: 1, add: [d(3)], unavailable: 'too_large' } }),
      line('f', 'request', { messages: { base: 'a', keep: 1.5, add: [d(3)] } }),
      line('g', 'request', { messages: { entries: [d(1)], base: null, keep: 9 } }),
      line('h', 'request', { messages: { entries: [{ id: null, digest: 'ABCDEF0123456789' }, { id: '', digest: d(2).digest }] } }),
      line('i', 'request', { messages: { entries: [{ id: 'not-a-digest', digest: d(1).digest }] } }),
    ]);
    for (const id of ['b', 'c', 'e', 'f', 'i']) expect(s.listOf(id), id).toBeNull();
    // a null is no key, and a list's own keep and add beside its entries are not read
    expect(s.listOf('g')).toEqual([d(1)]);
    // an id that is null or empty is none, and a digest in capitals is the same digest in small letters
    expect(s.listOf('h')).toEqual([{ digest: 'abcdef0123456789' }, d(2)]);
  });

  it('reads no list a field of another type is beside, whatever its shape', () => {
    const s = storeOf([
      line('a', 'request', { messages: { entries: [d(1)], keep: 1.5 } }),
      line('b', 'request', { messages: { entries: [d(1)], add: 'not a list' } }),
      line('c', 'request', { messages: { entries: [d(1)], count: '1' } }),
      line('e', 'request', { messages: { entries: [d(1)], add: [5] } }),
      line('f', 'request', { messages: { entries: [{ digest: 5 }] } }),
      line('g', 'request', { messages: { entries: [d(1)], add: [{ digest: 'not checked beside entries' }], count: 3 } }),
      line('j', 'request', { messages: { entries: [d(1)], count: 2 ** 63 } }),
    ]);
    for (const id of ['a', 'b', 'c', 'e', 'f', 'j']) expect(s.listOf(id), id).toBeNull();
    expect(s.listOf('g')).toEqual([d(1)]);
  });

  it('matches two spellings of one digest as one message', () => {
    const upper = (x: { digest: string }) => ({ digest: x.digest.toUpperCase() });
    const s = storeOf([
      line('a', 'request', { messages: { entries: [d(0xab), d(0xcd)] } }),
      line('b', 'request', { messages: { entries: [upper(d(0xab)), upper(d(0xcd)), d(0xef)] } }),
    ]);
    const found = changedMarks(s.listOf('a')!, s.listOf('b')!)!;
    expect(found).toEqual({ marks: ['kept', 'kept', 'added'], dropped: [] });
    // an id spelled both ways is one id, so twice in a list it leaves the pairing unknown
    const id = (n: number, digest: number) => ({ id: n.toString(16).padStart(16, '0'), digest: d(digest).digest });
    const t = storeOf([
      line('a', 'request', { messages: { entries: [id(0xab, 1), { ...id(0xab, 2), id: id(0xab, 2).id.toUpperCase() }] } }),
      line('b', 'request', { messages: { entries: [id(0xab, 3)] } }),
    ]);
    expect(changedMarks(t.listOf('a')!, t.listOf('b')!)).toBeNull();
  });
});
