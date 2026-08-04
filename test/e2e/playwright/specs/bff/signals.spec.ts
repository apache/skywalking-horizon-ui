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

import { test, expect, type APIRequestContext } from '@playwright/test';
import { PROVIDER_SERVICE, CONSUMER_SERVICE, LAYER, WINDOW_MINUTES } from '../fixture.js';

// The signals beyond trace + metric that the same fixture already produces:
// topology, logs and events. They live together because they share the demo
// app — none of them needs a stack of its own.

/** OAP identity is an {id, name} PAIR; routes reject a name on its own. */
async function serviceIdentity(api: APIRequestContext, name: string) {
  const roster = await (await api.get(`/api/layer/${LAYER}/services`)).json();
  const svc = roster.services.find((s: { name: string }) => s.name === name);
  expect(svc, `${name} must be in the roster`).toBeDefined();
  return { serviceId: svc.id as string, service: svc.name as string };
}

test('the topology graph carries the demo call chain', async ({ request: api }) => {
  const res = await api.get(`/api/layer/${LAYER}/topology?windowMinutes=${WINDOW_MINUTES}`);
  expect(res.status()).toBe(200);
  const body = await res.json();

  expect(body.reachable).toBe(true);
  const names = body.nodes.map((n: { name: string }) => n.name);
  expect(names).toContain(PROVIDER_SERVICE);
  expect(names).toContain(CONSUMER_SERVICE);

  // The edge is the point: nodes alone would appear even if the two services
  // never talked to each other, which is precisely the bug a topology screen
  // exists to show.
  expect(body.calls.length, 'the consumer -> provider call must be an edge').toBeGreaterThan(0);
});

test('logs from the demo app are queryable for a service', async ({ request: api }) => {
  const identity = await serviceIdentity(api, PROVIDER_SERVICE);

  const res = await api.post(`/api/layer/${LAYER}/logs`, {
    data: { ...identity, windowMinutes: WINDOW_MINUTES, pageSize: 10 },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();

  expect(body.reachable, body.error ?? 'log query must reach OAP').toBe(true);
  // A LAL rule that drops everything leaves this empty while traces and
  // metrics stay perfect — the failure this assertion exists for.
  expect(body.logs.length, 'the demo app must have produced logs').toBeGreaterThan(0);
  expect(body.logs[0].serviceName).toBe(PROVIDER_SERVICE);
  expect(body.logs[0].content, 'a log line must carry its content').toBeTruthy();
});

test('a log query without the service id is refused, not silently empty', async ({
  request: api,
}) => {
  // Identity is an {id, name} pair. Answering a half-identity with an empty
  // list would read as "no logs" and send an operator hunting the wrong bug.
  const res = await api.post(`/api/layer/${LAYER}/logs`, {
    data: { service: PROVIDER_SERVICE, windowMinutes: WINDOW_MINUTES, pageSize: 5 },
  });
  const body = await res.json();
  expect(body.reachable).toBe(false);
  expect(body.error).toContain('serviceId');
});

test('the agent reports lifecycle events', async ({ request: api }) => {
  const res = await api.post('/api/events', {
    data: { windowMinutes: 60, pageSize: 20 },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();

  expect(body.events.length, 'the Java agent must report a Start event').toBeGreaterThan(0);
  const services = body.events.map((e: { source: { service: string } }) => e.source.service);
  expect(services.some((s: string) => s === PROVIDER_SERVICE || s === CONSUMER_SERVICE)).toBe(true);
});
