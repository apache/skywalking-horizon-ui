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

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mountConversationView, type AszViewDocument, type ConversationView, type StoredFile } from '../src/index.js';
import { readBody, type ReadBody, type ReadRequest, type ReadResponse } from '../src/prompt/messages.js';
import { PromptStore, readProviderFile } from '../src/prompt/store.js';

/**
 * A LangGraph agent with LangChain's SummarizationMiddleware, run on Amazon Bedrock and landed by the
 * Sessionizer: thirteen model calls, three of them the middleware's own, in fourteen files. Each body
 * is LangChain's serialized message list, the shape the reader drew as one empty message.
 */
const DIR = resolve('test/fixtures/langchain');
const doc = JSON.parse(readFileSync(resolve(DIR, 'conversation.json'), 'utf8')) as AszViewDocument;
const files = new Map<number, Uint8Array>(
  readdirSync(DIR)
    .filter((n) => n.endsWith('.sd'))
    .map((n) => [Number(/(\d+)\.sd$/.exec(n)![1]), new Uint8Array(readFileSync(resolve(DIR, n)))]),
);

function bodies(): Array<{ seq: number; row: number; role: string; read: ReadBody }> {
  const store = new PromptStore();
  for (const [seq, bytes] of files) store.addFile({ seq, file: `provider_body-${seq}.sd`, bytes });
  const out: Array<{ seq: number; row: number; role: string; read: ReadBody }> = [];
  for (const [seq, bytes] of [...files].sort((a, b) => a[0] - b[0])) {
    for (const r of readProviderFile(seq, bytes)) {
      out.push({ seq, row: r.row, role: r.manifest.role, read: readBody(store.bodyAt(seq, r.row), r.manifest.role) });
    }
  }
  return out;
}

const requests = (): ReadRequest[] => bodies().flatMap((b) => (b.read.kind === 'request' ? [b.read] : []));
const responses = (): ReadResponse[] => bodies().flatMap((b) => (b.read.kind === 'response' ? [b.read] : []));

function read(body: unknown, role = 'request'): ReadBody {
  return readBody(new TextEncoder().encode(JSON.stringify(body)), role);
}

describe('a LangChain body', () => {
  it('reads as a conversation, every message with its role and its content', () => {
    const all = bodies();
    expect(all).toHaveLength(26);
    for (const b of all) expect(b.read.kind).toBe(b.role);
    for (const r of requests()) {
      expect(r.messages.length).toBeGreaterThan(0);
      for (const m of r.messages) {
        expect(['system', 'human', 'ai', 'tool']).toContain(m.role);
        expect(m.blocks.length).toBeGreaterThan(0);
      }
    }
  });

  it('draws each tool call once, and pairs each result with the call it answers', () => {
    // Bedrock repeats every tool call in the message content, so a reader that also drew tool_calls
    // showed each one twice.
    let calls = 0;
    for (const r of requests()) {
      const used = r.messages.flatMap((m) => m.blocks).filter((b) => b.kind === 'tool_use');
      const answered = r.messages.flatMap((m) => m.blocks).filter((b) => b.kind === 'tool_result');
      const ids = used.map((b) => b.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const result of answered) expect(ids).toContain(result.id);
      calls += used.length;
    }
    expect(calls).toBeGreaterThan(0);
  });

  it('keeps the summary the middleware wrote, as the message it sent', () => {
    const summaries = requests().flatMap((r) =>
      r.messages.filter((m) => m.role === 'human' && (m.blocks[0]?.text ?? '').startsWith('Here is a summary of the conversation to date:')),
    );
    expect(summaries.length).toBeGreaterThan(0);
  });

  it('reads the answer, the model and the tokens a response reports', () => {
    const all = responses();
    expect(all).toHaveLength(13);
    for (const r of all) {
      expect(r.blocks.length).toBeGreaterThan(0);
      expect(r.model).toBe('deepseek.v3.2');
      expect(r.usage?.['input_tokens']).toBeGreaterThan(0);
    }
  });

  it('draws a call the content repeats once, with the arguments LangChain parsed', () => {
    const ai = (content: unknown[]) =>
      (
        read({
          messages: [
            [
              {
                lc: 1,
                type: 'constructor',
                id: ['langchain', 'schema', 'messages', 'AIMessage'],
                kwargs: { type: 'ai', content, tool_calls: [{ name: 'search', args: { q: 'weather' }, id: 'c1', type: 'tool_call' }] },
              },
            ],
          ],
        }) as ReadRequest
      ).messages[0]!.blocks;
    // a streamed provider block still reads {}, and the arguments are in pieces beside it
    const streamed = ai([
      { type: 'text', text: 'Looking.' },
      { type: 'tool_use', id: 'c1', name: 'search', input: {}, partial_json: '{"q": "weather"}' },
      { type: 'text', text: 'Then I answer.' },
    ]);
    // and it stays where the content has it
    expect(streamed).toEqual([
      { kind: 'text', text: 'Looking.', reminder: false },
      { kind: 'tool_use', name: 'search', id: 'c1', json: { q: 'weather' } },
      { kind: 'text', text: 'Then I answer.', reminder: false },
    ]);
    // LangChain's own content block for the same call
    const standard = ai([{ type: 'tool_call', id: 'c1', name: 'search', args: { q: 'weather' } }]);
    expect(standard).toEqual([{ kind: 'tool_use', name: 'search', id: 'c1', json: { q: 'weather' } }]);
  });

  it('says a tool failed only when LangChain marked it', () => {
    const tool = (status: string) =>
      read({
        messages: [[{ lc: 1, type: 'constructor', id: ['langchain', 'schema', 'messages', 'ToolMessage'], kwargs: { type: 'tool', content: 'boom', tool_call_id: 'c1', status } }]],
      }) as ReadRequest;
    expect(tool('error').messages[0]!.blocks[0]).toMatchObject({ kind: 'tool_result', id: 'c1', text: 'boom', failed: true });
    expect(tool('success').messages[0]!.blocks[0]!.failed).toBeUndefined();
  });

  it('reads a plain message the caller passed, and shows one it cannot read as its JSON', () => {
    const r = read({ messages: [[{ role: 'user', content: 'first' }, { lc: 1, type: 'not_implemented', id: ['x'], repr: 'X()' }]] }) as ReadRequest;
    expect(r.messages[0]).toMatchObject({ role: 'user', blocks: [{ kind: 'text', text: 'first' }] });
    expect(r.messages[1]!.blocks).toEqual([{ kind: 'unknown', json: { lc: 1, type: 'not_implemented', id: ['x'], repr: 'X()' } }]);
  });
});

