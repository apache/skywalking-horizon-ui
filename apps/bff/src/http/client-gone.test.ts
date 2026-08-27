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

/**
 * "The client has stopped listening" has to mean exactly that.
 *
 * Both errors are silent. Too eager, and a successful reply cancels the work
 * that produced it — the response is already on the wire, so what breaks is
 * whatever was still finishing behind it. Too reluctant, and abandoned reads
 * cost OAP just as much as watched ones, which is the whole reason for this.
 *
 * Driven over a real socket rather than `app.inject`, because the thing under
 * test IS the socket closing: injection never opens one, so it could not tell
 * the two cases apart.
 */

import { describe, expect, it, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { clientGone } from './client-gone.js';

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

/** A server whose handler reports what happened to its signal.
 *
 * `aborted` counts a signal that arrived ALREADY aborted, not just one that
 * fires later: `addEventListener('abort')` never runs on an aborted signal, so
 * a watcher built only on the event reports the most damaging case — every read
 * cancelled before it started — as "never aborted". */
async function serve(): Promise<{ url: string; aborted: () => boolean | null }> {
  let seen: boolean | null = null;
  const watch = (reply: Parameters<typeof clientGone>[0]): void => {
    const signal = clientGone(reply);
    seen = signal.aborted;
    signal.addEventListener('abort', () => {
      seen = true;
    });
  };
  app = Fastify();
  app.get('/slow', async (_req, reply) => {
    watch(reply);
    // Long enough that the caller can give up first.
    await new Promise((r) => setTimeout(r, 300));
    return reply.send({ ok: true });
  });
  app.get('/fast', async (_req, reply) => {
    watch(reply);
    return reply.send({ ok: true });
  });
  // Behind an async preHandler, as every read route is: `requireAuth` awaits,
  // and it is during that await that Node finishes and destroys the request's
  // readable. A route whose handler runs synchronously never sees it.
  app.post(
    '/body',
    { preHandler: async () => { await new Promise((r) => setImmediate(r)); } },
    async (_req, reply) => {
      watch(reply);
      return reply.send({ ok: true });
    },
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, aborted: () => seen };
}

describe('clientGone', () => {
  it('fires when the caller hangs up mid-request', async () => {
    const { url, aborted } = await serve();
    const ac = new AbortController();

    const req = fetch(`${url}/slow`, { signal: ac.signal }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    await req;
    await new Promise((r) => setTimeout(r, 350));

    expect(aborted(), 'an abandoned read went on costing OAP work').toBe(true);
  });

  it('does NOT fire when the reply completed normally', async () => {
    const { url, aborted } = await serve();

    const res = await fetch(`${url}/fast`);
    await res.json();
    await new Promise((r) => setTimeout(r, 100));

    expect(aborted(), 'a successful reply cancelled its own work').toBe(false);
  });

  it('does not fire on a POST whose body the route consumed', async () => {
    const { url, aborted } = await serve();

    const res = await fetch(`${url}/body`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topN: 20 }),
    });
    await res.json();

    // Reading the body ENDS the request stream, and Node destroys a readable it
    // has ended. Asking the request whether it was destroyed therefore answered
    // "yes" in every handler, and every read cancelled itself before issuing a
    // single query — while the reply still went out as a well-formed 200 saying
    // OAP could not be reached.
    expect(aborted(), 'a live POST was cancelled before it started').toBe(false);
  });

  it('does not fire on a slow reply the caller waited for', async () => {
    const { url, aborted } = await serve();

    const res = await fetch(`${url}/slow`);
    await res.json();
    await new Promise((r) => setTimeout(r, 100));

    expect(aborted()).toBe(false);
  });
});
