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

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { toFastifyTrustProxy } from './trust-proxy.js';

/** What Fastify reports for one request from the peer `10.0.0.9`. */
async function seen(
  trustProxy: boolean | number | string,
  headers: Record<string, string>,
): Promise<{ ip: string; protocol: string }> {
  const app = Fastify({ trustProxy: toFastifyTrustProxy(trustProxy) });
  app.get('/', async (req) => ({ ip: req.ip, protocol: req.protocol }));
  try {
    const res = await app.inject({ method: 'GET', url: '/', headers, remoteAddress: '10.0.0.9' });
    return res.json();
  } finally {
    await app.close();
  }
}

const XFF = { 'x-forwarded-for': '198.51.100.1, 203.0.113.7', 'x-forwarded-proto': 'https' };

describe('toFastifyTrustProxy', () => {
  /** Fastify ≥ 5.12.1 ignores a bare number; these are the answers Fastify
   *  5.11 gave for `trustProxy: 1` and `2`, which the config has always meant. */
  it('keeps a hop count counting from the right of X-Forwarded-For', async () => {
    expect(await seen(1, XFF)).toEqual({ ip: '203.0.113.7', protocol: 'https' });
    expect(await seen(2, XFF)).toEqual({ ip: '198.51.100.1', protocol: 'https' });
  });

  it('passes an address list through', async () => {
    expect(await seen('10.0.0.0/8', XFF)).toEqual({ ip: '203.0.113.7', protocol: 'https' });
    expect(await seen('192.0.2.1', XFF)).toEqual({ ip: '10.0.0.9', protocol: 'http' });
  });

  it('records the direct peer when trust is off', async () => {
    expect(await seen(false, XFF)).toEqual({ ip: '10.0.0.9', protocol: 'http' });
  });
});
