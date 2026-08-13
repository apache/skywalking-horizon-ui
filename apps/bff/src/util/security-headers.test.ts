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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECURITY_HEADERS, API_CACHE_CONTROL, isApiPath } from './security-headers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const csp = SECURITY_HEADERS['Content-Security-Policy'];
const directive = (name: string): string | undefined =>
  csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));

describe('the content security policy keeps the properties it was derived for', () => {
  // This is the directive that does the work: it makes an injected `onerror=`
  // attribute and a stored `javascript:` href inert. Nothing in the app needs
  // either keyword — the built page has no inline script and Vue ships
  // runtime-only — so granting one would be silent, and would remove the only
  // barrier between a stored-config HTML sink and script execution.
  it('never grants inline or eval to scripts', () => {
    expect(directive('script-src')).toBe("script-src 'self'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain('wasm-unsafe-eval');
  });

  // `child-src` looks like an iframe directive and is not: it is the
  // pre-`worker-src` fallback older engines use, so `'none'` here kills every
  // Monaco editor on them. Iframes are locked by `frame-src`.
  it('does not strand workers on engines without worker-src', () => {
    expect(directive('child-src')).toBe("child-src 'self'");
    expect(directive('frame-src')).toBe("frame-src 'none'");
  });

  // Neither inherits from `default-src`, so dropping them is invisible.
  it('states the directives that do not inherit from default-src', () => {
    expect(directive('base-uri')).toBe("base-uri 'none'");
    expect(directive('form-action')).toBeDefined();
  });

  // Four producers need `data:` images (Vite's sub-4KB inlining, the 3D map's
  // baked SVG textures, authored CSS backgrounds, Monaco's squiggles), and
  // nothing anywhere loads from another origin.
  it('allows data: images and no remote origin at all', () => {
    expect(directive('img-src')).toBe("img-src 'self' data:");
    expect(csp).not.toMatch(/https?:\/\//);
    expect(directive('connect-src')).toBe("connect-src 'self'");
  });

  // Removed from CSP3 in 2022 and never shipped: emitting it is false
  // assurance. Restricting where a link goes is an application-level check.
  it('does not emit the retired navigate-to directive', () => {
    expect(csp).not.toContain('navigate-to');
  });

  it('keeps the pre-CSP2 clickjacking header alongside frame-ancestors', () => {
    expect(SECURITY_HEADERS['X-Frame-Options']).toBe('DENY');
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
  });

  // The AI chat route hijacks the reply, so it bypasses the global onSend hook
  // and writes its own head. It must spread this same map rather than restate
  // the headers, or the two silently diverge — which is exactly how the CSP
  // would come to be missing on one route only.
  it('is the single source both emitters use', () => {
    const sse = readFileSync(join(HERE, '../ai/http/chat.ts'), 'utf8');
    expect(sse).toContain('...SECURITY_HEADERS');
    expect(sse).not.toContain("'X-Frame-Options': 'DENY'");

    const server = readFileSync(join(HERE, '../server.ts'), 'utf8');
    expect(server).toContain('Object.entries(SECURITY_HEADERS)');
  });
});

describe('API responses are never stored', () => {
  it('is no-store, not merely revalidate-before-reuse', () => {
    // `max-age=0, must-revalidate` still lets a browser write the body to
    // disk; on a shared workstation that outlives the session allowed to see
    // it. Two routes used to set exactly that and now rely on this instead.
    expect(API_CACHE_CONTROL).toBe('no-store');
  });

  it.each([
    '/api/menu',
    '/api/menu?ts=1',
    '/api/configs/bundle',
    '/api/ai/chat',
    '/api',
  ])('applies to %s', (url) => {
    expect(isApiPath(url)).toBe(true);
  });

  // The built SPA's assets are content-hashed and must stay cacheable — the
  // rule keys on the path for exactly this reason.
  it.each(['/', '/index.html', '/assets/index-abc123.js', '/favicon.svg', '/apidocs', '/layer/api'])(
    'does not apply to %s',
    (url) => {
      expect(isApiPath(url)).toBe(false);
    },
  );
});
