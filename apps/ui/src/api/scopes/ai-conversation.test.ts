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

import { afterEach, describe, expect, it, vi } from 'vitest';
// The scope imports `withBase` from the client, and the client constructs every
// scope at load: the client has to be the module that starts the cycle.
import '../client';
import { AiConversationApi, AiConversationViewError } from './ai-conversation';
import type { BffClient } from '../client';

function api(): { api: AiConversationApi; unauthorized: ReturnType<typeof vi.fn> } {
  const unauthorized = vi.fn();
  const bff = { handleUnauthorized: unauthorized, request: vi.fn() } as unknown as BffClient;
  return { api: new AiConversationApi(bff), unauthorized };
}

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(enc.encode(p));
      controller.close();
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('bff.aiConversation.view', () => {
  it('asks for the JSON document with the session cookie and reports the bytes as they stream', async () => {
    const doc = { format: 'asz.view', version: '1.0', conversation: 'c1', talks: [] };
    const text = JSON.stringify(doc);
    const summary = { talks: 3, steps: 21, streams: 2, segments: 1, rounds: 1, unresolved: 0 };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(streamOf([text.slice(0, 10), text.slice(10)]), {
        status: 200,
        headers: {
          'content-type': 'application/vnd.skywalking.asz.view+json; version=1.0',
          'x-horizon-document-bytes': String(text.length),
          'x-horizon-document-summary': JSON.stringify(summary),
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const seen: Array<[string, number]> = [];
    const { api: a } = api();
    const r = await a.view('c1', { service: 'Claude Code', instance: 'me@host' }, { onProgress: (p) => seen.push([p.phase, p.bytes]) });
    expect(r.document).toEqual(doc);
    expect(r.bytes).toBe(text.length);
    expect(r.total).toBe(text.length);
    expect(r.summary).toEqual(summary);
    expect(seen).toEqual([['receiving', 0], ['receiving', 10], ['receiving', text.length], ['parsing', text.length]]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/ai-conversation/c1/view?service=Claude+Code&instance=me%40host');
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>).accept).toBe('application/vnd.skywalking.asz.view+json');
  });

  it('reads a document from a BFF that states no size, with nothing to show against', async () => {
    const text = JSON.stringify({ format: 'asz.view', version: '1.0' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(streamOf([text]), { status: 200 })));
    const seen: Array<number | null> = [];
    const r = await api().api.view('c1', { service: 's' }, { onProgress: (p) => seen.push(p.total) });
    expect(r.total).toBeNull();
    expect(r.summary).toBeNull();
    expect(seen.every((t) => t === null)).toBe(true);
  });

  it("turns OAP's problem document into a typed failure carrying its detail", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ title: 'Not Found', status: 404, detail: 'no round of conversation c9 for service Claude Code' }), {
          status: 404,
          headers: { 'content-type': 'application/problem+json' },
        }),
      ),
    );
    const { api: a } = api();
    const err = await a.view('c9', { service: 'Claude Code' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiConversationViewError);
    expect((err as AiConversationViewError).kind).toBe('not_found');
    expect((err as AiConversationViewError).detail).toContain('no round of conversation c9');
  });

  it('tells a 404 from an OAP without the route apart from a conversation OAP does not hold', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } })));
    const err = (await api().api.view('c1', { service: 's' }).catch((e: unknown) => e)) as AiConversationViewError;
    expect(err.kind).toBe('not_served');
    expect(err.status).toBe(404);
  });

  it("names the BFF's own refusals: a timeout, an unreachable OAP, a missing permission", async () => {
    const cases: Array<[number, Record<string, unknown>, string]> = [
      [504, { error: 'oap_timeout', message: 'no first byte within 120000 ms' }, 'timeout'],
      [502, { error: 'oap_unreachable', message: 'ECONNREFUSED' }, 'unreachable'],
      [403, { error: 'permission_denied', verb: 'ai-conversation:read' }, 'forbidden'],
    ];
    for (const [status, body, kind] of cases) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));
      const { api: a } = api();
      const err = (await a.view('c1', { service: 's' }).catch((e: unknown) => e)) as AiConversationViewError;
      expect(err.kind).toBe(kind);
      expect(err.status).toBe(status);
    }
  });

  it('ends the session on 401 like every other call', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
    const { api: a, unauthorized } = api();
    const err = (await a.view('c1', { service: 's' }).catch((e: unknown) => e)) as AiConversationViewError;
    expect(err.kind).toBe('unauthenticated');
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it('refuses a document of another format or major version, and a body that is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ format: 'asz.view', version: '2.0' }), { status: 200 })));
    let err = (await api().api.view('c1', { service: 's' }).catch((e: unknown) => e)) as AiConversationViewError;
    expect(err.kind).toBe('unsupported');
    expect(err.message).toContain('asz.view 2.0');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })));
    err = (await api().api.view('c1', { service: 's' }).catch((e: unknown) => e)) as AiConversationViewError;
    expect(err.kind).toBe('unsupported');
  });
});
