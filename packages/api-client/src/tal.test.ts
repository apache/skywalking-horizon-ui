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

import { describe, expect, it } from 'vitest';
import { TalClient } from './tal.js';
import { RuntimeRuleApiError } from './types.js';
import type { FetchLike } from './runtime-rule.js';

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

const client = (fetchImpl: FetchLike): TalClient =>
  new TalClient({ adminUrl: 'http://oap:17128/', fetch: fetchImpl });

describe('TalClient', () => {
  it('lists the files with their rules as OAP sends them', async () => {
    const listing = {
      files: [
        {
          name: 'native-segment',
          list: 'nativeTalFiles',
          inputType: 'sw-native',
          rules: [{ name: 'native-segment', layer: 'GENERAL', inputType: 'sw-native', line: 22, order: 0, debuggable: true }],
        },
      ],
      count: 1,
    };
    const { fetchImpl, calls } = recorder(() => json(listing));
    await expect(client(fetchImpl).listFiles()).resolves.toEqual(listing);
    expect(calls[0].url).toBe('http://oap:17128/runtime/tal/files');
  });

  it('reads a file as text, percent-encoding its name, and returns null when the node has no such file', async () => {
    const { fetchImpl, calls } = recorder((url) =>
      url.endsWith('missing') ? new Response('TAL file not loaded: missing', { status: 404 }) : new Response('rules: []'),
    );
    const c = client(fetchImpl);
    await expect(c.getFileContent('vm linux')).resolves.toBe('rules: []');
    await expect(c.getFileContent('missing')).resolves.toBeNull();
    expect(calls[0].url).toBe('http://oap:17128/runtime/tal/files/vm%20linux');
  });

  it('throws on any other failure', async () => {
    const { fetchImpl } = recorder(() => new Response('boom', { status: 500 }));
    await expect(client(fetchImpl).listFiles()).rejects.toBeInstanceOf(RuntimeRuleApiError);
  });
});
