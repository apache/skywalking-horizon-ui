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

import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import {
  AiConversationViewTimeout,
  aiConversationViewPath,
  listAiConversations,
  openAiConversationView,
} from './ai-conversation.js';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

interface Captured {
  query: string;
  variables: Record<string, unknown>;
}

const ROW = {
  conversation: 'c1',
  serviceInstanceId: 'aW5zdA==',
  serviceInstanceName: 'me@host',
  title: null,
  round: 3,
  talks: 2,
  steps: 10,
  streams: 1,
  segments: 1,
  unresolved: 0,
  from: 100,
  to: 200,
};

/** An OAP answering `listConversations` with one row and recording the call. */
function fakeOap(errorReason: string | null = null): { fetch: FetchLike; last: () => Captured } {
  let last: Captured = { query: '', variables: {} };
  const fetch: FetchLike = async (_url, init) => {
    last = JSON.parse(String(init?.body ?? '{}')) as Captured;
    return json({ data: { listConversations: { errorReason, conversations: [ROW] } } });
  };
  return { fetch, last: () => last };
}

const OPTS = { queryUrl: 'http://oap:12800', timeoutMs: 1000 };
const DURATION = { start: '2026-09-01 000000', end: '2026-09-05 000000', step: 'SECOND' as const };

describe('listAiConversations', () => {
  it('addresses the service by NAME, sends the limit, and normalises the row', async () => {
    const oap = fakeOap();
    const res = await listAiConversations(
      { ...OPTS, fetch: oap.fetch },
      { serviceName: 'Claude Code', limit: 10_000, duration: DURATION },
    );
    expect(oap.last().variables.condition).toEqual({
      service: { serviceName: 'Claude Code' },
      limit: 10_000,
    });
    expect(oap.last().variables.duration).toEqual(DURATION);
    expect(res.errorReason).toBeUndefined();
    // A null title is an empty title, never the string "null".
    expect(res.rows).toEqual([{ ...ROW, title: '' }]);
  });

  it('names the sender as an InstanceCondition that repeats the service name', async () => {
    const oap = fakeOap();
    await listAiConversations(
      { ...OPTS, fetch: oap.fetch },
      { serviceName: 'Claude Code', instanceName: 'me@host', limit: 5, duration: DURATION },
    );
    expect(oap.last().variables.condition).toEqual({
      service: { serviceName: 'Claude Code' },
      instance: { serviceName: 'Claude Code', instanceName: 'me@host' },
      limit: 5,
    });
  });

  it('carries the cold-stage flag on the duration untouched', async () => {
    const oap = fakeOap();
    await listAiConversations(
      { ...OPTS, fetch: oap.fetch },
      { serviceName: 'Claude Code', limit: 5, duration: { ...DURATION, coldStage: true } },
    );
    expect(oap.last().variables.duration).toEqual({ ...DURATION, coldStage: true });
  });

  it('relays OAP errorReason beside whatever rows came', async () => {
    const oap = fakeOap('storage is slow');
    const res = await listAiConversations(
      { ...OPTS, fetch: oap.fetch },
      { serviceName: 'Claude Code', limit: 5, duration: DURATION },
    );
    expect(res.errorReason).toBe('storage is slow');
    expect(res.rows).toHaveLength(1);
  });
});

describe('aiConversationViewPath', () => {
  it('is the OAP route with the service, and the sender only when given', () => {
    expect(aiConversationViewPath('c 1', 'Claude Code')).toBe(
      '/ai-agent/conversations/c%201/v1/view?service=Claude+Code',
    );
    expect(aiConversationViewPath('c1', 'Claude Code', 'me@host')).toBe(
      '/ai-agent/conversations/c1/v1/view?service=Claude+Code&instance=me%40host',
    );
  });
});

