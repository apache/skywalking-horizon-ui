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
import { AiConversationApi, AiConversationViewError, readFiles } from './ai-conversation';
import type { BffClient } from '../client';

const coldStage = vi.hoisted(() => ({ enabled: false }));
vi.mock('@/controls/coldStage', () => ({
  COLD_STAGE_HEADER: 'X-Horizon-Cold-Stage',
  readColdStageHeader: () => coldStage.enabled,
}));

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

afterEach(() => {
  coldStage.enabled = false;
  vi.unstubAllGlobals();
});

describe('bff.aiConversation.view', () => {
  it('requests cold storage only while the UI selection is enabled', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(
      JSON.stringify({ format: 'asz.view', version: '1.0' }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const { api: a } = api();
    for (const enabled of [false, true, false]) {
      coldStage.enabled = enabled;
      await a.view('c1', { service: 's' });
    }
    const stages = fetchMock.mock.calls.map(([, init]) =>
      new Headers((init as RequestInit).headers).get('X-Horizon-Cold-Stage'),
    );
    expect(stages).toEqual([null, '1', null]);
  });

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

describe('readFiles', () => {
  const frame = (file: string, seq: number, bytes: string): string => {
    const size = new TextEncoder().encode(bytes).length;
    const naming = JSON.stringify({ file, seq, lines: (bytes.match(/\n/g) ?? []).length, bytes: size, digest: 'd' });
    return `${naming}\n${bytes}${size > 0 && !bytes.endsWith('\n') ? '\n' : ''}`;
  };
  /** The body in chunks of `at` bytes, so a file is split across reads wherever the caller says. */
  const stream = (text: string, at: number): ReadableStream<Uint8Array> => {
    const bytes = new TextEncoder().encode(text);
    let pos = 0;
    return new ReadableStream({
      pull(c) {
        if (pos >= bytes.length) {
          c.close();
          return;
        }
        c.enqueue(bytes.slice(pos, pos + at));
        pos += at;
      },
    });
  };
  const read = async (text: string, at: number): Promise<Array<{ seq: number; file: string; text: string }>> => {
    const out: Array<{ seq: number; file: string; text: string }> = [];
    await readFiles(stream(text, at), (f) => out.push({ seq: f.seq, file: f.file, text: new TextDecoder().decode(f.bytes) }));
    return out;
  };

  it('reads each file whole, at any chunk boundary', async () => {
    // a file ending with its own newline, one that does not, one that is empty, and a 4 KB one
    const body =
      frame('a.sd', 1, '{"h":1}\n{"t":"end"}\n') + frame('b.sd', 2, '{"h":1}') + frame('c.sd', 3, '') + frame('d.sd', 4, `${'x'.repeat(4096)}\n`);
    for (const at of [1, 3, 64, 4096, 1 << 20]) {
      const files = await read(body, at);
      expect(files.map((f) => f.seq), `chunks of ${at}`).toEqual([1, 2, 3, 4]);
      expect(files[0]!.text).toBe('{"h":1}\n{"t":"end"}\n');
      expect(files[1]!.text).toBe('{"h":1}');
      expect(files[2]!.text).toBe('');
      expect(files[3]!.text).toBe(`${'x'.repeat(4096)}\n`);
    }
  });

  it('answers with nothing when nothing was stored', async () => {
    expect(await read('', 16)).toEqual([]);
  });

  it('refuses a body that ends inside a file, or is not this framing', async () => {
    await expect(read(frame('a.sd', 1, '{"h":1}\n').slice(0, -3), 8)).rejects.toThrow();
    await expect(read('{"file":"a.sd"}\n', 8)).rejects.toThrow();
    await expect(read('not a naming line\n', 8)).rejects.toThrow();
  });

  it('refuses a file whose count is not followed by the newline that closes it', async () => {
    // the byte after a file that does not end with its own newline says the count was the file's. A
    // different byte there means every file after it would be read at the wrong offset.
    const wrong = `${JSON.stringify({ file: 'a.sd', seq: 1, lines: 1, bytes: 7, digest: 'd' })}\n{"h":1}X${frame('b.sd', 2, 'later\n')}`;
    await expect(read(wrong, 8)).rejects.toThrow();
  });

  it('ends the body when it refuses a frame, rather than leaving it streaming', async () => {
    // A body nobody will read must not stay open: the browser keeps receiving it and the relay
    // behind it keeps asking OAP for the rest.
    const bytes = new TextEncoder().encode('not a naming line\n');
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readFiles(stream, () => undefined)).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  });

  it('reads a file of megabytes without copying it again for every chunk', async () => {
    // Joining each chunk onto the whole would copy about 130 MB for these 2 MB, so a regression
    // shows as this test running out of time rather than as a stopwatch reading, which under a
    // parallel suite says more about the machine than about the code.
    const big = `${'y'.repeat(2 * 1024 * 1024)}\n`;
    const files = await read(frame('big.sd', 9, big), 16 * 1024);
    expect(files[0]!.text.length).toBe(big.length);
  });

  it('reads a file that arrives in very many small chunks', async () => {
    // Dropping a consumed chunk by shifting the array moves every chunk still held, which is the
    // same quadratic cost the copying had, just paid on references. These are 131,000 chunks, which
    // is seconds of moving them, so a regression runs the test out of time rather than being timed.
    const big = `${'z'.repeat(2 * 1024 * 1024)}\n`;
    const files = await read(frame('many.sd', 3, big), 16);
    expect(files[0]!.text.length).toBe(big.length);
  });
});
