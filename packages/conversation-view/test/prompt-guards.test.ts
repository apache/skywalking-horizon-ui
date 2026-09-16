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

/** What the reader must refuse, and what it must not lose. Every case here is one a real file could
 *  carry: a server is not trusted to send only what the Sessionizer wrote. */

import { describe, expect, it } from 'vitest';
import { PromptError, PromptStore, readProviderFile } from '../src/prompt/store.js';
import { deltaOf, readBody, type ReadRequest } from '../src/prompt/messages.js';

const HEADER = '{"h":1,"schema":"sd/1","seq":1,"at":"2026-01-01T00:00:00Z","kind":"provider_body","adapter":"mock/0.2.0","dialect":"mock/1","src":".","session":"s"}';
const END = '{"t":"end"}';

/** One record: the body's own parts, then the manifest as the last part. */
function record(id: string, manifest: Record<string, unknown>, parts: string[] = []): string {
  const all = [...parts.map((p) => `{"k":"data","data":${p}}`), `{"k":"data","data":${JSON.stringify(manifest)}}`];
  return `{"ord":1,"id":${JSON.stringify(id)},"parts":[${all.join(',')}]}`;
}

function file(seq: number, lines: string[]): { seq: number; file: string; bytes: Uint8Array } {
  return { seq, file: `s/provider_body/x-${seq}.sd`, bytes: new TextEncoder().encode([HEADER, ...lines, END].join('\n') + '\n') };
}

/** The sha256 of `{}`, which is what the well-formed records below rebuild to. */
const EMPTY_OBJECT = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';

describe('what the body reader refuses', () => {
  it('takes a manifest by its types, not by comparing whatever it holds', () => {
    // `bytes` as an object compares as under the budget and over zero, and would be handed to
    // `new Uint8Array` — the Sessionizer's own decoder refuses the record instead
    const lines = [
      record('a', { schema: 'provider_body/1', role: 'request', sha256: EMPTY_OBJECT, bytes: { length: 1073741824 }, depth: 0, segments: [{ lit: '{}' }] }),
      record('b', { schema: 'provider_body/1', role: 'request', sha256: EMPTY_OBJECT, bytes: 2, depth: '0', segments: [{ lit: '{}' }] }),
      record('c', { schema: 'provider_body/1', role: 'request', sha256: EMPTY_OBJECT, bytes: 2, depth: 0, segments: 'all of it' }),
      record('d', { schema: 'provider_body/1', role: 'request', sha256: EMPTY_OBJECT, bytes: 2, depth: 0, segments: [{ lit: '{}' }] }),
    ];
    const records = readProviderFile(1, file(1, lines).bytes);
    expect(records.map((r) => r.id)).toEqual(['d']);
  });

  it('rebuilds a record that landed twice before it stands for the earlier one', () => {
    // the duplicate claims the digest of the record already held, but holds something else; a digest a
    // record claims is not evidence of itself
    const good = { schema: 'provider_body/1', role: 'request', sha256: EMPTY_OBJECT, bytes: 2, depth: 0, segments: [{ lit: '{}' }] };
    const store = new PromptStore();
    store.addFile(file(1, [record('same', good), record('same', { ...good, segments: [{ lit: '[]' }] })]));
    expect(new TextDecoder().decode(store.bodyAt(1, 1))).toBe('{}');
    // row 2 is not the earlier record's position: the duplicate did not rebuild to what it claimed
    expect(() => store.bodyAt(1, 2)).toThrow(PromptError);
  });

  it('reads a file again when an earlier one it waited for arrives', () => {
    const first = { schema: 'provider_body/1', role: 'request', sha256: EMPTY_OBJECT, bytes: 2, depth: 0, segments: [{ lit: '{}' }] };
    const later = {
      schema: 'provider_body/1',
      role: 'request',
      sha256: EMPTY_OBJECT,
      bytes: 2,
      depth: 1,
      segments: [{ copy: { from: 'one', sha256: EMPTY_OBJECT, len: 2 } }],
    };
    const store = new PromptStore();
    // seq 2 arrives on its own: it refers to seq 1, so its record is not held and the file is not held
    store.addFile(file(2, [record('two', later)]));
    expect(store.has(2)).toBe(false);
    expect(() => store.bodyAt(2, 1)).toThrow(PromptError);
    // the file it waited for arrives, and reading it again brings the record back
    store.addFile(file(1, [record('one', first)]));
    store.addFile(file(2, [record('two', later)]));
    expect(store.has(2)).toBe(true);
    expect(new TextDecoder().decode(store.bodyAt(2, 1))).toBe('{}');
  });

  it('takes the last parts array, as every JSON reader does', () => {
    // A record naming `parts` twice parses to the last one, so the manifest beside it describes that
    // body; taking the parts of both would rebuild and verify a body the record does not hold.
    const good = { schema: 'provider_body/1', role: 'request', sha256: EMPTY_OBJECT, bytes: 2, depth: 0, segments: [{ part: 0 }] };
    const line =
      `{"ord":1,"id":"two","parts":[{"k":"data","data":{"a":1}},{"k":"data","data":${JSON.stringify(good)}}],` +
      `"parts":[{"k":"data","data":{}},{"k":"data","data":${JSON.stringify(good)}}]}`;
    const store = new PromptStore();
    store.addFile({ seq: 1, file: 'x.sd', bytes: new TextEncoder().encode([HEADER, line, END].join('\n') + '\n') });
    expect(new TextDecoder().decode(store.bodyAt(1, 1))).toBe('{}');
  });

  it('refuses a line whose bytes are not the text they claim to be', () => {
    // A decoder that mends an invalid byte hands the reader bytes the record never held, and the
    // digest is over the record's own bytes.
    const good = { schema: 'provider_body/1', role: 'request', sha256: EMPTY_OBJECT, bytes: 2, depth: 0, segments: [{ lit: '{}' }] };
    const head = new TextEncoder().encode(`${HEADER}\n`);
    const line = new TextEncoder().encode(record('a', good));
    line[line.indexOf(0x7b) + 1] = 0xff; // an invalid byte inside the line
    const tail = new TextEncoder().encode(`\n${END}\n`);
    const bytes = new Uint8Array([...head, ...line, ...tail]);
    const store = new PromptStore();
    store.addFile({ seq: 1, file: 'x.sd', bytes });
    expect(() => store.bodyAt(1, 1)).toThrow(PromptError);
  });

  it('refuses a manifest whose fields are not the types it reads them as', () => {
    const odd = {
      schema: 'provider_body/1', role: 'request', sha256: EMPTY_OBJECT, bytes: 2, depth: 0,
      model: { toString: 0 }, segments: [{ lit: '{}' }],
    };
    const store = new PromptStore();
    store.addFile({ seq: 1, file: 'x.sd', bytes: new TextEncoder().encode([HEADER, record('a', odd), END].join('\n') + '\n') });
    expect(store.manifestAt(1, 1)).toBeNull();
  });

  it('shows a body that is not JSON as the text it is', () => {
    const read = readBody(new TextEncoder().encode('upstream connect error'), 'response');
    expect(read.kind).toBe('other');
    expect(read.kind === 'other' && read.text).toBe('upstream connect error');
  });
});