describe('openAiConversationView', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function drain(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    return Buffer.concat(chunks);
  }

  const DOC_GZIP = gzipSync(JSON.stringify({ format: 'asz.view', version: '1.0', conversation: 'c1' }));
  const JSON_TYPE = 'application/vnd.skywalking.asz.view+json; version=1.0; charset=utf-8';

  it('forwards Accept, Accept-Encoding and basic auth, and returns the compressed bytes untouched', async () => {
    let seen: IncomingHttpHeaders = {};
    let path = '';
    const url = await serve((req, res) => {
      seen = req.headers;
      path = req.url ?? '';
      res.writeHead(200, { 'content-type': JSON_TYPE, 'content-encoding': 'gzip' });
      // Two chunks, so the relay is proven to stream rather than buffer.
      res.write(DOC_GZIP.subarray(0, 10));
      setTimeout(() => res.end(DOC_GZIP.subarray(10)), 10);
    });
    const up = await openAiConversationView(
      { queryUrl: url, timeoutMs: 2000, auth: { username: 'u', password: 'p' } },
      { conversation: 'c1', serviceName: 'Claude Code', instanceName: 'me@host', format: 'json', acceptEncoding: 'gzip, br' },
    );
    expect(path).toBe('/ai-agent/conversations/c1/v1/view?service=Claude+Code&instance=me%40host');
    expect(seen.accept).toBe('application/vnd.skywalking.asz.view+json');
    expect(seen['accept-encoding']).toBe('gzip, br');
    expect(seen.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    expect(up.status).toBe(200);
    expect(up.headers['content-type']).toBe(JSON_TYPE);
    expect(up.headers['content-encoding']).toBe('gzip');
    // Byte-equal to what the server wrote: nothing decompressed it on the way.
    expect((await drain(up.body)).equals(DOC_GZIP)).toBe(true);
  });

  it('asks for the yaml twin when told, and sends no Accept-Encoding when the browser sent none', async () => {
    let seen: IncomingHttpHeaders = {};
    const url = await serve((req, res) => {
      seen = req.headers;
      res.writeHead(200, { 'content-type': 'application/vnd.skywalking.asz.view+yaml; version=1.0' });
      res.end('format: asz.view\n');
    });
    const up = await openAiConversationView(
      { queryUrl: `${url}/`, timeoutMs: 2000 },
      { conversation: 'c1', serviceName: 'Claude Code', format: 'yaml' },
    );
    expect(seen.accept).toBe('application/vnd.skywalking.asz.view+yaml');
    expect(seen['accept-encoding']).toBeUndefined();
    expect(seen.authorization).toBeUndefined();
    expect((await drain(up.body)).toString()).toBe('format: asz.view\n');
  });

  it('relays a problem+json answer with its status', async () => {
    const problem = { type: 'about:blank', title: 'Not Found', status: 404, detail: 'no round of conversation x is stored for this service' };
    const url = await serve((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/problem+json; charset=utf-8' });
      res.end(JSON.stringify(problem));
    });
    const up = await openAiConversationView(
      { queryUrl: url, timeoutMs: 2000 },
      { conversation: 'x', serviceName: 'Claude Code', format: 'json' },
    );
    expect(up.status).toBe(404);
    expect(up.headers['content-type']).toContain('application/problem+json');
    expect(JSON.parse((await drain(up.body)).toString())).toEqual(problem);
  });

  it('times out when OAP sends nothing, naming the limit', async () => {
    const url = await serve(() => {
      /* the fold never finishes */
    });
    await expect(
      openAiConversationView(
        { queryUrl: url, timeoutMs: 100 },
        { conversation: 'c1', serviceName: 'Claude Code', format: 'json' },
      ),
    ).rejects.toBeInstanceOf(AiConversationViewTimeout);
  });

  it('rejects at once when the caller has already gone', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      openAiConversationView(
        { queryUrl: 'http://127.0.0.1:9', timeoutMs: 1000, signal: ac.signal },
        { conversation: 'c1', serviceName: 'Claude Code', format: 'json' },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('drops the upstream socket when the caller goes away mid-stream', async () => {
    const closed = new Promise<void>((resolve) => {
      void serve((_req, res) => {
        res.writeHead(200, { 'content-type': JSON_TYPE });
        res.write('{"format":"asz.view"');
        res.on('close', () => resolve());
      }).then((url) => {
        const ac = new AbortController();
        return openAiConversationView(
          { queryUrl: url, timeoutMs: 5000, signal: ac.signal },
          { conversation: 'c1', serviceName: 'Claude Code', format: 'json' },
        ).then((up) => {
          up.body.on('error', () => {
            /* the destroyed socket reports here; the assertion is the server's close */
          });
          ac.abort();
        });
      });
    });
    await expect(closed).resolves.toBeUndefined();
  });
});
