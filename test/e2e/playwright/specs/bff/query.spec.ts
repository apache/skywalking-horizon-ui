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
import {
  PROVIDER_SERVICE,
  CONSUMER_SERVICE,
  DEMO_ENDPOINTS,
  LAYER,
  WINDOW_MINUTES,
} from '../fixture.js';

test('OAP is reachable and reports the storage the fixture runs on', async ({ request: api }) => {
  const info = await (await api.get('/api/oap/info')).json();
  expect(info.reachable).toBe(true);
  expect(info.backend).toBe('banyandb');
  expect(info.version, 'version must come from the live OAP').toBeTruthy();
  // The BFF converts every query window into OAP-server-local time off this
  // field. A missing offset silently shifts every query by the host's zone.
  expect(info.timezone).toMatch(/^[+-]\d{4}$/);
});

test('the menu exposes the layer the demo app reports into', async ({ request: api }) => {
  const menu = await (await api.get('/api/menu')).json();
  const general = menu.layers.find((l: { key: string }) => l.key === LAYER);
  expect(general, `menu must carry the ${LAYER} layer`).toBeDefined();
  // Capabilities drive which tabs the layer shell renders; traces being
  // false here would blank the traces tab with no error anywhere.
  expect(general.caps.traces).toBe(true);
});

test('the service roster carries both demo services', async ({ request: api }) => {
  const res = await api.get(`/api/layer/${LAYER}/services`);
  expect(res.status()).toBe(200);
  const body = await res.json();

  expect(body.reachable).toBe(true);
  expect(body.layer).toBe(LAYER.toUpperCase());

  const names = body.services.map((s: { name: string }) => s.name);
  expect(names).toContain(PROVIDER_SERVICE);
  expect(names).toContain(CONSUMER_SERVICE);

  // Identity is carried as an {id, name} pair; an empty id means downstream
  // per-service queries silently address nothing.
  for (const svc of body.services) {
    expect(svc.id, `${svc.name} must carry an OAP id`).toBeTruthy();
  }
});

test('an unknown layer key is rejected, not answered with an empty roster', async ({
  request: api,
}) => {
  const res = await api.get('/api/layer/not@a@layer/services');
  expect(res.status()).toBe(400);
});

test('traces from the demo app come back with spans', async ({ request: api }) => {
  const res = await api.post(`/api/layer/${LAYER}/traces`, {
    data: { windowMinutes: WINDOW_MINUTES, pageSize: 10 },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();

  const traces = body.native?.traces ?? [];
  expect(traces.length, 'the demo traffic must produce traces').toBeGreaterThan(0);

  const first = traces[0];
  expect(first.traceIds?.length).toBeGreaterThan(0);
  expect(first.endpointNames?.length).toBeGreaterThan(0);

  // Every trace must belong to the demo app. Asserting provenance rather than
  // one specific endpoint on purpose: the fixture drives BOTH /users
  // (continuously, for topology) and /logs/trigger (a burst, for logs), so
  // which endpoint owns the newest page depends on traffic mix — an
  // `includes('/users')` here passes or fails on timing, not on correctness.
  const endpoints = traces.flatMap((t: { endpointNames: string[] }) => t.endpointNames);
  expect(endpoints.length).toBeGreaterThan(0);
  expect(
    endpoints.every((e: string) => DEMO_ENDPOINTS.some((known) => e.includes(known))),
    `unexpected endpoints in the trace list: ${endpoints.join(', ')}`,
  ).toBe(true);
});

test('a trace can be fetched by id and spans name the demo services', async ({ request: api }) => {
  const list = await (
    await api.post(`/api/layer/${LAYER}/traces`, {
      data: { windowMinutes: WINDOW_MINUTES, pageSize: 1 },
    })
  ).json();
  const traceId = list.native.traces[0].traceIds[0];

  const detail = await api.get(`/api/trace/${encodeURIComponent(traceId)}`);
  expect(detail.status()).toBe(200);

  // Spans hang off the per-source envelope, not the root — the response
  // carries `native` and `zipkin` side by side.
  const spans = (await detail.json()).native?.spans ?? [];
  expect(spans.length).toBeGreaterThan(0);
  // Same reason as the endpoint set above: a /logs/trigger trace is
  // provider-only, so requiring the consumer here would fail whenever the
  // newest trace came from the log burst rather than the topology call.
  const services = spans.map((s: { serviceCode: string }) => s.serviceCode);
  expect(
    services.every((s: string) => s === PROVIDER_SERVICE || s === CONSUMER_SERVICE),
    `unexpected services in the trace: ${services.join(', ')}`,
  ).toBe(true);
});
