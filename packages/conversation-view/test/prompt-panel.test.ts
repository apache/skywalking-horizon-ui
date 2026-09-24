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
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mountConversationView, type AszViewDocument, type ConversationView, type StoredFile } from '../src/index.js';

/** The Sessionizer's provider-bodies scenario: the document, and the one file its bodies landed in. */
const doc = JSON.parse(readFileSync(resolve('test/fixtures/provider-bodies.json'), 'utf8')) as AszViewDocument;
const file = new Uint8Array(readFileSync(resolve('test/fixtures/provider-bodies.sd')));
/** The second call of the main stream: it has a request, a response, and a call before it. */
const CALL = 'call/s3-call-fdae022ac306';

let view: ConversationView | null = null;
let host: HTMLElement | null = null;
let asked: Array<{ session: string; seqs: number[] }> = [];

function mount(loader = true, step: string = CALL): HTMLElement {
  asked = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  view = mountConversationView(host, {
    document: doc,
    ...(loader
      ? {
          loadFiles: async (request: { session: string; seqs: number[] }, onFile: (f: StoredFile) => void) => {
            asked.push({ session: request.session, seqs: request.seqs });
            for (const seq of request.seqs) onFile({ seq, file: `${request.session}/provider_body/x.sd`, bytes: file });
          },
        }
      : {}),
    state: { step },
  });
  return host;
}

function tab(root: HTMLElement, name: string): HTMLButtonElement | null {
  return root.querySelector<HTMLButtonElement>(`[data-tab="${name}"]`);
}

function panel(root: HTMLElement): HTMLElement {
  return root.querySelector<HTMLElement>('.acv-inspector-body')!;
}

afterEach(() => {
  view?.destroy();
  view = null;
  host?.remove();
  host = null;
});

