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

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { originAllowed } from './route.js';

/**
 * Streamable HTTP requires the server to validate Origin, and the attack it
 * closes is DNS rebinding: a page the operator is merely VISITING resolves a
 * name it controls to 127.0.0.1 and posts JSON-RPC at their local Horizon,
 * carrying their real cookie. The browser attaches an Origin the page cannot
 * forge — which is why this works where checking Host does not.
 */
describe('MCP Origin validation', () => {
  const PUB = 'https://horizon.example.com';

  /** A native client sends none: Codex, a CLI, curl. Absence is itself the
   *  proof that the caller is not a page, so it must stay allowed — refusing it
   *  would break every real MCP client while stopping no attack. */
  it('allows a missing Origin', () => {
    expect(originAllowed(undefined, PUB)).toBe(true);
    expect(originAllowed(undefined, '')).toBe(true);
  });

  it('allows this deployment’s own origin', () => {
    expect(originAllowed('https://horizon.example.com', PUB)).toBe(true);
  });

  it('refuses another site, which is the whole point', () => {
    expect(originAllowed('https://evil.example', PUB)).toBe(false);
    // A prefix of the real host must not pass.
    expect(originAllowed('https://horizon.example.com.evil.test', PUB)).toBe(false);
    // Nor a scheme or port change, which are different origins.
    expect(originAllowed('http://horizon.example.com', PUB)).toBe(false);
    expect(originAllowed('https://horizon.example.com:8443', PUB)).toBe(false);
  });

  /** The dev UI runs on a different port from the BFF, and the ui:// bundle is
   *  served from a loopback host, so loopback is allowed on any port. */
  it('allows loopback on any port', () => {
    for (const o of ['http://127.0.0.1:9091', 'http://localhost:5173', 'http://[::1]:3000']) {
      expect(originAllowed(o, PUB), o).toBe(true);
    }
  });

  it('refuses anything that is not a URL rather than parsing around it', () => {
    for (const o of ['not a url', 'null', '://', '']) {
      // '' is falsy and therefore reads as absent, which is the native-client case.
      expect(originAllowed(o, PUB), o).toBe(o === '');
    }
  });

  /** A malformed publicUrl must not silently widen the check to everything. */
  it('does not widen when publicUrl is unusable', () => {
    expect(originAllowed('https://evil.example', 'not-a-url')).toBe(false);
    expect(originAllowed('https://evil.example', '')).toBe(false);
  });
});

/**
 * The other half of the DNS-rebinding story, and the reason the Origin check is
 * no longer load-bearing on its own: a browser session is refused outright.
 *
 * A cookie could not be served correctly here anyway — the transport writes the
 * response itself, so the sliding-session cookie the auth layer queues is never
 * sent, and the session would expire in the browser while the server believed
 * it alive. Refusing is honest where half-working renewal is not, and it costs
 * nothing: every real MCP client holds a bearer token, which is what the OAuth
 * flow exists to give it.
 */
describe('MCP accepts a bearer credential and not a browser session', () => {
  const src = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');

  it('refuses authKind session before doing any work', () => {
    const guard = src.indexOf("req.authKind === 'session'");
    expect(guard, 'the session refusal must exist').toBeGreaterThan(-1);
    // Ahead of the transport, the server build and the OAP offset — nothing
    // should be spent on a credential that is about to be refused.
    expect(guard).toBeLessThan(src.indexOf('new StreamableHTTPServerTransport'));
    // The CALL, not the import at the top of the file.
    expect(guard).toBeLessThan(src.indexOf('= createMcpServer('));
  });

  it('says how to authenticate instead', () => {
    expect(src).toMatch(/bearer token.*API token.*OAuth/s);
  });
});
