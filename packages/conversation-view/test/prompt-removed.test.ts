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
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PromptError, PromptStore, readProviderFile, STATE_REMOVED, STATE_TOO_LARGE } from '../src/prompt/store.js';
import { mountConversationView, type AszViewDocument, type ConversationView, type StoredFile } from '../src/index.js';

/**
 * The Sessionizer's provider-bodies-long scenario, with its files removed by retention at the first
 * checkpoint and the rest landed after: the document, and the answer of the Sessionizer's files
 * endpoint for every provider file. A removed file comes as its skeleton, with the bytes the
 * Sessionizer's store kept: the chain tip at the removal, and the removed pieces a later body cites.
 * Written by the Sessionizer's TestThePageServesWhatABodyAfterARemovalNeeds.
 */
const doc = JSON.parse(readFileSync(resolve('test/fixtures/provider-bodies-removed.json'), 'utf8')) as AszViewDocument;
const answer = JSON.parse(readFileSync(resolve('test/fixtures/provider-bodies-removed.files.json'), 'utf8')) as Array<{
  seq: number;
  file: string;
  bytes: string;
  kept?: { bodies?: Record<string, string>; pieces?: Record<string, string> };
}>;

function bytesOf(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function files(withKept = true): StoredFile[] {
  return answer.map((f) => {
    const file: StoredFile = { seq: f.seq, file: f.file, bytes: bytesOf(f.bytes) };
    if (withKept && f.kept) {
      file.kept = {};
      for (const k of ['bodies', 'pieces'] as const) {
        const m = f.kept[k];
        if (m) file.kept[k] = Object.fromEntries(Object.entries(m).map(([key, b]) => [key, bytesOf(b)]));
      }
    }
    return file;
  });
}

function store(withKept = true): PromptStore {
  const s = new PromptStore();
  for (const f of files(withKept)) s.addFile(f);
  return s;
}

function digest(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}

function reason(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof PromptError) return err.reason ?? 'no reason';
    throw err;
  }
  return undefined;
}

describe('a session whose provider files were removed', () => {
  it('rebuilds every body that landed after the removal, from the skeletons and the kept bytes', () => {
    const s = store();
    const landed = answer.filter((f) => f.file.endsWith('.sd'));
    expect(landed.length).toBeGreaterThan(0);
    let copies = 0;
    for (const f of landed) {
      for (const r of readProviderFile(f.seq, bytesOf(f.bytes))) {
        const body = s.bodyAt(f.seq, r.row);
        expect(digest(body)).toBe(r.manifest.sha256);
        if (r.manifest.segments.some((seg) => seg.copy)) copies++;
      }
    }
    // a body after the removal copies the removed tip, so the kept body is what it is built from
    expect(copies).toBeGreaterThan(0);
  });

  it('holds a skeleton in its body place, reads a kept tip, and says a body it has not was removed', () => {
    const s = store();
    let kept = 0;
    let removed = 0;
    for (const f of answer.filter((a) => a.file.endsWith('.sk'))) {
      // every record a skeleton holds reads, a response whose segments were all literal included:
      // its header and its closing line are the only lines that are not records
      const lines = new TextDecoder().decode(bytesOf(f.bytes)).trimEnd().split('\n');
      expect(readProviderFile(f.seq, bytesOf(f.bytes))).toHaveLength(lines.length - 2);
      for (const r of readProviderFile(f.seq, bytesOf(f.bytes))) {
        expect(r.removed).toBe(true);
        if (f.kept?.bodies?.[r.id]) {
          expect(digest(s.bodyAt(f.seq, r.row))).toBe(r.manifest.sha256);
          kept++;
        } else {
          expect(reason(() => s.bodyAt(f.seq, r.row))).toBe(STATE_REMOVED);
          removed++;
        }
      }
    }
    expect(kept).toBeGreaterThan(0);
    expect(removed).toBeGreaterThan(0);
  });

  it('says a body after the removal was removed when its host kept nothing', () => {
    const s = store(false);
    const after = answer.find((f) => f.file.endsWith('.sd'))!;
    const reasons = readProviderFile(after.seq, bytesOf(after.bytes)).map((r) => reason(() => s.bodyAt(after.seq, r.row)));
    expect(reasons).toContain(STATE_REMOVED);
  });

  it('refuses kept bytes that are not what the record says', () => {
    const tampered = files().map((f) => {
      if (!f.kept?.bodies) return f;
      const bodies = Object.fromEntries(Object.keys(f.kept.bodies).map((id) => [id, new TextEncoder().encode('{}')]));
      return { ...f, kept: { ...f.kept, bodies } };
    });
    const s = new PromptStore();
    for (const f of tampered) s.addFile(f);
    const sk = answer.find((f) => f.kept?.bodies)!;
    const id = Object.keys(sk.kept!.bodies!)[0]!;
    const row = readProviderFile(sk.seq, bytesOf(sk.bytes)).find((r) => r.id === id)!.row;
    expect(() => s.bodyAt(sk.seq, row)).toThrow(/do not match its digest/);
  });
});

