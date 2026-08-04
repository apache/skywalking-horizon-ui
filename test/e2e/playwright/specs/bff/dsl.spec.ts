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

import { test, expect } from '@playwright/test';

// DSL management and the live debugger, which talk to OAP's ADMIN host rather
// than the query port. The core fixture already exposes it and both OAP
// modules (receiver-runtime-rule, dsl-debugging) are on by default, so this
// needs no fixture of its own.
//
// Read-only throughout. Pushing a rule would mutate the OAP the other cases
// are asserting against, and a hot-update that half-applied would surface as
// an unrelated failure somewhere else in the run.

test('the OAL catalog lists the shipped rule files', async ({ request: api }) => {
  const body = await (await api.get('/api/oal/files')).json();
  expect(body.count).toBeGreaterThan(0);
  expect(body.files).toContain('oal/core.oal');
  expect(body.files.length).toBe(body.count);
});

test('OAL sources carry the metrics the dashboards read', async ({ request: api }) => {
  const body = await (await api.get('/api/oal/rules')).json();
  const service = body.sources.find((s: { source: string }) => s.source === 'Service');
  expect(service, 'the Service scope must be in the OAL catalog').toBeDefined();
  // service_cpm is what the layer dashboard's traffic widgets read, and what
  // the metrics readiness gate queries — the two should agree about it
  // existing.
  expect(service.metrics).toContain('service_cpm');
});

test("the LAL catalog shows the fixture's own rule", async ({ request: api }) => {
  const rules = await (await api.get('/api/catalog/bundled?catalog=lal')).json();
  const ours = rules.find((r: { name: string }) => r.name === 'horizon-e2e');
  // Ties the DSL surface to the fixture: this is the very rule mounted into
  // OAP by base-compose, so seeing it here proves the admin host is reading
  // the same configuration the log pipeline is running.
  expect(ours, 'the mounted LAL rule must be visible through DSL management').toBeDefined();
  expect(ours.kind).toBe('bundled');
  expect(ours.content).toContain('filter');
});

test('the rule loader reports as running', async ({ request: api }) => {
  const body = await (await api.get('/api/catalog/list?catalog=otel-rules')).json();
  // An `active` of zero means the runtime-rule module never came up, which
  // would leave every DSL screen looking merely empty rather than broken.
  expect(body.loaderStats.active).toBeGreaterThan(0);
  expect(body.loaderStats.pending).toBe(0);
});

test('rule status refuses an absent or unknown catalog', async ({ request: api }) => {
  // Both are 400s with distinct codes. Answering either with an empty result
  // would read as "this catalog has no rules" and hide a typo in a URL.
  const missing = await api.get('/api/rule/status');
  expect(missing.status()).toBe(400);
  expect((await missing.json()).error).toBe('missing_catalog');

  const invalid = await api.get('/api/rule/status?catalog=not-a-catalog');
  expect(invalid.status()).toBe(400);
  expect((await invalid.json()).error).toBe('invalid_catalog');
});

test('the live debugger reports its session list', async ({ request: api }) => {
  const body = await (await api.get('/api/debug/sessions')).json();
  expect(Array.isArray(body.sessions)).toBe(true);
  expect(body.count).toBe(body.sessions.length);
});
