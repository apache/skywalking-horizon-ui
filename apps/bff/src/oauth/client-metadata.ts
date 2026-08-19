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
 * Client ID Metadata Document — a client identified by a URL rather than by a
 * prior registration.
 *
 * The client presents `client_id=https://example.com/oauth-client`, and the
 * authorization server FETCHES that URL to learn its redirect URIs. This is how
 * Claude Code identifies itself, so without it the primary client of this
 * server is rejected at the first step with "register first".
 *
 * IT MAKES THE SERVER FETCH AN ATTACKER-CHOSEN URL, and that is the whole
 * security story. `client_id` arrives on an unauthenticated endpoint from
 * anyone, so a naive implementation is a server-side request forgery primitive
 * pointed at whatever the BFF can reach — which, for an observability tool, is
 * the inside of a production network. Every guard below exists for that:
 *
 *   - https only, so it cannot be aimed at `file:` or a custom scheme;
 *   - the resolved ADDRESS must be public — loopback, private, link-local and
 *     unique-local ranges are refused, which is what stops `https://evil.test`
 *     resolving to 169.254.169.254 and reading a cloud metadata service;
 *   - no redirects followed, because a public host that 302s to a private one
 *     defeats an address check done only on the first URL;
 *   - bounded body and a timeout, so a hostile document cannot hold or exhaust
 *     the process;
 *   - the document's own `client_id` must equal the URL it came from, so one
 *     host cannot serve a document claiming to be another.
 *
 * The remaining, unavoidable property is that an unauthenticated caller can
 * make this server issue ONE bounded outbound GET to a public address of their
 * choosing. `oauth.clientMetadataHosts` narrows even that to a list.
 */

import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { logger } from '../logger.js';
import { readBounded, MAX_PROVIDER_BODY } from '../user/oidc/userinfo.js';
import { redirectUriAcceptable } from './clients.js';
import type { RegisteredClient } from './clients.js';

const FETCH_TIMEOUT_MS = 5_000;
const CACHE_MS = 10 * 60_000;

const cache = new Map<string, { at: number; client: RegisteredClient }>();

/**
 * Cap on remembered documents.
 *
 * `/api/oauth/authorize` is unauthenticated and the client id IS the cache key,
 * so anyone can mint an unlimited number of distinct successful lookups against
 * hosts they control and grow this map without bound. Insertion order is
 * eviction order — a plain FIFO rather than an LRU, because the entries are
 * uniform and short-lived and the only property that matters is that the map
 * cannot grow forever.
 */
const CACHE_MAX = 512;

/** Reject a promise that has not settled in time. `Promise.race` rather than an
 *  abort signal because `dns.lookup` accepts none. */
function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

/** A listed host matches itself and its subdomains — the same rule the outbound
 *  link policy uses, and right here for the same reason: this judges where a URL
 *  points, not who someone is. */
function hostAllowed(url: URL, allowHosts: readonly string[]): boolean {
  return allowHosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
}

export class ClientMetadataError extends Error {}

/** Is this a URL-shaped client id at all? Anything else belongs to the
 *  registration path. */
export function isMetadataUrl(clientId: string): boolean {
  return clientId.startsWith('https://');
}

/** The dotted quad held in two hextets. */
function v4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * Any IPv6 text form as its 8 hextets, or null if it does not parse.
 *
 * Written out rather than pattern-matched because the address has to be judged
 * as a NUMBER: the same address has many spellings, and a check that reads the
 * text — the leading hextet, a regex for one notation — passes the spellings it
 * did not anticipate.
 */
