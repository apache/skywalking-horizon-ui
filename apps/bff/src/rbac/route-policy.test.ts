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

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import {
  ROUTE_POLICY,
  checkVerb,
  makeRouteAuthHook,
  isTemplateWriteRoute,
  denyTemplateWriteWhenReadOnly,
} from './route-policy.js';
import { setTemplateReadOnly } from '../logic/templates/sync.js';
import { configSchema } from '../config/schema.js';
import type { AuthDeps } from '../user/middleware.js';

describe('isTemplateWriteRoute — which routes the readonly backstop covers', () => {
  it('matches non-GET config-template write routes', () => {
    expect(isTemplateWriteRoute('POST', '/api/admin/templates/save')).toBe(true);
    expect(isTemplateWriteRoute('POST', '/api/admin/templates/save-translation')).toBe(true);
    expect(isTemplateWriteRoute('POST', '/api/admin/templates/sync-all')).toBe(true);
    expect(isTemplateWriteRoute('POST', '/api/admin/overview-templates')).toBe(true);
    expect(isTemplateWriteRoute('DELETE', '/api/admin/overview-templates/x')).toBe(true);
  });
  it('does NOT match reads, nor non-config writes (runtime-rule / live-debug stay editable)', () => {
    expect(isTemplateWriteRoute('GET', '/api/admin/templates/sync-status')).toBe(false);
    expect(isTemplateWriteRoute('HEAD', '/api/admin/templates/sync-status')).toBe(false);
    expect(isTemplateWriteRoute('POST', '/api/rule')).toBe(false); // runtime rule
    expect(isTemplateWriteRoute('POST', '/api/debug/session')).toBe(false); // live-debug
  });
});

/**
 * `live-debug:read` / `live-debug:write` is the whole of the Live Debugger's
 * access control: watching a capture takes the read, running one takes the
 * write, and no rule verb participates. The `rule-only` role below is the
 * guard on that last clause — every rule grant there is, including the `rule:*`
 * wildcard, must neither open nor close a live-debug route.
 */
describe('the live-debug policy is read to watch, write to run', () => {
  const config = configSchema.parse({
    rbac: {
      roles: {
        watcher: ['live-debug:read'],
        debugger: ['live-debug:read', 'live-debug:write'],
        'rule-only': ['rule:*'],
      },
    },
  });

  const deps = { config: { current: config } } as unknown as AuthDeps;
  type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

  /** Runs one pre-handler as `role` and reports what it replied, if anything. */
  async function run(gate: PreHandler, role: string): Promise<{ code?: number; body?: unknown }> {
    const out: { code?: number; body?: unknown } = {};
    const reply = {
      code(c: number) {
        out.code = c;
        return { send: (b: unknown) => void (out.body = b) };
      },
    } as unknown as FastifyReply;
    await gate({ session: { roles: [role] } } as FastifyRequest, reply);
    return out;
  }

  /** Runs the route's own policy as the hook would apply it. */
  async function decide(route: string, role: string): Promise<{ code?: number; body?: unknown }> {
    const policy = ROUTE_POLICY[route];
    if (policy === undefined) throw new Error(`no ROUTE_POLICY entry for ${route}`);
    return run(checkVerb(deps, policy), role);
  }

  it('lets a read-only live-debug role read sessions and cluster status', async () => {
    for (const route of [
      'GET /api/debug/session/:id',
      'GET /api/debug/sessions',
      'GET /api/debug/status',
    ]) {
      expect(await decide(route, 'watcher'), route).toEqual({});
    }
  });

  it('refuses a start and a stop to a watcher, naming the missing verb', async () => {
    for (const route of ['POST /api/debug/session', 'POST /api/debug/session/:id/stop']) {
      expect(await decide(route, 'watcher'), route).toEqual({
        code: 403,
        body: { error: 'permission_denied', verb: 'live-debug:write' },
      });
    }
  });

  it('lets a role holding live-debug:write start and stop', async () => {
    expect(await decide('POST /api/debug/session', 'debugger')).toEqual({});
    expect(await decide('POST /api/debug/session/:id/stop', 'debugger')).toEqual({});
  });

  it('gives a holder of every rule verb no live-debug access at all', async () => {
    for (const route of [
      'GET /api/debug/session/:id',
      'GET /api/debug/sessions',
      'GET /api/debug/status',
    ]) {
      expect(await decide(route, 'rule-only'), route).toEqual({
        code: 403,
        body: { error: 'permission_denied', verb: 'live-debug:read' },
      });
    }
    for (const route of ['POST /api/debug/session', 'POST /api/debug/session/:id/stop']) {
      expect(await decide(route, 'rule-only'), route).toEqual({
        code: 403,
        body: { error: 'permission_denied', verb: 'live-debug:write' },
      });
    }
  });

  // The table only decides anything if the registration hook carries the entry
  // through to a pre-handler — a route that fell into the 'auth' branch would
  // gate nothing while the table still read strict.
  it('the registration hook attaches the verb gate to the route', async () => {
    const route = { method: 'POST', url: '/api/debug/session' } as RouteOptions;
    makeRouteAuthHook(deps)(route);
    const gates = (Array.isArray(route.preHandler) ? route.preHandler : []) as PreHandler[];
    const verbGate = gates.find((h) => h.name === 'verbOnlyPreHandler');
    expect(verbGate, 'no verb pre-handler was attached').toBeDefined();
    expect(await run(verbGate!, 'watcher')).toEqual({
      code: 403,
      body: { error: 'permission_denied', verb: 'live-debug:write' },
    });
  });

  // No route needs a conjunction today. The form stays for the next route that
  // genuinely takes two grants, so it is exercised directly rather than through
  // the table: every listed verb is required, and the FIRST one missing is the
  // one reported — a policy that stopped at the last would name the wrong verb.
  it('a multi-verb policy requires all of them and reports the first missing', async () => {
    expect(await run(checkVerb(deps, ['live-debug:read', 'live-debug:write']), 'watcher')).toEqual({
      code: 403,
      body: { error: 'permission_denied', verb: 'live-debug:write' },
    });
    expect(await run(checkVerb(deps, ['live-debug:read', 'live-debug:write']), 'debugger')).toEqual(
      {},
    );
  });
});

describe('denyTemplateWriteWhenReadOnly — the BFF backstop', () => {
  afterEach(() => setTemplateReadOnly(false));

  const fakeReply = (): { reply: FastifyReply; code: ReturnType<typeof vi.fn> } => {
    const send = vi.fn();
    const code = vi.fn(() => ({ send }));
    return { reply: { code } as unknown as FastifyReply, code };
  };

  it('rejects with 409 in readonly mode', async () => {
    setTemplateReadOnly(true);
    const { reply, code } = fakeReply();
    await denyTemplateWriteWhenReadOnly({} as FastifyRequest, reply);
    expect(code).toHaveBeenCalledWith(409);
  });

  it('is a no-op in live mode (lets the write proceed)', async () => {
    setTemplateReadOnly(false);
    const { reply, code } = fakeReply();
    await denyTemplateWriteWhenReadOnly({} as FastifyRequest, reply);
    expect(code).not.toHaveBeenCalled();
  });
});
