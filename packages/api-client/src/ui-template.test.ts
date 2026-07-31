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
import { UITemplateApiError, UITemplateClient, type FetchLike } from './ui-template.js';

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

const ACK = { id: 'horizon.layer.general', status: true, message: '' };

describe('UITemplateClient — template store reads', () => {
  it('always lists with includingDisabled so soft-deleted rows stay visible to sync', async () => {
    // Without the flag OAP hides disabled rows, and sync would re-create a row
    // the operator deliberately disabled.
    const { fetchImpl, calls } = recorder(() => json([]));
    await new UITemplateClient({ adminUrl: 'http://oap:17128/', fetch: fetchImpl }).list();
    expect(calls[0].url).toBe('http://oap:17128/ui-management/templates?includingDisabled=true');
    expect(calls[0].init.method).toBe('GET');
  });

  it('returns the rows verbatim — configuration stays an opaque JSON string', async () => {
    const rows = [
      { id: 'horizon.layer.general', configuration: '{"name":"horizon.layer.general"}', disabled: false },
      { id: 'legacy-uuid', configuration: '{"name":"other-ui"}', disabled: true },
    ];
    const { fetchImpl } = recorder(() => json(rows));
    const got = await new UITemplateClient({
      adminUrl: 'http://oap:17128',
      fetch: fetchImpl,
    }).list();
    expect(got).toEqual(rows);
  });
});

describe('UITemplateClient — template store writes', () => {
  it('creates with the envelope name as the row id, in the JSON body', async () => {
    // Upstream skywalking#13884 made `id` REQUIRED on create; dropping it puts
    // the row at a server-allocated UUID that sync can never match again.
    const { fetchImpl, calls } = recorder(() => json(ACK));
    const configuration = '{"name":"horizon.layer.general","widgets":[]}';
    const ack = await new UITemplateClient({
      adminUrl: 'http://oap:17128',
      fetch: fetchImpl,
    }).create('horizon.layer.general', configuration);
    expect(calls[0].url).toBe('http://oap:17128/ui-management/templates');
    expect(calls[0].init.method).toBe('POST');
    expect(headersOf(calls[0])['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      id: 'horizon.layer.general',
      configuration,
    });
    expect(ack).toEqual(ACK);
  });

  it('updates in place with PUT on the same collection path', async () => {
    const { fetchImpl, calls } = recorder(() => json(ACK));
    await new UITemplateClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl }).update(
      'horizon.overview.services.i18n.zh-CN',
      '{"name":"x"}',
    );
    expect(calls[0].init.method).toBe('PUT');
    expect(calls[0].url).toBe('http://oap:17128/ui-management/templates');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      id: 'horizon.overview.services.i18n.zh-CN',
      configuration: '{"name":"x"}',
    });
  });

  it('percent-encodes the row id on disable so it cannot re-target another path', async () => {
    const { fetchImpl, calls } = recorder(() => json(ACK));
    await new UITemplateClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl }).disable(
      'horizon.layer.k8s service/1',
    );
    expect(calls[0].url).toBe(
      'http://oap:17128/ui-management/templates/horizon.layer.k8s%20service%2F1/disable',
    );
    expect(calls[0].init.method).toBe('POST');
  });
});

describe('UITemplateClient — errors and headers', () => {
  it('wraps a non-2xx into UITemplateApiError carrying status, url and body', async () => {
    const { fetchImpl } = recorder(() => new Response('template store unreachable', { status: 503 }));
    const err = (await new UITemplateClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl })
      .list()
      .catch((e: unknown) => e)) as UITemplateApiError;
    expect(err).toBeInstanceOf(UITemplateApiError);
    expect(err.name).toBe('UITemplateApiError');
    expect(err.status).toBe(503);
    expect(err.url).toContain('/ui-management/templates');
    expect(err.body).toBe('template store unreachable');
  });

  it('keeps the whole body on the error while capping the message at 200 chars', async () => {
    const body = 'x'.repeat(500);
    const { fetchImpl } = recorder(() => new Response(body, { status: 500 }));
    const err = (await new UITemplateClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl })
      .create('horizon.layer.general', '{}')
      .catch((e: unknown) => e)) as UITemplateApiError;
    expect(err.body).toBe(body);
    expect(err.message).toContain('x'.repeat(200));
    expect(err.message).not.toContain('x'.repeat(201));
  });

  it('sends Accept: application/json plus the configured default headers on every call', async () => {
    const { fetchImpl, calls } = recorder(() => json(ACK));
    const client = new UITemplateClient({
      adminUrl: 'http://oap:17128',
      fetch: fetchImpl,
      headers: { Authorization: 'Basic c2VjcmV0' },
    });
    await client.list();
    await client.disable('horizon.layer.general');
    for (const call of calls) {
      expect(headersOf(call).Accept).toBe('application/json');
      expect(headersOf(call).Authorization).toBe('Basic c2VjcmV0');
    }
  });
});

describe('UITemplateClient — timeout plumbing', () => {
  afterEach(() => vi.useRealTimers());

  it('sends no abort signal when timeoutMs is 0 (disabled)', async () => {
    const { fetchImpl, calls } = recorder(() => json([]));
    await new UITemplateClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl }).list();
    expect(calls[0].init.signal).toBeUndefined();
  });

  it('aborts the in-flight request once timeoutMs elapses', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const client = new UITemplateClient({
      adminUrl: 'http://oap:17128',
      timeoutMs: 3_000,
      fetch: async (_url, init) => {
        seen = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          seen?.addEventListener('abort', () => reject(new Error('aborted by timeout')));
        });
      },
    });
    const pending = expect(client.list()).rejects.toThrow('aborted by timeout');
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    await pending;
    expect(seen?.aborted).toBe(true);
  });

  it('clears the timer once the call settles, so a later tick cannot abort a completed call', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const client = new UITemplateClient({
      adminUrl: 'http://oap:17128',
      timeoutMs: 3_000,
      fetch: async (_url, init) => {
        seen = init?.signal ?? undefined;
        return json([]);
      },
    });
    await client.list();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen?.aborted).toBe(false);
  });
});
