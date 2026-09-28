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
 * An expression with no source service reads the metric across every service
 * — `top_n` filters by `serviceName` alone, whatever the `dest*` side says —
 * so it is raw metric access and needs `inspect:read`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { registerMqeExecRoute } from './mqe-exec.js';

const oap: FetchLike = async (_url, init) => {
  const q = String(JSON.parse(String(init?.body ?? '{}')).query ?? '');
  const data = q.includes('getTimeInfo')
    ? { result: { timezone: '+0000', currentTimestamp: Date.now() } }
    : { execExpression: { type: 'SINGLE_VALUE', error: null, results: [] } };
  return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
};

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function exec(role: 'reader' | 'inspector', entity: Record<string, unknown>): Promise<number> {
  const cfg = configSchema.parse({ rbac: { roles: { reader: ['metrics:read'], inspector: ['metrics:read', 'inspect:read'] } } });
  const config: ConfigSource = { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
  const sessions = new SessionStore({ ttlMinutes: 60 });
  app = Fastify();
  await app.register(cookie);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
  registerMqeExecRoute(app, { config, sessions, fetch: oap });
  await app.ready();
  const res = await app.inject({
    method: 'POST',
    url: '/api/mqe/exec',
    headers: { cookie: `horizon_sid=${sessions.create(role, [role]).sid}` },
    payload: { expression: 'top_n(service_cpm,10,DES)', entity, step: 'MINUTE', startMs: 1_700_000_000_000, endMs: 1_700_000_600_000 },
  });
  return res.statusCode;
}

describe('an MQE with no source service', () => {
  it('needs inspect:read, whatever the destination names', async () => {
    expect(await exec('reader', { destServiceName: 'payments::checkout', destNormal: true })).toBe(403);
    expect(await exec('reader', {})).toBe(403);
    expect(await exec('inspector', { destServiceName: 'payments::checkout', destNormal: true })).toBe(200);
  });

  it('runs for metrics:read once the source service is named', async () => {
    expect(await exec('reader', { serviceName: 'payments::checkout', normal: true })).toBe(200);
  });
});
