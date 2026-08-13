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

import { test, expect, request } from '@playwright/test';
import { PROVIDER_SERVICE, LAYER, WINDOW_MINUTES } from '../fixture.js';

// The ONLY wire assertions in the suite. Per CLAUDE.md §3.2 each one has to
// answer "what would this catch that a UI assertion would not?", and the
// answer is written above it. Everything a browser can reach is asserted in
// the browser, where a pass proves the whole chain rather than one link.
//
// Two admissible shapes, and nothing else:
//   - a malformed request the client never sends, where the point is that the
//     BFF REFUSES rather than answering emptily
//   - an outcome that is invisible on screen

test.describe('refusals the client never triggers', () => {
  // The UI builds layer keys from the menu, so it cannot send a bad one. A
  // 200 with an empty roster would read as "this layer has no services".
  test('an unknown layer key is rejected, not answered emptily', async ({ request: api }) => {
    const res = await api.get('/api/layer/not@a@layer/services');
    expect(res.status()).toBe(400);
  });

  // Identity is an {id, name} pair. The UI always sends both; a caller that
  // sends half must be refused, because an empty list reads as "no logs" and
  // sends an operator hunting the wrong bug.
  test('a log query without the service id is refused', async ({ request: api }) => {
    const res = await api.post(`/api/layer/${LAYER}/logs`, {
      data: { service: PROVIDER_SERVICE, windowMinutes: WINDOW_MINUTES, pageSize: 5 },
    });
    const body = await res.json();
    expect(body.reachable).toBe(false);
    expect(body.error).toContain('serviceId');
  });

  // Same rule one tier down, and a different error: entity routes want the
  // name and `normal` alongside the id.
  test('an entity query with half an identity is refused', async ({ request: api }) => {
    const roster = await (await api.get(`/api/layer/${LAYER}/services`)).json();
    const svc = roster.services[0];
    const res = await api.get(
      `/api/layer/${LAYER}/endpoint-dependency?serviceId=${encodeURIComponent(svc.id)}`,
    );
    expect((await res.json()).error).toBe('incomplete_service');
  });

  // DSL catalogs are a closed set. Absent and unknown are DIFFERENT errors,
  // and collapsing either into an empty result would hide a typo in a URL.
  test('rule status distinguishes an absent catalog from an unknown one', async ({
    request: api,
  }) => {
    const missing = await api.get('/api/rule/status');
    expect(missing.status()).toBe(400);
    expect((await missing.json()).error).toBe('missing_catalog');

    const invalid = await api.get('/api/rule/status?catalog=not-a-catalog');
    expect(invalid.status()).toBe(400);
    expect((await invalid.json()).error).toBe('invalid_catalog');
  });
});

test.describe('outcomes invisible on screen', () => {
  // The browser shows a redirect to /login, which proves the ROUTER guard
  // fired — not that the API itself enforces auth. A build whose guard worked
  // and whose routes were open would look identical in a browser.
  test('query routes reject an unauthenticated caller', async ({ baseURL }) => {
    // storageState must be cleared explicitly: request.newContext() inherits
    // it from the project, so a bare context is still signed in.
    const anon = await request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    for (const path of ['/api/menu', '/api/oap/info', `/api/layer/${LAYER}/services`]) {
      expect((await anon.get(path)).status(), `${path} must require auth`).toBe(401);
    }
    await anon.dispose();
  });

  // http-only is unobservable from the page BY DEFINITION — script cannot
  // read the cookie, which is the entire point of the flag.
  test('sign-in issues an http-only session cookie', async ({ baseURL }) => {
    const anon = await request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    const res = await anon.post('/api/auth/login', {
      data: { username: process.env.HORIZON_E2E_USER ?? 'e2e', password: process.env.HORIZON_E2E_PASSWORD ?? 'e2e-passw0rd' },
    });
    expect(res.status()).toBe(200);
    const cookie = (await anon.storageState()).cookies.find((c) => c.name === 'horizon_sid');
    expect(cookie, 'login must set horizon_sid').toBeDefined();
    expect(cookie?.httpOnly, 'the session cookie must be http-only').toBe(true);
    await anon.dispose();
  });
});
