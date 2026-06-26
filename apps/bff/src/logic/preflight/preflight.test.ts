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

import { describe, it, expect, beforeEach } from 'vitest';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import type { HorizonConfig } from '../../config/schema.js';
import { runPreflight, getPreflight, invalidatePreflightCache } from './preflight.js';

const DUMP = '/debugging/config/dump';
// The config dump advertises every module prefix (the "selector detected"
// footnote) — so reachability, not config-presence, is what the test drives.
const DUMP_BODY: Record<string, string> = {
  'admin-server.provider': 'default',
  'receiver-runtime-rule.provider': 'default',
  'dsl-debugging.provider': 'default',
  'inspect.provider': 'default',
  'ui-management.provider': 'default',
};

function res(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
  } as unknown as Response;
}

/** A fetch that answers the dump 200 and each probe path by a status map;
 *  a path mapped to `'throw'` simulates a network error. Records every URL. */
function fetchWith(statusByPath: Record<string, number | 'throw'>, calls: string[] = []): FetchLike {
  return ((url: string) => {
    calls.push(url);
    if (url.endsWith(DUMP)) return Promise.resolve(res(200, DUMP_BODY));
    for (const [path, st] of Object.entries(statusByPath)) {
      if (url.endsWith(path)) {
        if (st === 'throw') return Promise.reject(new Error('ECONNREFUSED'));
        return Promise.resolve(res(st));
      }
    }
    return Promise.resolve(res(404));
  }) as unknown as FetchLike;
}

function cfg(mode: 'live' | 'readonly' = 'live'): HorizonConfig {
  return {
    oap: { adminUrl: 'http://oap:17128', timeoutMs: 0, queryUrl: '', zipkinUrl: '' },
    templates: { mode },
  } as unknown as HorizonConfig;
}

const ALL_OK = {
  '/ui-management/templates': 200,
  '/runtime/rule/list': 200,
  '/dsl-debugging/status': 200,
  '/inspect/metrics': 200,
} as const;

const byName = (r: Awaited<ReturnType<typeof runPreflight>>, name: string) =>
  r.modules.find((m) => m.name === name)!;

describe('runPreflight — reachability via path probes', () => {
  beforeEach(() => invalidatePreflightCache());

  it('probes every feature path; reachable comes from the real GET', async () => {
    const r = await runPreflight(cfg('live'), fetchWith(ALL_OK));
    expect(r.adminReachable).toBe(true);
    expect(r.templatesMode).toBe('live');
    // admin-server's probe IS the dump fetch — reachable without a 2nd call.
    expect(byName(r, 'admin-server').reachable).toBe(true);
    for (const n of ['receiver-runtime-rule', 'dsl-debugging', 'inspect', 'ui-management']) {
      expect(byName(r, n).reachable).toBe(true);
    }
    // config-presence is a footnote, present here for every module.
    expect(r.modules.every((m) => m.enabled)).toBe(true);
  });

  it('a 404 / 5xx / network error on a path reads as unreachable', async () => {
    const r = await runPreflight(
      cfg('live'),
      fetchWith({ ...ALL_OK, '/inspect/metrics': 404, '/runtime/rule/list': 500, '/dsl-debugging/status': 'throw' }),
    );
    expect(byName(r, 'inspect').reachable).toBe(false); // 404 = route not registered
    expect(byName(r, 'receiver-runtime-rule').reachable).toBe(false); // 5xx
    expect(byName(r, 'dsl-debugging').reachable).toBe(false); // network error
    expect(byName(r, 'ui-management').reachable).toBe(true);
    // enabled stays true (the dump still advertises them) — proving reachable,
    // not config-presence, drives health.
    expect(byName(r, 'inspect').enabled).toBe(true);
  });

  it('a 4xx that is not 404 still counts as reachable (route exists)', async () => {
    const r = await runPreflight(cfg('live'), fetchWith({ ...ALL_OK, '/runtime/rule/list': 400 }));
    expect(byName(r, 'receiver-runtime-rule').reachable).toBe(true);
  });

  it('readonly mode does not probe ui_template — reachable is null', async () => {
    const calls: string[] = [];
    const r = await runPreflight(cfg('readonly'), fetchWith(ALL_OK, calls));
    expect(byName(r, 'ui-management').reachable).toBeNull();
    expect(calls.some((u) => u.endsWith('/ui-management/templates'))).toBe(false);
    expect(byName(r, 'inspect').reachable).toBe(true); // others still probed
  });

  it('admin port down — every feature unreachable, no path probes', async () => {
    const calls: string[] = [];
    const downFetch = ((url: string) => {
      calls.push(url);
      return Promise.reject(new Error('ECONNREFUSED'));
    }) as unknown as FetchLike;
    const r = await runPreflight(cfg('live'), downFetch);
    expect(r.adminReachable).toBe(false);
    expect(r.modules.every((m) => m.reachable === false)).toBe(true);
    expect(calls.every((u) => u.endsWith(DUMP))).toBe(true); // only the dump was tried
  });
});

describe('getPreflight — single-flight cache', () => {
  beforeEach(() => invalidatePreflightCache());

  it('serves a cached round to concurrent / repeat reads, force bypasses it', async () => {
    const calls: string[] = [];
    const f = fetchWith(ALL_OK, calls);
    await getPreflight(cfg('live'), f);
    const dumpCalls1 = calls.filter((u) => u.endsWith(DUMP)).length;
    await getPreflight(cfg('live'), f); // cached → no new probes
    expect(calls.filter((u) => u.endsWith(DUMP)).length).toBe(dumpCalls1);
    await getPreflight(cfg('live'), f, { force: true }); // bypass → fresh round
    expect(calls.filter((u) => u.endsWith(DUMP)).length).toBe(dumpCalls1 + 1);
  });
});
