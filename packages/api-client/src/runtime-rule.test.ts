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
import { RuntimeRuleClient, type FetchLike } from './runtime-rule.js';
import { RuntimeRuleApiError, type ApplyResult } from './types.js';

interface Recorded {
  url: string;
  init: RequestInit;
}

function recorder(reply: (url: string) => Response | Promise<Response>): {
  fetchImpl: FetchLike;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return reply(String(input));
  };
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const headersOf = (call: Recorded): Record<string, string> =>
  (call.init.headers as Record<string, string> | undefined) ?? {};

const query = (url: string): URLSearchParams => new URL(url).searchParams;

const APPLIED: ApplyResult = {
  applyStatus: 'structural_applied',
  catalog: 'otel-rules',
  name: 'vm',
  message: 'ok',
  applyId: 'a-1',
};

describe('RuntimeRuleClient — request targeting', () => {
  it('strips a trailing slash from adminUrl so paths never double up', async () => {
    const { fetchImpl, calls } = recorder(() => json({ rules: [] }));
    await new RuntimeRuleClient({ adminUrl: 'http://oap:17128/', fetch: fetchImpl }).list();
    expect(calls[0].url).toBe('http://oap:17128/runtime/rule/list');
  });

  it('omits the catalog filter entirely when list() is called without one', async () => {
    const { fetchImpl, calls } = recorder(() => json({ rules: [] }));
    const client = new RuntimeRuleClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl });
    await client.list();
    await client.list('lal');
    expect(calls[0].url).not.toContain('?');
    expect(query(calls[1].url).get('catalog')).toBe('lal');
  });

  it('asks for the bundled twin only when a source is given', async () => {
    // `source: 'bundled'` is what "diff against bundled" and the revertToBundled
    // preview ride on. Drop the param and OAP answers with the runtime DAO row
    // instead — the diff comes back empty and the operator reads their own edit
    // as the shipped default.
    const { fetchImpl, calls } = recorder(() => new Response('a: 1'));
    const client = new RuntimeRuleClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl });
    await client.get({ catalog: 'lal', name: 'k8s' });
    await client.get({ catalog: 'lal', name: 'k8s', source: 'bundled' });
    expect(query(calls[0].url).has('source')).toBe(false);
    expect(query(calls[1].url).get('source')).toBe('bundled');
  });

  it('requests bundled entries with their content unless the caller opts out', async () => {
    // The bundled pane renders `content`; a false default leaves every body
    // empty while the list still looks fully populated.
    const { fetchImpl, calls } = recorder(() => json([]));
    const client = new RuntimeRuleClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl });
    await client.listBundled('lal');
    await client.listBundled('lal', false);
    expect(query(calls[0].url).get('catalog')).toBe('lal');
    expect(query(calls[0].url).get('withContent')).toBe('true');
    expect(query(calls[1].url).get('withContent')).toBe('false');
  });

  it('percent-encodes rule names so slashes and spaces survive the round trip', async () => {
    const { fetchImpl, calls } = recorder(() => json(APPLIED));
    const name = 'vm rules/linux & more';
    await new RuntimeRuleClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl }).addOrUpdate({
      catalog: 'otel-rules',
      name,
      body: 'expSuffix: x',
    });
    expect(calls[0].url).not.toContain(' ');
    expect(query(calls[0].url).get('name')).toBe(name);
  });

  it('sends allowStorageChange / force only when the caller opts in', async () => {
    const { fetchImpl, calls } = recorder(() => json(APPLIED));
    const client = new RuntimeRuleClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl });
    await client.addOrUpdate({ catalog: 'otel-rules', name: 'vm', body: 'a: 1' });
    await client.addOrUpdate({
      catalog: 'otel-rules',
      name: 'vm',
      body: 'a: 1',
      allowStorageChange: false,
      force: false,
    });
    await client.addOrUpdate({
      catalog: 'otel-rules',
      name: 'vm',
      body: 'a: 1',
      allowStorageChange: true,
      force: true,
    });
    expect(query(calls[0].url).has('allowStorageChange')).toBe(false);
    expect(query(calls[0].url).has('force')).toBe(false);
    expect(query(calls[1].url).has('allowStorageChange')).toBe(false);
    expect(query(calls[1].url).has('force')).toBe(false);
    expect(query(calls[2].url).get('allowStorageChange')).toBe('true');
    expect(query(calls[2].url).get('force')).toBe('true');
  });

  it('distinguishes a plain delete from revertToBundled via the mode param', async () => {
    const { fetchImpl, calls } = recorder(() => json({ ...APPLIED, applyStatus: 'deleted' }));
    const client = new RuntimeRuleClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl });
    await client.delete('lal', 'k8s-service');
    await client.delete('lal', 'k8s-service', 'revertToBundled');
    expect(query(calls[0].url).has('mode')).toBe(false);
    expect(query(calls[1].url).get('mode')).toBe('revertToBundled');
  });

  it('polls status by applyId or by contentHash, sending only what it was given', async () => {
    const { fetchImpl, calls } = recorder(() => json({ found: true, phase: 'APPLIED' }));
    const client = new RuntimeRuleClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl });
    await client.status({ catalog: 'otel-rules', name: 'vm' });
    await client.status({ catalog: 'otel-rules', name: 'vm', applyId: 'a-1' });
    await client.status({ catalog: 'otel-rules', name: 'vm', contentHash: 'deadbeef' });
    expect(query(calls[0].url).has('applyId')).toBe(false);
    expect(query(calls[0].url).has('contentHash')).toBe(false);
    expect(query(calls[1].url).get('applyId')).toBe('a-1');
    expect(query(calls[2].url).get('contentHash')).toBe('deadbeef');
  });

  it('returns the dump Response unparsed so the tar.gz stream reaches the caller intact', async () => {
    const bytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
    const { fetchImpl, calls } = recorder(
      () => new Response(bytes, { headers: { 'content-type': 'application/gzip' } }),
    );
    const client = new RuntimeRuleClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl });
    const all = await client.dump();
    const one = await client.dump('log-mal-rules');
    expect(calls[0].url).toBe('http://oap:17128/runtime/rule/dump');
    expect(calls[1].url).toBe('http://oap:17128/runtime/rule/dump/log-mal-rules');
    expect(Array.from(new Uint8Array(await all.arrayBuffer()))).toEqual(Array.from(bytes));
    expect(one.headers.get('content-type')).toBe('application/gzip');
  });
});

