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
import { OalClient } from './oal.js';
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

const client = (fetchImpl: FetchLike): OalClient =>
  new OalClient({ adminUrl: 'http://oap:17128/', fetch: fetchImpl });

describe('OalClient — request targeting', () => {
  it('strips a trailing adminUrl slash and percent-encodes both path params', async () => {
    const { fetchImpl, calls } = recorder((url) =>
      url.includes('/files/') ? new Response('// oal') : json({}),
    );
    const c = client(fetchImpl);
    await c.listFiles();
    await c.getFileContent('core rules.oal');
    await c.getSource('Endpoint/Relation');
    expect(calls[0].url).toBe('http://oap:17128/runtime/oal/files');
    expect(calls[1].url).toBe('http://oap:17128/runtime/oal/files/core%20rules.oal');
    expect(calls[2].url).toBe('http://oap:17128/runtime/oal/rules/Endpoint%2FRelation');
  });

  it('returns null on 404 for the two single-item reads instead of throwing', async () => {
    // A missing .oal file / unowned source is a normal answer for the picker,
    // not a transport failure.
    const { fetchImpl } = recorder(() => new Response('not found', { status: 404 }));
    const c = client(fetchImpl);
    await expect(c.getFileContent('gone.oal')).resolves.toBeNull();
    await expect(c.getSource('Nope')).resolves.toBeNull();
  });
});

describe('OalClient — error wrapping', () => {
  it('renders the code envelope with its own code, not a missing applyStatus', async () => {
    // The OAL handler answers with the same `{status,code,message}` envelope
    // dsl-debugging uses, so this client shares the defect and the fix. The
    // envelope below is CONSTRUCTED to pin the rendering: in practice OAP emits
    // `missing_source` only when the path param is absent (unreachable from
    // getSource(<non-empty>)) and `source_not_found` as a 404 this client turns
    // into `null` — so the point here is that the shared renderer is wired into
    // OalClient at all, not that this exact reply arrives on this call.
    const body = {
      status: 'error',
      code: 'missing_source',
      message: 'source path param is required',
    };
    const { fetchImpl } = recorder(() => json(body, 400));
    const err = (await client(fetchImpl)
      .getSource('Endpoint')
      .catch((e: unknown) => e)) as RuntimeRuleApiError;
    expect(err).toBeInstanceOf(RuntimeRuleApiError);
    expect(err.status).toBe(400);
    expect(err.body).toEqual(body);
    expect(err.message).toBe(
      '400 on http://oap:17128/runtime/oal/rules/Endpoint — ' +
        'missing_source: source path param is required',
    );
    expect(err.message).not.toContain('undefined');
  });

  it('keeps a non-JSON body as raw text instead of inventing an envelope', async () => {
    const { fetchImpl } = recorder(() => new Response('<html>502</html>', { status: 502 }));
    const err = (await client(fetchImpl)
      .listSources()
      .catch((e: unknown) => e)) as RuntimeRuleApiError;
    expect(err.body).toBe('<html>502</html>');
    expect(err.message).toContain('<html>502</html>');
  });
});
