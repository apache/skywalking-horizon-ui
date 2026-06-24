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
 * Inspect routes — the absent-endpoint discrimination that the foreign-metric
 * feature hinges on. `POST /inspect/values` is newer than the base inspect
 * module, so a 404 there must NOT be reported as "inspect is disabled" (the
 * generic SW_INSPECT advice would misdirect an operator whose OAP simply
 * predates the foreign-values endpoint). A 404 on the older catalog/entities
 * routes still maps to `inspect_not_enabled`.
 */

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { AuditLogger } from '../../audit/logger.js';
import { registerInspectRoutes } from './inspect.js';

function fakeConfig(): ConfigSource {
  const cfg = configSchema.parse({});
  return { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
}

/** A fetch that 404s every upstream call — i.e. OAP does not bind the path. */
const notFoundFetch: FetchLike = async () => new Response('Not Found', { status: 404 });

async function buildApp(fetchImpl: FetchLike): Promise<{ app: FastifyInstance; sessions: SessionStore }> {
  const config = fakeConfig();
  const sessions = new SessionStore({ ttlMinutes: 60 });
  // audit is a typed dep the inspect routes never touch; the constructor is inert.
  const audit = new AuditLogger('/tmp/horizon-inspect-test-audit.log');
  const app = Fastify();
  await app.register(cookie);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
  registerInspectRoutes(app, { config, sessions, audit, fetch: fetchImpl });
  await app.ready();
  return { app, sessions };
}

const DAY = '2026-06-24';

describe('inspect routes — absent-endpoint error mapping', () => {
  it('maps a 404 on POST /inspect/values to inspect_values_unsupported, not inspect_not_enabled', async () => {
    const { app, sessions } = await buildApp(notFoundFetch);
    const sid = sessions.create('op', ['operator']).sid;
    const res = await app.inject({
      method: 'POST',
      url: '/api/inspect/values',
      headers: { cookie: `horizon_sid=${sid}`, 'content-type': 'application/json' },
      payload: {
        expression: 'meter_x',
        entity: { scope: 'Service', serviceName: 'svc', normal: true },
        start: DAY,
        end: DAY,
        step: 'DAY',
        foreignMetrics: [{ name: 'meter_x', valueColumn: 'value', valueType: 'LONG' }],
      },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe('inspect_values_unsupported');
    expect(body.message).toMatch(/inspect\/values/);
    expect(body.message).not.toMatch(/^OAP did not bind the inspect routes/);
    await app.close();
  });

  it('still maps a 404 on GET /inspect/entities to inspect_not_enabled', async () => {
    const { app, sessions } = await buildApp(notFoundFetch);
    const sid = sessions.create('op', ['operator']).sid;
    const res = await app.inject({
      method: 'GET',
      url: `/api/inspect/entities?metric=meter_x&start=${DAY}&end=${DAY}&step=DAY`,
      headers: { cookie: `horizon_sid=${sid}` },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('inspect_not_enabled');
    await app.close();
  });

  it('rejects a foreign values request missing foreignMetrics with a 400 before hitting OAP', async () => {
    const { app, sessions } = await buildApp(notFoundFetch);
    const sid = sessions.create('op', ['operator']).sid;
    const res = await app.inject({
      method: 'POST',
      url: '/api/inspect/values',
      headers: { cookie: `horizon_sid=${sid}`, 'content-type': 'application/json' },
      payload: {
        expression: 'meter_x',
        entity: { scope: 'Service', serviceName: 'svc' },
        start: DAY,
        end: DAY,
        step: 'DAY',
        foreignMetrics: [],
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('missing_foreign_metrics');
    await app.close();
  });

  it('rejects a SQL-meaningful valueColumn at the BFF edge (mirrors OAP), before hitting OAP', async () => {
    const { app, sessions } = await buildApp(notFoundFetch);
    const sid = sessions.create('op', ['operator']).sid;
    const res = await app.inject({
      method: 'POST',
      url: '/api/inspect/values',
      headers: { cookie: `horizon_sid=${sid}`, 'content-type': 'application/json' },
      payload: {
        expression: 'meter_x',
        entity: { scope: 'Service', serviceName: 'svc' },
        start: DAY,
        end: DAY,
        step: 'DAY',
        foreignMetrics: [{ name: 'meter_x', valueColumn: 'value; DROP', valueType: 'LONG' }],
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; detail: string };
    expect(body.error).toBe('invalid_foreign_metric');
    expect(body.detail).toMatch(/valueColumn is invalid/);
    await app.close();
  });

  it('rejects a SQL-meaningful valueColumn on GET /inspect/entities (foreign enumerate) at the edge', async () => {
    const { app, sessions } = await buildApp(notFoundFetch);
    const sid = sessions.create('op', ['operator']).sid;
    const res = await app.inject({
      method: 'GET',
      url: `/api/inspect/entities?metric=meter_x&valueColumn=${encodeURIComponent('value; DROP')}&valueType=LONG&start=${DAY}&end=${DAY}&step=DAY`,
      headers: { cookie: `horizon_sid=${sid}` },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('invalid_value_column');
    await app.close();
  });

  it('requires inspect:read — a viewer is allowed (read verb), an unauthenticated caller is 401', async () => {
    const { app, sessions } = await buildApp(notFoundFetch);
    const anon = await app.inject({ method: 'POST', url: '/api/inspect/values', payload: {} });
    expect(anon.statusCode).toBe(401);
    // viewer holds inspect:read, so it passes the gate and reaches validation (400 on empty body).
    const sid = sessions.create('v', ['viewer']).sid;
    const viewer = await app.inject({
      method: 'POST',
      url: '/api/inspect/values',
      headers: { cookie: `horizon_sid=${sid}`, 'content-type': 'application/json' },
      payload: {},
    });
    expect(viewer.statusCode).toBe(400);
    await app.close();
  });
});
