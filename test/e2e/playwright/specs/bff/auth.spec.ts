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
import { E2E_USER, E2E_PASSWORD } from '../fixture.js';

test('health is reachable without a session', async ({ request: api }) => {
  expect((await api.get('/api/health')).status()).toBe(200);
});

test('query routes reject an unauthenticated caller', async ({ baseURL }) => {
  // storageState must be cleared EXPLICITLY: request.newContext() inherits it
  // from the project's `use`, so a bare newContext() is still signed in and
  // this test would pass against a Horizon with no auth at all.
  const anon = await request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  for (const path of ['/api/menu', '/api/oap/info', '/api/layer/general/services']) {
    expect((await anon.get(path)).status(), `${path} must require auth`).toBe(401);
  }
  await anon.dispose();
});

test('sign-in issues an http-only session cookie', async ({ baseURL }) => {
  const anon = await request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const res = await anon.post('/api/auth/login', {
    data: { username: E2E_USER, password: E2E_PASSWORD },
  });
  expect(res.status()).toBe(200);

  const cookie = (await anon.storageState()).cookies.find((c) => c.name === 'horizon_sid');
  expect(cookie, 'login must set horizon_sid').toBeDefined();
  expect(cookie?.httpOnly, 'session cookie must be http-only').toBe(true);
  await anon.dispose();
});

test('bad credentials are refused', async ({ baseURL }) => {
  const anon = await request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const res = await anon.post('/api/auth/login', {
    data: { username: E2E_USER, password: 'not-the-password' },
  });
  expect(res.status()).toBeGreaterThanOrEqual(400);
  await anon.dispose();
});

test('the session identifies the fixture account and its role', async ({ request: api }) => {
  const me = await (await api.get('/api/auth/me')).json();
  expect(me.username).toBe(E2E_USER);
  expect(me.roles).toContain('admin');
});
