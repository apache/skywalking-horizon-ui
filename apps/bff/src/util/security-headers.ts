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
 * The security headers every response carries. One definition, because there
 * are two places that emit them: the global `onSend` hook, and the AI SSE
 * route, which hijacks the reply and writes its own head — a split that will
 * silently diverge the moment someone edits only one of them.
 *
 * Sent as a response header rather than a `<meta http-equiv>`: `frame-ancestors`
 * and the Report-Only variant are ignored in meta form, and the dev server
 * serves the same `index.html`, where `connect-src 'self'` would kill HMR.
 */

/**
 * Every directive value here is derived from what the app actually loads, not
 * from a template. The non-obvious ones:
 *
 * - `script-src 'self'` with no `'unsafe-inline'` / `'unsafe-eval'`. The built
 *   `index.html` carries one external module tag and no inline script; Vue is
 *   the runtime-only build (no template compiler); Monaco's workers are
 *   emitted as same-origin files, so `blob:` is not needed either. This is the
 *   directive that matters — it is what makes an injected `onerror=` attribute
 *   or a stored `javascript:` href inert.
 * - `style-src 'unsafe-inline'` is unavoidable and is NOT about Vue's `:style`
 *   bindings (those go through the CSSOM, which CSP does not govern). ECharts
 *   builds tooltip markup with inline style attributes, Monaco injects theme
 *   `<style>` elements, and Vue's compiler re-serializes hoisted static
 *   subtrees — none expose a nonce hook, and a nonce would make
 *   `'unsafe-inline'` be ignored, breaking all three.
 * - `img-src data:` is required by four independent producers: Vite inlines
 *   assets under 4 KB, the 3D map bakes SVG icon textures, three authored CSS
 *   backgrounds, and Monaco's runtime-injected squiggle rules.
 * - `child-src 'self'` must NOT be `'none'`: it is the pre-`worker-src`
 *   fallback older engines use for workers, so `'none'` kills every Monaco
 *   editor there. Iframes are locked by `frame-src 'none'`.
 * - `base-uri` and `form-action` do not inherit from `default-src`, so they
 *   are stated explicitly.
 *
 * `navigate-to` is deliberately absent — it was removed from CSP Level 3 in
 * 2022 and never shipped anywhere. Nothing in CSP constrains where a plain
 * `<a href>` navigates; restricting an operator-supplied link is an
 * application-level check, not a policy directive.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "child-src 'self'",
  "frame-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** `X-Frame-Options` is kept alongside `frame-ancestors` for engines that
 *  predate CSP Level 2; the two say the same thing. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
});

/**
 * API responses are never stored. Everything under `/api/` is either
 * authenticated data read out of OAP or the operator's own configuration, so
 * none of it belongs in a browser's disk cache, a shared proxy, or the
 * back/forward store — on a shared workstation those outlive the session that
 * was allowed to see them.
 *
 * `no-store` is deliberately stronger than `max-age=0, must-revalidate`: the
 * latter still permits the body to be written to disk and merely requires a
 * revalidation before reuse.
 *
 * This applies to `/api/` ONLY. The built SPA's assets are content-hashed and
 * must stay cacheable, so the rule keys on the path rather than riding in
 * {@link SECURITY_HEADERS}.
 */
export const API_CACHE_CONTROL = 'no-store';

export function isApiPath(url: string): boolean {
  const path = url.split('?')[0];
  return path === '/api' || path.startsWith('/api/');
}
