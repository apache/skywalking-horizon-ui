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

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, type WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { wireFetch, wireLog, type WireLogSettings } from './wire-log.js';

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'wire-log-')), 'wire.jsonl');
}

/** The stream the wire log is holding right now.
 *
 *  Rotating `debugLog.file` makes the next record() `end()` this stream and
 *  open a new one without awaiting the flush, and `wireLog.close()` awaits
 *  only whichever stream is live when it runs. A test that reads a file the
 *  log has already rotated away must therefore await THAT stream itself, or
 *  it races the flush and reads the file empty. The race needs the libuv
 *  pool busy enough to delay the queued write, which is why it surfaced in
 *  full-suite runs and not when this file ran on its own. */
function liveStream(): WriteStream {
  const held = (wireLog as unknown as { stream: WriteStream | null }).stream;
  if (!held) throw new Error('wire log holds no open stream');
  return held;
}

function settings(overrides: Partial<WireLogSettings> = {}): WireLogSettings {
  return {
    enabled: true,
    file: tmpFile(),
    maxBodyChars: 8192,
    redactAuthHeaders: true,
    ...overrides,
  };
}

function readEntries(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const okFetch =
  (body: unknown, status = 200) =>
  async (): Promise<Response> =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

afterEach(async () => {
  await wireLog.close();
  wireLog.init(() => settings({ enabled: false }));
});

describe('wireFetch', () => {
  it('is a passthrough when disabled — same Response object, no file', async () => {
    const s = settings({ enabled: false });
    wireLog.init(() => s);
    const orig = new Response('{"a":1}');
    const res = await wireFetch(async () => orig)('http://oap:12800/graphql');
    expect(res).toBe(orig);
    expect(existsSync(s.file)).toBe(false);
  });

  it('records method, url, status, headers, bodies, and elapsed', async () => {
    const s = settings();
    wireLog.init(() => s);
    const res = await wireFetch(okFetch({ data: { ok: true } }))('http://oap:12800/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"query":"{ version }"}',
    });
    // The caller still gets a readable body.
    expect(((await res.json()) as { data: { ok: boolean } }).data.ok).toBe(true);
    await wireLog.close();
    const [e] = readEntries(s.file);
    expect(e.method).toBe('POST');
    expect(e.url).toBe('http://oap:12800/graphql');
    expect(e.status).toBe(200);
    expect(e.requestBody).toBe('{"query":"{ version }"}');
    expect(e.responseBody).toBe('{"data":{"ok":true}}');
    expect((e.requestHeaders as Record<string, string>)['content-type']).toBe('application/json');
    expect((e.responseHeaders as Record<string, string>)['content-type']).toBe('application/json');
    expect(typeof e.elapsedMs).toBe('number');
  });

  it('redacts Authorization when redactAuthHeaders is on, keeps it when off', async () => {
    const s = settings();
    wireLog.init(() => s);
    await wireFetch(okFetch({}))('http://oap:12800/graphql', {
      headers: { authorization: 'Basic c2VjcmV0' },
    });
    const rotatedAway = liveStream();
    const off = settings({ redactAuthHeaders: false });
    wireLog.init(() => off);
    await wireFetch(okFetch({}))('http://oap:12800/graphql', {
      headers: { authorization: 'Basic c2VjcmV0' },
    });
    await Promise.all([wireLog.close(), finished(rotatedAway)]);
    const [redacted] = readEntries(s.file);
    expect((redacted.requestHeaders as Record<string, string>).authorization).toBe('<redacted>');
    const [kept] = readEntries(off.file);
    expect((kept.requestHeaders as Record<string, string>).authorization).toBe('Basic c2VjcmV0');
  });

  it('truncates bodies over maxBodyChars with a marker', async () => {
    const s = settings({ maxBodyChars: 10 });
    wireLog.init(() => s);
    await wireFetch(okFetch({ padding: 'x'.repeat(100) }))('http://oap:12800/graphql');
    await wireLog.close();
    const [e] = readEntries(s.file);
    expect(e.responseBody).toMatch(/^.{10}…\[truncated, \d+ chars total\]$/);
  });

  it('maxBodyChars 0 logs the exchange without bodies', async () => {
    const s = settings({ maxBodyChars: 0 });
    wireLog.init(() => s);
    await wireFetch(okFetch({ big: true }))('http://oap:12800/graphql', { body: '{"q":1}', method: 'POST' });
    await wireLog.close();
    const [e] = readEntries(s.file);
    expect(e.status).toBe(200);
    expect(e.requestBody).toBeUndefined();
    expect(e.responseBody).toBeUndefined();
  });

  it('records transport failures with the error and rethrows', async () => {
    const s = settings();
    wireLog.init(() => s);
    await expect(
      wireFetch(async () => {
        throw new Error('socket hang up');
      })('http://oap:12800/graphql'),
    ).rejects.toThrow('socket hang up');
    await wireLog.close();
    const [e] = readEntries(s.file);
    expect(e.error).toBe('socket hang up');
    expect(e.status).toBeUndefined();
  });

  it('passes binary (non-UTF-8) bodies through byte-identical and logs a size marker', async () => {
    const s = settings();
    wireLog.init(() => s);
    // Deliberately invalid UTF-8 (a gzip-style header) — a text round-trip
    // would mangle these bytes into U+FFFD replacements.
    const bytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x80, 0x81]);
    const res = await wireFetch(
      async () =>
        new Response(bytes, { status: 200, headers: { 'content-type': 'application/gzip' } }),
    )('http://oap:12800/api/dump');
    const roundTripped = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(roundTripped)).toEqual(Array.from(bytes));
    await wireLog.close();
    const [e] = readEntries(s.file);
    expect(e.responseBody).toBe('<binary, 8 bytes>');
    expect(e.status).toBe(200);
  });

  it('reopens the stream when debugLog.file changes between calls (hot reload)', async () => {
    const first = settings();
    let live = first;
    wireLog.init(() => live);
    await wireFetch(okFetch({ a: 1 }))('http://oap:12800/graphql');
    const rotatedAway = liveStream();
    live = { ...first, file: tmpFile() };
    await wireFetch(okFetch({ b: 2 }))('http://oap:12800/graphql');
    await Promise.all([wireLog.close(), finished(rotatedAway)]);
    expect(readEntries(first.file)).toHaveLength(1);
    expect(readEntries(live.file)).toHaveLength(1);
  });

  it('recovers after an async stream error instead of writing to a dead stream forever', async () => {
    const s = settings();
    wireLog.init(() => s);
    await wireFetch(okFetch({ a: 1 }))('http://oap:12800/first');
    // Simulate ENOSPC/EIO surfacing via the stream's 'error' event. The
    // errored stream's buffered entry is legitimately lost (destroy());
    // recovery means the NEXT record reopens and lands.
    liveStream().emit('error', new Error('ENOSPC'));
    await wireFetch(okFetch({ b: 2 }))('http://oap:12800/second');
    await wireLog.close();
    expect(readEntries(s.file).map((e) => e.url)).toContain('http://oap:12800/second');
  });

  it('handles null-body statuses when rebuilding the response', async () => {
    const s = settings();
    wireLog.init(() => s);
    const res = await wireFetch(async () => new Response(null, { status: 204 }))(
      'http://oap:12800/api/health',
    );
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    await wireLog.close();
    const [e] = readEntries(s.file);
    expect(e.status).toBe(204);
  });
});