/** A file of records written out as Session Data lines: a header, the records, the closing line. */
function sessionData(records: unknown[]): Uint8Array {
  const lines = [{ h: 1, kind: 'provider_body' }, ...records, { t: 'end', records: records.length }];
  return new TextEncoder().encode(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function manifest(sha256: string, bytes: number, segments: unknown[]): Record<string, unknown> {
  return { k: 'data', data: { schema: 'provider_body/1', role: 'request', sha256, bytes, depth: 0, segments } };
}

describe('a piece too large to land', () => {
  const piece = '"a piece too large to land"';
  const sha = digest(new TextEncoder().encode(piece));
  const later = `{"messages":[${piece}]}`;
  const file = sessionData([
    { ord: 1, id: 'first', parts: [{ k: 'data', state: 'too_large', bytes: piece.length, sha256: sha }, manifest(sha, piece.length, [{ part: 0 }])] },
    {
      ord: 1,
      id: 'second',
      parts: [manifest(digest(new TextEncoder().encode(later)), later.length, [{ lit: '{"messages":[' }, { piece: sha }, { lit: ']}' }])],
    },
  ]);

  it('is a piece a later body refers to, by the sha256 its part keeps, and neither body rebuilds', () => {
    const s = new PromptStore();
    s.addFile({ seq: 1, file: 'provider_body.sd', bytes: file });
    // the second body's reference resolves, so its file is held, not waiting on another
    expect(s.has(1)).toBe(true);
    expect(reason(() => s.bodyAt(1, 1))).toBe(STATE_TOO_LARGE);
    expect(reason(() => s.bodyAt(1, 2))).toBe(STATE_TOO_LARGE);
  });
});

describe('pieces held twice, read out of order', () => {
  // X is held first by a removed record that refers to an earlier file, and again by a later record
  // as too large to land; a body after both cites X. The Sessionizer cut that body against the first
  // holder, whose bytes the host kept, so it rebuilds, whatever order the files arrive in.
  const enc = (t: string): Uint8Array => new TextEncoder().encode(t);
  const y = '"y"';
  const x = '"the piece both hold"';
  const X = digest(enc(x));
  const removedManifest = { schema: 'provider_body/1', role: 'request', sha256: 'f'.repeat(64), bytes: 1, depth: 0, segments: [{ part: 0 }, { piece: digest(enc(y)) }] };
  const files: StoredFile[] = [
    { seq: 1, file: 'one.sd', bytes: sessionData([{ ord: 1, id: 'base', parts: [{ k: 'data', data: JSON.parse(y) }, manifest(digest(enc(y)), y.length, [{ part: 0 }])] }]) },
    {
      seq: 2,
      file: 'two.sk',
      bytes: sessionData([{ ord: 1, id: '__proto__', parts: [{ k: 'data', state: 'removed', bytes: x.length, sha256: X }, { k: 'data', state: 'removed', data: removedManifest }] }]),
      // kept bytes that are not this body's, under an id a plain object would take for its prototype
      kept: { pieces: { [X]: enc(x) }, bodies: Object.fromEntries([['__proto__', enc('{}')]]) },
    },
    { seq: 3, file: 'three.sd', bytes: sessionData([{ ord: 1, id: 'again', parts: [{ k: 'data', state: 'too_large', bytes: x.length, sha256: X }, manifest('e'.repeat(64), x.length, [{ part: 0 }])] }]) },
    { seq: 4, file: 'four.sd', bytes: sessionData([{ ord: 1, id: 'after', parts: [manifest(X, x.length, [{ piece: X }])] }]) },
  ];

  it('takes a piece from the record that landed first', () => {
    const s = new PromptStore();
    for (const seq of [2, 3, 4, 1, 2]) s.addFile(files[seq - 1]!);
    expect(new TextDecoder().decode(s.bodyAt(4, 1))).toBe(x);
  });

  it('takes the same piece when the files arrive in order', () => {
    const s = new PromptStore();
    for (const f of files) s.addFile(f);
    expect(new TextDecoder().decode(s.bodyAt(4, 1))).toBe(x);
    // a record id is any string, and a kept body is checked like any other
    expect(s.removedAt(2, 1)).toBe(true);
    expect(() => s.bodyAt(2, 1)).toThrow(/do not match its digest/);
  });
});

describe('the prompt panel over a removal', () => {
  let view: ConversationView | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    view?.destroy();
    view = null;
    host?.remove();
    host = null;
  });

  async function open(step: string, withKept = true): Promise<HTMLElement> {
    host = document.createElement('div');
    document.body.appendChild(host);
    const all = files(withKept);
    view = mountConversationView(host, {
      document: doc,
      loadFiles: async (request: { seqs: number[] }, onFile: (f: StoredFile) => void) => {
        for (const f of all) if (request.seqs.includes(f.seq)) onFile(f);
      },
      state: { step },
    });
    host.querySelector<HTMLButtonElement>('[data-tab="prompt"]')!.click();
    host.querySelector<HTMLButtonElement>('[data-load-prompt]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    return host.querySelector<HTMLElement>('.acv-inspector-body')!;
  }

  it('says a removed body was removed, not that it failed', async () => {
    const body = await open('call/s2-call-185e4d8ed624');
    expect(body.textContent).toContain('Retention removed this body from the stored files');
    expect(body.textContent).not.toContain('did not come back whole');
  });

  it('says a body still stored was built from a removed one, when nothing was kept', async () => {
    const body = await open('call/s5-call-185e4d8ed624', false);
    expect(body.textContent).toContain('Retention removed a body or piece this body is built from');
    expect(body.textContent).not.toContain('Retention removed this body');
  });

  it('shows a body that landed after the removal, built from the kept tip', async () => {
    const body = await open('call/s5-call-185e4d8ed624');
    expect(body.textContent).not.toContain('Retention removed');
    expect(body.textContent).not.toContain('did not come back whole');
    expect(body.textContent).toContain('Whole request');
  });
});

describe('a manifest with no segment list', () => {
  it('reads a list left out or written as null as an empty one, as the Sessionizer does', () => {
    const empty = digest(new Uint8Array());
    for (const segments of [', "segments": null', '']) {
      const line = `{"ord":1,"id":"empty","parts":[{"k":"data","data":{"schema":"provider_body/1","role":"response","sha256":"${empty}","bytes":0,"depth":0${segments}}}]}`;
      const file = new TextEncoder().encode(`{"h":1,"kind":"provider_body"}\n${line}\n{"t":"end","records":1}\n`);
      const s = new PromptStore();
      s.addFile({ seq: 1, file: 'provider_body.sd', bytes: file });
      expect(readProviderFile(1, file)).toHaveLength(1);
      expect(s.bodyAt(1, 1)).toHaveLength(0);
    }
  });
});
