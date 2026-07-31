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
import { StatusClient } from './status.js';
import type { FetchLike } from './runtime-rule.js';

const respond = (body: unknown, status = 200): FetchLike =>
  async function stubFetch(): Promise<Response> {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };

describe('StatusClient.clusterNodes — cluster member normalisation', () => {
  it('accepts either wire spelling of the self flag', async () => {
    // Gson emits the Java `isSelf` field under either name depending on the
    // build; the per-node fan-out uses the flag to tell local from peer.
    const client = new StatusClient({
      queryUrl: 'http://oap:12800',
      fetch: respond({
        nodes: [
          { host: '10.0.0.1', port: 11800, self: true },
          { host: '10.0.0.2', port: 11800, isSelf: true },
          { host: '10.0.0.3', port: 11800 },
        ],
      }),
    });
    expect(await client.clusterNodes()).toEqual([
      { host: '10.0.0.1', port: 11800, self: true },
      { host: '10.0.0.2', port: 11800, self: true },
      { host: '10.0.0.3', port: 11800, self: false },
    ]);
  });

  it('keeps an explicit self:false rather than letting isSelf override it', async () => {
    const client = new StatusClient({
      queryUrl: 'http://oap:12800',
      fetch: respond({ nodes: [{ host: '10.0.0.1', port: 11800, self: false, isSelf: true }] }),
    });
    expect((await client.clusterNodes())[0].self).toBe(false);
  });

  it('returns an empty list when the payload carries no nodes array', async () => {
    const client = new StatusClient({ queryUrl: 'http://oap:12800', fetch: respond({}) });
    expect(await client.clusterNodes()).toEqual([]);
  });

  it('targets /status/cluster/nodes on the query host, trailing slash stripped', async () => {
    let seen = '';
    const client = new StatusClient({
      queryUrl: 'http://oap:12800/',
      fetch: async (input) => {
        seen = String(input);
        return new Response('{"nodes":[]}');
      },
    });
    await client.clusterNodes();
    expect(seen).toBe('http://oap:12800/status/cluster/nodes');
  });

  it('throws with the status and body when the status plugin is not reachable', async () => {
    const client = new StatusClient({
      queryUrl: 'http://oap:12800',
      fetch: async () => new Response('no status plugin', { status: 404 }),
    });
    await expect(client.clusterNodes()).rejects.toThrow(/404.*no status plugin/s);
  });
});
