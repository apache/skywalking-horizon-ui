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

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FlowStore, type Flow } from './flows.js';

const flow = (over: Partial<Flow> = {}): Flow => ({
  provider: 'google',
  state: 'st',
  nonce: 'no',
  verifier: 've',
  next: '/',
  ...over,
});

describe('an in-flight sign-in is held here, not in the browser', () => {
  it('returns the attempt for its handle', () => {
    const s = new FlowStore(60_000);
    const id = s.put(flow({ next: '/alarms' }));
    expect(s.take(id)?.next).toBe('/alarms');
  });

  /**
   * The attack this store exists to make unreachable. `httpOnly` stops a script
   * READING a cookie and does nothing to stop one being WRITTEN — a sibling
   * subdomain can set a cookie on the parent domain that this host then sends.
   * While the attempt lived in the cookie, a forged one supplied the attacker's
   * own `state` (so the callback's comparison passed), their code (so the
   * session created in the victim's browser was the attacker's account) and
   * their `next` (an open redirect, since it never went through /start).
   *
   * A handle nobody issued now resolves to nothing, so there is no forged
   * attempt to act on and the sign-in is refused.
   */
  it.each([
    ['a handle nobody issued', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['an empty handle', ''],
    ['a forged JSON attempt, the old cookie format', JSON.stringify(flow({ next: 'https://evil.example' }))],
  ])('refuses %s', (_label, id) => {
    const s = new FlowStore(60_000);
    s.put(flow());
    expect(s.take(id)).toBeNull();
  });

  it('is single use, so a replayed callback has nothing to act on', () => {
    const s = new FlowStore(60_000);
    const id = s.put(flow());
    expect(s.take(id)).not.toBeNull();
    expect(s.take(id)).toBeNull();
  });

  it('refuses an attempt older than its window', () => {
    const s = new FlowStore(-1);
    expect(s.take(s.put(flow()))).toBeNull();
  });

  it('does not accumulate abandoned attempts', () => {
    const s = new FlowStore(-1);
    for (let i = 0; i < 50; i++) s.put(flow());
    // The sweep runs on write, so the last put leaves only its own entry.
    expect(s.size).toBe(1);
  });
});

describe('the route keeps nothing forgeable in the cookie', () => {
  const src = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');

  it('stores a handle, never the attempt', () => {
    expect(src, 'the cookie value must come from the store').toContain('FLOW_COOKIE, flows.put(flow)');
    expect(src, 'nothing may be serialised into the flow cookie').not.toMatch(/FLOW_COOKIE,\s*JSON\.stringify/);
  });

  it('never parses the cookie back into an attempt', () => {
    expect(src, 'the callback must resolve a handle, not parse a cookie').toContain('flows.take(');
    expect(src).not.toMatch(/JSON\.parse\(rawFlow\)/);
  });

  // `next` was checked at /start, and is checked again where it is used —
  // cheap, and it stops a future change to how the attempt is stored from
  // quietly reopening the redirect. Matched loosely on purpose: the redirect
  // also carries the deployment's path prefix, and pinning the exact expression
  // made this fail on a change that was correct.
  it('re-checks the return path where it redirects', () => {
    const line = src.split('\n').find((l) => l.includes('reply.redirect(') && l.includes('flow.next'));
    expect(line, 'the success redirect must exist').toBeDefined();
    expect(line, 'and must pass the return path through safeNext').toContain('safeNext(flow.next)');
  });

  // A prefixed deployment serves the SPA under a base path, so a bare `/alarms`
  // lands on the origin root — someone else's application.
  it('carries the deployment path prefix on the way back', () => {
    const line = src.split('\n').find((l) => l.includes('reply.redirect(') && l.includes('flow.next'));
    expect(line).toContain('uiBasePath');
  });
});