function hextets(v: string): number[] | null {
  let s = v;
  // A trailing dotted quad (::ffff:10.0.0.1, 64:ff9b::10.0.0.1) is two hextets.
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (dotted) {
    const q = dotted[1].split('.').map(Number);
    if (q.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = `${s.slice(0, dotted.index)}${((q[0] << 8) | q[1]).toString(16)}:${((q[2] << 8) | q[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let parts: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    parts = [...head, ...Array<string>(fill).fill('0'), ...tail];
  } else {
    parts = head;
  }
  if (parts.length !== 8) return null;
  const out = parts.map((p) => (/^[0-9a-f]{1,4}$/.test(p) ? Number.parseInt(p, 16) : Number.NaN));
  return out.some(Number.isNaN) ? null : out;
}

/**
 * Reject an address the BFF should never be asked to reach on a stranger's
 * behalf. Checked on the RESOLVED address, not the hostname — a name is not a
 * location, and `internal.evil.test` resolving to 10.0.0.1 is the attack.
 */
export function isPublicAddress(ip: string, family: number): boolean {
  if (family === 6) {
    const v = ip.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
    const h = hextets(v);
    // Unparseable is not a reason to allow: this function's answer becomes the
    // connection, so "I could not tell" has to mean no.
    if (!h) return false;
    if (h.every((x) => x === 0)) return false;                       // ::
    if (h[0] >= 0xfe80 && h[0] <= 0xfebf) return false;              // link-local  fe80::/10
    if (h[0] >= 0xfec0 && h[0] <= 0xfeff) return false;              // site-local  fec0::/10 (deprecated, still routed internally)
    if (h[0] >= 0xfc00 && h[0] <= 0xfdff) return false;              // unique-local fc00::/7
    if (h[0] >= 0xff00) return false;                                // multicast   ff00::/8
    if (h[0] === 0x2001 && h[1] === 0) return false;                 // Teredo tunnel 2001::/32
    // Four different notations put an IPv4 address inside an IPv6 one, and the
    // socket reaches THAT address — so each has to be judged as the v4 address
    // it carries, not as the v6 prefix it wears. Checking only the leading
    // hextet let `64:ff9b::a9fe:a9fe` (NAT64 around the cloud metadata service,
    // the standard translation layer in an IPv6-only cluster) read as public.
    if (h[0] === 0x2002) return isPublicAddress(v4(h[1], h[2]), 4);  // 6to4        2002::/16
    if (h[0] === 0x0064 && h[1] === 0xff9b) return isPublicAddress(v4(h[6], h[7]), 4); // NAT64 64:ff9b::/96
    if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0 || h[5] === 0xffff)) {
      // ::a.b.c.d (compatible) and ::ffff:a.b.c.d (mapped), in dotted or hex
      // notation — ::1 lands here too and is refused as 0.0.0.1.
      return isPublicAddress(v4(h[6], h[7]), 4);
    }
    // Everything else under ::/8 is reserved space, not somewhere to fetch from.
    return h[0] !== 0;
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p;
  if (a === 0 || a === 127 || a === 10) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false; // link-local, incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  // Benchmarking range (RFC 2544). Not private, but routed internally wherever
  // it is used at all — and never somewhere a client metadata document lives.
  if (a === 198 && (b === 18 || b === 19)) return false; // 198.18.0.0/15
  if (a >= 224) return false; // multicast / reserved
  return true;
}

/**
 * How a hostname becomes addresses. Injected for the same reason `doFetch` is:
 * a test of the ALLOW-LIST and the redirect rules is a test of Horizon's own
 * logic, and reaching public DNS to run it makes it fail on a train — a failure
 * that says nothing about the code. This is not a stand-in for a provider;
 * there is no provider in these paths.
 */
export type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>;

const systemResolver: Resolver = (host) => lookup(host, { all: true });

async function assertReachableTarget(
  url: URL,
  allowHosts: readonly string[],
  resolve: Resolver = systemResolver,
): Promise<string> {
  if (url.protocol !== 'https:') {
    throw new ClientMetadataError('a client-id metadata URL must be https');
  }
  if (allowHosts.length && !hostAllowed(url, allowHosts)) {
    throw new ClientMetadataError(`${url.hostname} is not in oauth.clientMetadataHosts`);
  }
  let addrs;
  try {
    // Bounded, because the RESOLUTION is attacker-influenced too. Node's DNS
    // has no timeout of its own, so a hostname delegated to a nameserver that
    // simply never answers held this unauthenticated request open for the
    // resolver's own retry schedule — far longer than the fetch timeout, which
    // does not start until resolution finishes.
    addrs = await withDeadline(resolve(url.hostname), FETCH_TIMEOUT_MS, `resolving ${url.hostname}`);
  } catch (err) {
    throw new ClientMetadataError(`could not resolve ${url.hostname}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // EVERY address must be public: a name that resolves to both a public and a
  // private address would otherwise be a coin flip.
  for (const a of addrs) {
    if (!isPublicAddress(a.address, a.family)) {
      throw new ClientMetadataError(`${url.hostname} resolves to a non-public address (${a.address})`);
    }
  }
  // Hand back the address that was checked. The caller connects to THIS, not
  // to the name — see fetchPinned.
  return addrs[0].address;
}

/**
 * Fetch the document from an address that has already been checked.
 *
 * Validating a name and then handing the name to `fetch` checks one DNS
 * resolution and connects on another: a host that answers a public address
 * first and a private one second passes the check and is then reached anyway.
 * That is DNS rebinding, and the window is as wide as the gap between the two
 * lookups.
 *
 * So the connection is pinned to the validated address. `servername` and the
 * `Host` header still carry the original hostname, so TLS is verified against
 * the certificate the name deserves — pinning the address must not become a
 * way to skip certificate checks.
 */
function fetchPinned(url: URL, address: string, timeoutMs: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: address,
        servername: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { host: url.hostname, accept: 'application/json' },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // A redirect is refused rather than followed: the next hop would be a
        // fresh name with no check at all.
        if (status >= 300 && status < 400) {
          res.destroy();
          reject(new Error(`HTTP ${status} redirect refused`));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => {
          total += c.length;
          if (total > MAX_PROVIDER_BODY) {
            res.destroy();
            reject(new Error(`document exceeded ${MAX_PROVIDER_BODY} bytes`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          resolve(
            new Response(Buffer.concat(chunks), {
              status,
              headers: { 'content-type': res.headers['content-type'] ?? 'application/json' },
            }),
          );
        });
      },
    );
    // Node's `timeout` fires on INACTIVITY, so a host that sends one byte just
    // inside it holds the socket indefinitely — and this fetch is reachable
    // unauthenticated, so a handful of such hosts is a way to occupy the
    // server. The deadline below is wall-clock and cannot be reset by
    // dribbling; the size cap alone would not end it either, because the point
    // is the time, not the bytes.
    const deadline = setTimeout(() => {
      req.destroy(new Error(`document not delivered within ${timeoutMs}ms`));
    }, timeoutMs);
    req.on('timeout', () => { req.destroy(new Error('timed out')); });
    req.on('error', reject);
    // Fires on every ending — resolved, rejected or destroyed — so one handler
    // is enough to stop the timer holding the process open.
    req.on('close', () => clearTimeout(deadline));
    req.end();
  });
}

interface RawClientMetadata {
  client_id?: string;
  client_name?: string;
  redirect_uris?: unknown;
}

export async function fetchClientMetadata(
  clientId: string,
  allowHosts: readonly string[],
  doFetch: typeof fetch = fetch,
  resolve: Resolver = systemResolver,
): Promise<RegisteredClient> {
  const url = new URL(clientId);
  // The allow-list is re-applied on a HIT, before the cache is consulted.
  // Reading the cache first meant a document fetched while `clientMetadataHosts`
  // was empty stayed usable for the rest of its window after an operator
  // narrowed the list — the tightening silently did not apply to anything
  // already seen.
  if (allowHosts.length && !hostAllowed(url, allowHosts)) {
    throw new ClientMetadataError(`${url.hostname} is not in oauth.clientMetadataHosts`);
  }
  const hit = cache.get(clientId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.client;

  const pinned = await assertReachableTarget(url, allowHosts, resolve);

  let raw: RawClientMetadata;
  try {
    // The default path pins the connection to the address just validated. An
    // injected `doFetch` (tests) is used as given — it performs no DNS.
    const res =
      doFetch === fetch
        ? await fetchPinned(url, pinned, FETCH_TIMEOUT_MS)
        : await doFetch(clientId, {
            headers: { accept: 'application/json' },
            // A public host that redirects to a private one would defeat an
            // address check performed only on the first URL.
            redirect: 'error',
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = (await readBounded(res, 'client metadata')) as RawClientMetadata;
  } catch (err) {
    throw new ClientMetadataError(
      `could not read client metadata from ${clientId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // The document must claim the identity it was fetched under, or any host
  // could serve a document impersonating another client.
  if (raw.client_id !== clientId) {
    throw new ClientMetadataError(`the document at ${clientId} declares client_id ${String(raw.client_id)}`);
  }
  const uris = Array.isArray(raw.redirect_uris)
    ? raw.redirect_uris.filter((u): u is string => typeof u === 'string')
    : [];
  if (!uris.length) throw new ClientMetadataError(`${clientId} lists no redirect_uris`);
  // The SAME rule dynamic registration applies. A client that identifies by URL
  // was skipping it entirely, so `javascript:` and `data:` reached the consent
  // screen and then a location assignment — the document is fetched from a host
  // the caller chose, so its contents are no more trusted than a registration
  // request body.
  const rejected = uris.filter((u) => !redirectUriAcceptable(u));
  if (rejected.length) {
    throw new ClientMetadataError(
      `${clientId} lists a redirect_uri Horizon will not accept: ${rejected[0]}`,
    );
  }

  const client: RegisteredClient = {
    redirectUris: uris,
    clientName: typeof raw.client_name === 'string' ? raw.client_name : undefined,
    createdAt: Date.now(),
  };
  if (cache.size >= CACHE_MAX) {
    // Drop the oldest entries first. Sweeping expired ones too, since a busy
    // period leaves a tail of them that would otherwise be evicted one at a
    // time by fresh traffic.
    const cutoff = Date.now() - CACHE_MS;
    for (const [k, v] of cache) if (v.at < cutoff) cache.delete(k);
    while (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  }
  cache.set(clientId, { at: Date.now(), client });
  logger.info({ clientId, redirectUris: uris.length }, 'oauth: loaded client metadata document');
  return client;
}

export function clearClientMetadataCache(): void {
  cache.clear();
}