describe('RuntimeRuleClient — headers', () => {
  it('applies the configured default headers (auth) to every call', async () => {
    const { fetchImpl, calls } = recorder(() => json({ rules: [] }));
    const client = new RuntimeRuleClient({
      adminUrl: 'http://oap:17128',
      fetch: fetchImpl,
      headers: { Authorization: 'Basic c2VjcmV0' },
    });
    await client.list();
    await client.get({ catalog: 'lal', name: 'k8s' });
    expect(headersOf(calls[0]).Authorization).toBe('Basic c2VjcmV0');
    expect(headersOf(calls[1]).Authorization).toBe('Basic c2VjcmV0');
  });

  it('lets a per-call header win over a default of the same name', async () => {
    // get() must stay on the YAML accept — a JSON envelope would arrive as
    // the rule body and the X-Sw-* header mapping below would read nothing.
    const { fetchImpl, calls } = recorder(() => new Response('a: 1'));
    await new RuntimeRuleClient({
      adminUrl: 'http://oap:17128',
      fetch: fetchImpl,
      headers: { Accept: 'application/json' },
    }).get({ catalog: 'lal', name: 'k8s' });
    expect(headersOf(calls[0]).Accept).toBe('application/x-yaml');
  });

  it('sends If-None-Match only when the caller supplies an etag', async () => {
    const { fetchImpl, calls } = recorder(() => new Response('a: 1'));
    const client = new RuntimeRuleClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl });
    await client.get({ catalog: 'lal', name: 'k8s' });
    await client.get({ catalog: 'lal', name: 'k8s', ifNoneMatch: '"abc"' });
    expect(headersOf(calls[0])['If-None-Match']).toBeUndefined();
    expect(headersOf(calls[1])['If-None-Match']).toBe('"abc"');
  });

  it('posts rule bodies as raw text/plain YAML, byte-for-byte', async () => {
    const { fetchImpl, calls } = recorder(() => json(APPLIED));
    const body = 'expSuffix: sum(1)\nmetricsRules:\n  - name: vm\n';
    await new RuntimeRuleClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl }).addOrUpdate({
      catalog: 'otel-rules',
      name: 'vm',
      body,
    });
    expect(headersOf(calls[0])['Content-Type']).toBe('text/plain');
    expect(calls[0].init.body).toBe(body);
  });
});