describe('what the delta compares', () => {
  const request = (messages: unknown[]): ReadRequest =>
    readBody(new TextEncoder().encode(JSON.stringify({ model: 'm', messages })), 'request') as ReadRequest;

  it('leaves out the cache marker the runtime moves, and nothing else named like it', () => {
    const before = request([{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }]);
    const after = request([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    expect(deltaOf(before, after).sharedMessages).toBe(1);
    // the same name inside a tool's own input is the agent's data, and two calls that differ there differ
    const one = request([{ role: 'assistant', content: [{ type: 'tool_use', name: 'Run', input: { cache_control: 'a' } }] }]);
    const two = request([{ role: 'assistant', content: [{ type: 'tool_use', name: 'Run', input: { cache_control: 'b' } }] }]);
    expect(deltaOf(one, two).sharedMessages).toBe(0);
  });

  it('sees a difference under a top-level __proto__, not only a nested one', () => {
    const one = readBody(new TextEncoder().encode('{"model":"m","messages":[],"__proto__":{"x":1}}'), 'request') as ReadRequest;
    const two = readBody(new TextEncoder().encode('{"model":"m","messages":[],"__proto__":{"x":2}}'), 'request') as ReadRequest;
    expect(Object.keys(one.rest)).toContain('__proto__');
    expect(deltaOf(one, two).settingsChanged).toBe(true);
  });

  it('sees a difference under a key named __proto__', () => {
    const one = request([JSON.parse('{"role":"user","content":[{"type":"tool_use","name":"R","input":{"__proto__":{"x":1}}}]}') as unknown]);
    const two = request([JSON.parse('{"role":"user","content":[{"type":"tool_use","name":"R","input":{"__proto__":{"x":2}}}]}') as unknown]);
    expect(deltaOf(one, two).sharedMessages).toBe(0);
  });
});