describe('the prompt panel', () => {
  it('is offered only for a call whose bodies landed, and only to a host that can read files', () => {
    const withLoader = mount();
    expect(tab(withLoader, 'prompt')?.hidden).toBe(false);
    view?.destroy();
    host?.remove();
    const without = mount(false);
    expect(tab(without, 'prompt')?.hidden).toBe(true);
  });

  it('loads nothing until the reader asks, then shows the request as it was sent', async () => {
    const root = mount();
    tab(root, 'prompt')!.click();
    const body = panel(root);
    expect(body.textContent).toContain('request this call sent');
    expect(asked).toEqual([]);
    const load = body.querySelector<HTMLButtonElement>('[data-load-prompt]')!;
    load.click();
    await new Promise((r) => setTimeout(r, 0));
    // one read, of this session's provider files up to the call's own
    expect(asked).toEqual([{ session: doc.conversation, seqs: [4] }]);
    const after = panel(root);
    expect(after.textContent).toContain('System prompt');
    expect(after.textContent).toContain('Tools (');
    expect(after.textContent).toContain('Messages (');
    // the messages section is open, and its text is the runtime's own
    expect(after.textContent).toContain('read the configuration');
  });

  it('shows what the call added, against the request before it', async () => {
    const root = mount();
    tab(root, 'prompt')!.click();
    panel(root).querySelector<HTMLButtonElement>('[data-load-prompt]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    panel(root).querySelector<HTMLButtonElement>('[data-prompt-whole="0"]')!.click();
    const body = panel(root);
    expect(body.textContent).toContain('Added by this call');
    // the shared history is named, not repeated
    expect(body.textContent).toMatch(/message\(s\) before are as the call before sent them/);
  });

  it('says a first request names none before it, rather than that one is not loaded', async () => {
    // The main stream's first call: its request names no request before it, so nothing is missing.
    const root = mount(undefined, 'call/s2-call-fdae022ac306');
    tab(root, 'prompt')!.click();
    panel(root).querySelector<HTMLButtonElement>('[data-load-prompt]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    panel(root).querySelector<HTMLButtonElement>('[data-prompt-whole="0"]')!.click();
    const body = panel(root);
    expect(body.textContent).toContain('names no request before it');
    expect(body.textContent).not.toContain('not among the loaded bodies');
  });

  it('says the request before is not loaded when it names one the tab cannot find', async () => {
    // The second call names the first call's request, but here the document lists no bodies for the
    // first call, so the one it names is nowhere the tab can read it.
    const withoutFirst = JSON.parse(JSON.stringify(doc)) as AszViewDocument;
    const strip = (nodes: AszViewDocument['talks']): void => {
      for (const n of nodes) {
        if (n.id === 'call/s2-call-fdae022ac306') delete (n as { provider_bodies?: unknown }).provider_bodies;
        strip(n.children ?? []);
      }
    };
    strip(withoutFirst.talks);
    host = document.createElement('div');
    document.body.appendChild(host);
    view = mountConversationView(host, {
      document: withoutFirst,
      loadFiles: async (request: { session: string; seqs: number[] }, onFile: (f: StoredFile) => void) => {
        for (const seq of request.seqs) onFile({ seq, file: `${request.session}/provider_body/x.sd`, bytes: file });
      },
      state: { step: CALL },
    });
    tab(host, 'prompt')!.click();
    panel(host).querySelector<HTMLButtonElement>('[data-load-prompt]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    panel(host).querySelector<HTMLButtonElement>('[data-prompt-whole="0"]')!.click();
    const body = panel(host);
    expect(body.textContent).toContain('not among the loaded bodies');
    expect(body.textContent).not.toContain('names no request before it');
  });

  it('calls a growing history growth, however the runtime spells a message', () => {
    // This call is the first whose history holds a message that has stopped being the newest. Such a
    // message is sent as a list of one text block while it is newest and as a plain string after,
    // and reading the two spellings as different messages ended the shared prefix one message early
    // and reported an ordinary growth step as a rewritten history.
    const root = mount(undefined, 'call/s6-call-fdae022ac306');
    tab(root, 'prompt')!.click();
    panel(root).querySelector<HTMLButtonElement>('[data-load-prompt]')!.click();
    return new Promise<void>((done) => setTimeout(() => {
      panel(root).querySelector<HTMLButtonElement>('[data-prompt-whole="0"]')!.click();
      const body = panel(root);
      expect(body.textContent).toContain('Added by this call');
      expect(body.textContent).not.toContain('was rewritten');
      expect(body.textContent).not.toContain('replaced by a summary');
      done();
    }, 0));
  });

  it('shows the response on its own, with what stopped it', async () => {
    const root = mount();
    tab(root, 'prompt')!.click();
    panel(root).querySelector<HTMLButtonElement>('[data-load-prompt]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    panel(root).querySelector<HTMLButtonElement>('[data-prompt-side="response"]')!.click();
    const body = panel(root);
    expect(body.textContent).toContain('stopped:');
    expect(body.textContent).toContain('out ');
  });

  it('draws each message in a box that says its place, and opens a long one on request', async () => {
    const root = mount();
    tab(root, 'prompt')!.click();
    panel(root).querySelector<HTMLButtonElement>('[data-load-prompt]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    const boxes = panel(root).querySelectorAll('.acv-prompt-message');
    // the three messages of this request, however many blocks each holds
    expect(boxes).toHaveLength(3);
    expect(boxes[0]!.querySelector('.acv-prompt-message-head')!.textContent).toContain('user');
    expect(boxes[0]!.querySelector('.acv-prompt-message-head')!.textContent).toContain('1 of 3');
    expect(boxes[2]!.querySelector('.acv-prompt-message-head')!.textContent).toContain('3 of 3');
    // the injected reminder is long, so it is cut short with a way to read the rest
    const more = boxes[0]!.querySelector<HTMLButtonElement>('[data-text-toggle]')!;
    const clipped = boxes[0]!.querySelector('.acv-block')!.textContent!;
    expect(clipped).toContain('…');
    more.click();
    const opened = panel(root).querySelector('.acv-prompt-message .acv-block')!.textContent!;
    expect(opened.length).toBeGreaterThan(clipped.length);
    expect(opened).not.toContain('…');
    expect(panel(root).querySelector('.acv-prompt-message [data-text-toggle]')).toBeNull();
  });

  it('copies the whole text, not the preview and not the button', async () => {
    const root = mount();
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t: string) => (written.push(t), Promise.resolve()) },
    });
    tab(root, 'prompt')!.click();
    panel(root).querySelector<HTMLButtonElement>('[data-load-prompt]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    const copy = panel(root).querySelector<HTMLButtonElement>('.acv-block .acv-copy')!;
    const whole = copy.parentElement!.querySelector('.acv-copy-src')!.textContent!;
    copy.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(written).toEqual([whole]);
    expect(written[0]).not.toBe('copy');
  });

  it('draws what it could rebuild when the server left a file out', async () => {
    asked = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    view = mountConversationView(host, {
      document: doc,
      // the server answers with nothing: a file past its retention, say
      loadFiles: async (request: { session: string; seqs: number[] }) => {
        asked.push({ session: request.session, seqs: request.seqs });
      },
      state: { step: CALL },
    });
    tab(host, 'prompt')!.click();
    panel(host).querySelector<HTMLButtonElement>('[data-load-prompt]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    const body = panel(host);
    // the offer is gone — asking again brings the same answer — and the panel says which file is not there
    expect(body.querySelector('[data-load-prompt]')).toBeNull();
    expect(body.textContent).toContain('4');
    expect(body.querySelector('.acv-warning')).not.toBeNull();
  });

  it('offers the files a later call needs, even after a read that went well', async () => {
    // A read covers the files up to the call it was made for. A call further on needs the ones after
    // them, which were never asked for, so it must offer them - not report them as not stored.
    const later = JSON.parse(JSON.stringify(doc)) as AszViewDocument;
    const first = later.files!.find((f) => f.kind === 'provider_body')!;
    later.files!.push({ ...first, file: first.file.replace('000004', '000005'), seq: 5, bytes: 100 });
    const walk = (nodes: AszViewDocument['talks']): boolean => {
      for (const n of nodes) {
        const bodies = (n as { provider_bodies?: Array<{ role: string; ref: { seq: number; row: number } }> }).provider_bodies;
        if (bodies?.length && n.id !== CALL) {
          for (const b of bodies) b.ref = { seq: 5, row: b.ref.row };
          return true;
        }
        if (walk(n.children ?? [])) return true;
      }
      return false;
    };
    expect(walk(later.talks)).toBe(true);
    const moved = later.talks.flatMap(function ids(n: AszViewDocument['talks'][number]): string[] {
      const bodies = (n as { provider_bodies?: unknown[] }).provider_bodies;
      return [...(bodies?.length && n.id !== CALL ? [n.id] : []), ...(n.children ?? []).flatMap(ids)];
    })[0]!;

    asked = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    view = mountConversationView(host, {
      document: later,
      loadFiles: async (request: { session: string; seqs: number[] }, onFile: (f: StoredFile) => void) => {
        asked.push({ session: request.session, seqs: request.seqs });
        // only the first file is stored; the second is answered when it is asked for
        for (const seq of request.seqs) onFile({ seq, file: `${request.session}/provider_body/x.sd`, bytes: file });
      },
      state: { step: CALL },
    });
    tab(host, 'prompt')!.click();
    panel(host).querySelector<HTMLButtonElement>('[data-load-prompt]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual([{ session: later.conversation, seqs: [4] }]);

    view.setState({ step: moved });
    const offer = panel(host).querySelector<HTMLButtonElement>('[data-load-prompt]');
    expect(offer, 'the call needs seq 5, which no read has asked for').not.toBeNull();
    offer!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(asked[1]).toEqual({ session: later.conversation, seqs: [5] });
  });

  it('does not offer a file again when it arrived but could not be resolved', async () => {
    // The server answers, but the record refers to a body of a file that is not there, so the store
    // keeps nothing. Offering the read again would bring the same bytes and the same answer, for ever.
    const HEADER =
      '{"h":1,"schema":"sd/1","seq":5,"at":"2026-01-01T00:00:00Z","kind":"provider_body",' +
      '"adapter":"mock/0.2.0","dialect":"mock/1","src":".","session":"s"}';
    const EMPTY_OBJECT = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';
    const manifest = {
      schema: 'provider_body/1', role: 'request', sha256: EMPTY_OBJECT, bytes: 2, depth: 1,
      segments: [{ copy: { from: 'a-body-that-never-landed', sha256: EMPTY_OBJECT, len: 2 } }],
    };
    const orphan = new TextEncoder().encode(
      [HEADER, `{"ord":1,"id":"late","parts":[{"k":"data","data":${JSON.stringify(manifest)}}]}`, '{"t":"end"}'].join('\n') + '\n',
    );

    const later = JSON.parse(JSON.stringify(doc)) as AszViewDocument;
    const provider = later.files!.find((f) => f.kind === 'provider_body')!;
    provider.seq = 5;
    provider.file = provider.file.replace('000004', '000005');
    const walk = (nodes: AszViewDocument['talks']): void => {
      for (const n of nodes) {
        for (const b of (n as { provider_bodies?: Array<{ ref: { seq: number; row: number } }> }).provider_bodies ?? []) {
          b.ref = { seq: 5, row: 1 };
        }
        walk(n.children ?? []);
      }
    };
    walk(later.talks);
    walk(later.loose ?? []);

    asked = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    view = mountConversationView(host, {
      document: later,
      loadFiles: async (request: { session: string; seqs: number[] }, onFile: (f: StoredFile) => void) => {
        asked.push({ session: request.session, seqs: request.seqs });
        for (const seq of request.seqs) onFile({ seq, file: `${request.session}/provider_body/x.sd`, bytes: orphan });
      },
      state: { step: CALL },
    });
    tab(host, 'prompt')!.click();
    panel(host).querySelector<HTMLButtonElement>('[data-load-prompt]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toHaveLength(1);
    // the offer is gone - asking again brings the same answer - and the panel says what is not there
    expect(panel(host).querySelector('[data-load-prompt]')).toBeNull();
    expect(panel(host).querySelector('.acv-warning')).not.toBeNull();
  });

  it('keeps what it read: a second call of the same session asks for nothing more', async () => {
    const root = mount();
    tab(root, 'prompt')!.click();
    panel(root).querySelector<HTMLButtonElement>('[data-load-prompt]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    view!.setState({ step: 'call/s5-call-fdae022ac306' });
    const body = panel(root);
    expect(body.querySelector('[data-load-prompt]')).toBeNull();
    expect(body.textContent).toContain('Messages (');
    expect(asked).toHaveLength(1);
  });
});
