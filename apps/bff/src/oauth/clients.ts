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
 * Dynamic client registration (RFC 7591), without a client store: the
 * `client_id` IS the registration, signed. Whoever holds it can prove what was
 * registered, and Horizon keeps nothing.
 *
 * Every client here is PUBLIC — no `client_secret`. That is what OAuth 2.1
 * requires for a native app anyway: Claude Code, Codex and `mcp-remote` all run
 * on the operator's laptop, where a shipped secret is a secret in a file every
 * user of that app already has. PKCE is what actually binds the code to the
 * client, and it is mandatory here rather than optional.
 */

import { sign, verify } from './signing.js';

export interface RegisteredClient {
  redirectUris: string[];
  clientName?: string;
  createdAt: number;
}

export function registerClient(key: string, reg: Omit<RegisteredClient, 'createdAt'>): string {
  return `hzc_${sign(key, 'client', { ...reg, createdAt: Date.now() })}`;
}

export function readClient(key: string, clientId: string): RegisteredClient | null {
  if (!clientId.startsWith('hzc_')) return null;
  return verify<RegisteredClient>(key, 'client', clientId.slice(4));
}

/** RFC 8252 §7.3 loopback: `localhost`, IPv4 loopback, IPv6 loopback. */
function loopbackHost(h: string): boolean {
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
}

/** Does this redirect go back to something on the operator's own machine? */
export function isLoopbackRedirect(raw: string): boolean {
  try {
    return loopbackHost(new URL(raw).hostname);
  } catch {
    return false;
  }
}

/**
 * Is this redirect one the client registered?
 *
 * Exact match, with ONE documented exception: for a loopback redirect the port
 * is ignored. RFC 8252 §7.3 requires that, and it is not a nicety —
 * Claude Code binds a fresh ephemeral port every session, so a client
 * registered at `http://127.0.0.1:51234/callback` will come back on a different
 * port every single time. Without the exception, login works once.
 *
 * Everything else about the URL still has to match, host and path included, and
 * the exception is confined to loopback: a non-loopback redirect with a
 * wildcard port would let anyone who can bind a port on that host receive
 * someone else's authorization code.
 */
export function redirectAllowed(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let want: URL;
  try {
    want = new URL(requested);
  } catch {
    return false;
  }
  if (want.protocol !== 'http:' || !loopbackHost(want.hostname)) return false;
  return registered.some((r) => {
    try {
      const have = new URL(r);
      return (
        have.protocol === 'http:' &&
        loopbackHost(have.hostname) &&
        have.hostname === want.hostname &&
        have.pathname === want.pathname &&
        have.search === want.search
      );
    } catch {
      return false;
    }
  });
}

/**
 * A redirect URI Horizon will register at all.
 *
 * Loopback over plain HTTP is the native-app flow and is fine — the response
 * never leaves the machine. Anything else must be HTTPS, because an
 * authorization code in a URL over plain HTTP is a code on the wire. A custom
 * scheme (`myapp://cb`) is also accepted: it is the other RFC 8252 redirect,
 * and the OS hands it straight to the registered app.
 */
export function redirectUriAcceptable(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash) return false; // a fragment is never sent to the server anyway
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return loopbackHost(u.hostname);
  // A custom scheme has no authority to reason about; require it to be one.
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && u.protocol !== 'javascript:' && u.protocol !== 'data:';
}