describe('RuntimeRuleClient — get() envelope', () => {
  it('maps the X-Sw-* response headers onto the envelope and keeps the YAML verbatim', async () => {
    const yaml = 'filter: "{ tags -> tags.job_name == \'vm\' }"\nexpSuffix: sum\n';
    const { fetchImpl } = recorder(
      () =>
        new Response(yaml, {
          headers: {
            'X-Sw-Status': 'ACTIVE',
            'X-Sw-Source': 'runtime',
            'X-Sw-Content-Hash': 'abc123',
            'X-Sw-Update-Time': '1717070000000',
            ETag: '"abc123"',
          },
        }),
    );
    const got = await new RuntimeRuleClient({
      adminUrl: 'http://oap:17128',
      fetch: fetchImpl,
    }).get({ catalog: 'otel-rules', name: 'vm' });
    expect(got).toEqual({
      status: 'ACTIVE',
      source: 'runtime',
      contentHash: 'abc123',
      updateTime: 1717070000000,
      etag: '"abc123"',
      content: yaml,
    });
  });

  it('falls back to n/a / runtime / 0 when OAP omits the X-Sw-* headers', async () => {
    const { fetchImpl } = recorder(() => new Response('a: 1'));
    const got = await new RuntimeRuleClient({
      adminUrl: 'http://oap:17128',
      fetch: fetchImpl,
    }).get({ catalog: 'otel-rules', name: 'vm' });
    expect(got).toEqual({
      status: 'n/a',
      source: 'runtime',
      contentHash: '',
      updateTime: 0,
      etag: '',
      content: 'a: 1',
    });
  });

  it('turns a 304 into the NotModified sentinel instead of an error', async () => {
    const { fetchImpl } = recorder(
      () =>
        new Response(null, {
          status: 304,
          headers: {
            ETag: '"abc123"',
            'X-Sw-Content-Hash': 'abc123',
            'X-Sw-Status': 'ACTIVE',
          },
        }),
    );
    const got = await new RuntimeRuleClient({
      adminUrl: 'http://oap:17128',
      fetch: fetchImpl,
    }).get({ catalog: 'otel-rules', name: 'vm', ifNoneMatch: '"abc123"' });
    expect(got).toEqual({
      notModified: true,
      etag: '"abc123"',
      contentHash: 'abc123',
      status: 'ACTIVE',
    });
  });
});

describe('RuntimeRuleClient — error wrapping', () => {
  it('parses an ApplyResult error body so callers can switch on applyStatus', async () => {
    const body = {
      applyStatus: 'storage_change_requires_explicit_approval',
      catalog: 'otel-rules',
      name: 'vm',
      message: 'storage identity moved',
    };
    const { fetchImpl } = recorder(() => json(body, 409));
    const client = new RuntimeRuleClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl });
    const err = await client
      .addOrUpdate({ catalog: 'otel-rules', name: 'vm', body: 'a: 1' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RuntimeRuleApiError);
    const api = err as RuntimeRuleApiError;
    expect(api.status).toBe(409);
    expect(api.body).toEqual(body);
    expect(api.url).toContain('/runtime/rule/addOrUpdate');
    expect(api.message).toContain('storage_change_requires_explicit_approval');
  });

  it('keeps a non-JSON error body as raw text', async () => {
    const { fetchImpl } = recorder(
      () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    );
    const err = (await new RuntimeRuleClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl })
      .list()
      .catch((e: unknown) => e)) as RuntimeRuleApiError;
    expect(err.status).toBe(502);
    expect(err.body).toBe('<html>502 Bad Gateway</html>');
  });

  it('keeps JSON that is not an ApplyResult as raw text rather than faking one', async () => {
    const { fetchImpl } = recorder(() => json({ error: 'inspect disabled' }, 400));
    const err = (await new RuntimeRuleClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl })
      .delete('lal', 'k8s')
      .catch((e: unknown) => e)) as RuntimeRuleApiError;
    expect(typeof err.body).toBe('string');
    expect(err.body).toBe('{"error":"inspect disabled"}');
  });

  it('accepts every 2xx as an apply result, and only 2xx', async () => {
    const ok = recorder(() => json(APPLIED, 202));
    const bad = recorder(() => json(APPLIED, 302));
    await expect(
      new RuntimeRuleClient({ adminUrl: 'http://oap:17128', fetch: ok.fetchImpl }).inactivate(
        'otel-rules',
        'vm',
      ),
    ).resolves.toEqual(APPLIED);
    await expect(
      new RuntimeRuleClient({ adminUrl: 'http://oap:17128', fetch: bad.fetchImpl }).inactivate(
        'otel-rules',
        'vm',
      ),
    ).rejects.toBeInstanceOf(RuntimeRuleApiError);
  });
});

describe('RuntimeRuleClient — timeout plumbing', () => {
  afterEach(() => vi.useRealTimers());

  it('sends no abort signal when timeoutMs is 0 (disabled)', async () => {
    const { fetchImpl, calls } = recorder(() => json({ rules: [] }));
    await new RuntimeRuleClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl }).list();
    expect(calls[0].init.signal).toBeUndefined();
  });

  it('aborts the in-flight request once timeoutMs elapses', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const client = new RuntimeRuleClient({
      adminUrl: 'http://oap:17128',
      timeoutMs: 5_000,
      fetch: async (_url, init) => {
        seen = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          seen?.addEventListener('abort', () => reject(new Error('aborted by timeout')));
        });
      },
    });
    // The rejection expectation is attached before the clock moves so the
    // abort never surfaces as an unhandled rejection.
    const pending = expect(client.list()).rejects.toThrow('aborted by timeout');
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(seen?.aborted).toBe(true);
  });

  it('clears the timer once the response lands, so a later tick cannot abort a settled call', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const client = new RuntimeRuleClient({
      adminUrl: 'http://oap:17128',
      timeoutMs: 5_000,
      fetch: async (_url, init) => {
        seen = init?.signal ?? undefined;
        return json({ rules: [] });
      },
    });
    await client.list();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen?.aborted).toBe(false);
  });
});