describe('a body of neither shape', () => {
  it('is shown as the JSON it is, never as empty messages', () => {
    // several prompts in one call, or a list that is not messages at all
    expect(read({ messages: [[{ role: 'user', content: 'a' }], [{ role: 'user', content: 'b' }]] }).kind).toBe('other');
    expect(read({ messages: [['a', 'b']] }).kind).toBe('other');
    expect(read({ messages: ['a'] }).kind).toBe('other');
    expect(read({ generations: [[{ text: 'a' }, { text: 'b' }]] }, 'response').kind).toBe('other');
  });
});

let view: ConversationView | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
  host?.remove();
  host = null;
});

/** The first call whose request carries the middleware's summary and a tool round trip. */
function callWithSummary(): string {
  const store = new PromptStore();
  for (const [seq, bytes] of files) store.addFile({ seq, file: `provider_body-${seq}.sd`, bytes });
  let found = '';
  const walk = (nodes: AszViewDocument['talks']): void => {
    for (const n of nodes) {
      const request = (n as { provider_bodies?: Array<{ role: string; ref: { seq: number; row: number } }> }).provider_bodies?.find((b) => b.role === 'request');
      if (!found && request) {
        const r = readBody(store.bodyAt(request.ref.seq, request.ref.row), 'request');
        const roles = r.kind === 'request' ? r.messages.map((m) => m.role) : [];
        if (roles.includes('tool') && r.kind === 'request' && r.messages.some((m) => (m.blocks[0]?.text ?? '').startsWith('Here is a summary'))) found = n.id;
      }
      walk(n.children ?? []);
    }
  };
  walk(doc.talks);
  return found;
}

describe('the prompt panel on a LangChain call', () => {
  it('draws the request message by message, in LangChain words', async () => {
    const step = callWithSummary();
    expect(step).not.toBe('');
    host = document.createElement('div');
    document.body.appendChild(host);
    view = mountConversationView(host, {
      document: doc,
      loadFiles: async (request: { session: string; seqs: number[] }, onFile: (f: StoredFile) => void) => {
        for (const seq of request.seqs) onFile({ seq, file: `${request.session}/provider_body/x.sd`, bytes: files.get(seq)! });
      },
      state: { step },
    });
    host.querySelector<HTMLButtonElement>('[data-tab="prompt"]')!.click();
    host.querySelector<HTMLButtonElement>('[data-load-prompt]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    const panel = host.querySelector<HTMLElement>('.acv-inspector-body')!;
    const roles = [...panel.querySelectorAll('.acv-prompt-role')].map((e) => e.textContent);
    expect(roles).toContain('system');
    expect(roles).toContain('human');
    expect(roles).toContain('ai');
    expect(roles).toContain('tool');
    // a message with no role is labelled this, which is what every LangChain message was
    expect(roles).not.toContain('message');
    expect(panel.textContent).toContain('Here is a summary of the conversation to date:');
    expect(panel.textContent).toContain('service_health');
    // nothing but messages in the body, so no empty settings section
    expect(panel.textContent).not.toContain('Settings');
    // a LangChain request names no request before it, and nothing is missing
    host.querySelector<HTMLButtonElement>('[data-prompt-whole="0"]')!.click();
    const changes = host.querySelector<HTMLElement>('.acv-inspector-body')!.textContent;
    expect(changes).toContain('names no request before it');
    expect(changes).not.toContain('not among the loaded bodies');
  });
});
