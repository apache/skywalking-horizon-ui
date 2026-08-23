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
 * Plain OAuth 2.0 identity, for providers that never adopted OIDC.
 *
 * GitHub, Gitee, Feishu, DingTalk and WeChat all issue an access token and
 * nothing else — no discovery document, no ID token, no signature over any
 * claim. Identity comes from calling a userinfo endpoint with that token and
 * reading a field out of whatever JSON comes back.
 *
 * That is a genuinely weaker proof than the OIDC path, and worth naming: with
 * an ID token, Horizon verifies a signature and a nonce, so a token minted for
 * another application cannot be replayed here. With plain OAuth2 there is no
 * such binding — a token stolen from, or issued to, a different application at
 * the same provider will answer the userinfo call identically. The compensating
 * controls are that the token is fetched server-to-server with the client
 * secret over TLS, that `state` still binds the callback to this browser, and
 * that PKCE still binds the code to this flow.
 *
 * The one thing that makes this generic rather than a pile of per-vendor
 * branches is `emailPath`: providers disagree on where the address lives
 * (`email`, `data.email`, `user.primary_email`) and none of them is wrong.
 */

import { logger } from '../../logger.js';

/**
 * Cap on a provider response body.
 *
 * `res.json()` reads to completion, so a provider that answers a userinfo call
 * with an unbounded stream — hostile, misconfigured, or just wrong about what
 * that URL serves — is parsed into this process's memory. A timeout does not
 * help: the bytes arrive steadily. Real userinfo documents are a few hundred
 * bytes; discovery documents a few kilobytes.
 */
export const MAX_PROVIDER_BODY = 256 * 1024;

/** Read a response body with a hard ceiling, rather than `res.json()`. */
export async function readBounded(res: Response, what: string): Promise<unknown> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_PROVIDER_BODY) {
    throw new Error(`${what} response declares ${declared} bytes, over the ${MAX_PROVIDER_BODY} limit`);
  }
  const reader = res.body?.getReader();
  if (!reader) return JSON.parse(await res.text());
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_PROVIDER_BODY) {
      // Stop pulling: the point is to not hold it, so cancelling matters as
      // much as refusing.
      await reader.cancel();
      throw new Error(`${what} response exceeded ${MAX_PROVIDER_BODY} bytes`);
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Read a dot path out of an arbitrary JSON body. Returns undefined for
 *  anything that is not a string at the end of the path — a provider that
 *  returns `{email: null}` for an unverified address must not read as an
 *  identity. */
export function readPath(body: unknown, path: string): string | undefined {
  let cur: unknown = body;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'string' && cur.length > 0 ? cur : undefined;
}

/** The same walk without `readPath`'s string constraint. A verification flag is
 *  a boolean on most providers and the string `"true"` on a few. */
function readAny(body: unknown, path: string): unknown {
  if (!path) return undefined;
  let cur: unknown = body;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * Does this value AFFIRM verification? Only an affirmative counts — see the
 * polarity note in `emailFromList`.
 *
 * `want` names the affirming value for a provider that does not use a boolean
 * (Gitee's `state: "confirmed"`). Compared as a string so a config file, which
 * has only strings, can express it.
 */
function affirms(v: unknown, want?: string): boolean {
  if (want) return String(v) === want;
  return v === true || v === 'true';
}

/**
 * Is this an address at all?
 *
 * `readPath` guarantees only a non-empty STRING, and providers put non-addresses
 * in the address field: Gitee returns the literal `未公开邮箱` ("email not
 * public") for an account that has hidden its address. Without this check every
 * such account resolves to the SAME Horizon username — one shared identity for
 * a whole class of users, landing on `defaultRoles` because no role rule could
 * ever match it. Deliberately a shape test and nothing more: the address was
 * already proven to belong to this person, so the only question left is whether
 * it is an address.
 */
function looksLikeAddress(v: string): boolean {
  const at = v.indexOf('@');
  return at > 0 && at === v.lastIndexOf('@') && at < v.length - 1 && !/\s/.test(v);
}

export interface Oauth2Identity {
  email: string;
  name?: string;
}

/** The provider could not be reached, or answered unusably. Distinct from
 *  `UserinfoError`, which means it answered and had no address for us. */
export class ProviderUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnreachableError';
  }
}

export class UserinfoError extends Error {}

export async function fetchOauth2Identity(
  opts: {
    userinfoEndpoint: string;
    /** Optional second endpoint whose body is a LIST of addresses. */
    emailsEndpoint?: string;
    accessToken: string;
    emailPath: string;
    /** Dot path to the boolean that proves `emailPath`. Consulted only when no
     *  `emailsEndpoint` is configured; the schema requires one of the two. */
    emailVerifiedPath?: string;
    emailVerifiedValue?: string;
    namePath: string;
    providerId: string;
  },
  doFetch: typeof fetch,
  timeoutMs: number,
): Promise<Oauth2Identity> {
  let body: unknown;
  try {
    body = await getAuthorized(opts.userinfoEndpoint, opts.accessToken, 'userinfo', doFetch, timeoutMs);
  } catch (err) {
    // A provider that could not be reached is not a provider that reported no
    // address. Collapsing both into UserinfoError made every network fault
    // surface to the operator as `no_email`, which points at the user's
    // account instead of at the provider being down.
    throw new ProviderUnreachableError(err instanceof Error ? err.message : String(err));
  }

  // A configured list is AUTHORITATIVE rather than a fallback, and the order
  // is the whole security property. Consulting the profile first would let a
  // self-asserted address beat a checked one: these providers let anyone type
  // any address into their profile, so a stranger who types a colleague's
  // address would be handed that colleague's roles.
  let email: string | undefined;
  if (opts.emailsEndpoint) {
    email = await emailFromList(opts, doFetch, timeoutMs);
  } else {
    email = readPath(body, opts.emailPath);
    // Same polarity as the OIDC branch's `email_verified`: only an affirmative
    // counts, so a missing key, `"false"`, `0` and `null` all refuse. The
    // config schema guarantees one of the two paths is configured, so there is
    // no third case where an unproven address is accepted.
    if (email && !affirms(readAny(body, opts.emailVerifiedPath ?? ''), opts.emailVerifiedValue)) {
      logger.error(
        { provider: opts.providerId, emailVerifiedPath: opts.emailVerifiedPath },
        'oauth2 provider reported an address that is not marked verified at the configured ' +
          'emailVerifiedPath — refusing it rather than trusting a self-asserted address',
      );
      throw new UserinfoError('address is not marked verified');
    }
  }
  if (!email) {
    // Name the path, because this is the field an operator gets wrong and the
    // provider's docs are the only place the right answer lives.
    logger.error(
      { provider: opts.providerId, emailPath: opts.emailPath, keys: topKeys(body) },
      'oauth2 provider returned no email at the configured emailPath — check the provider\'s userinfo shape',
    );
    throw new UserinfoError(`no email at "${opts.emailPath}"`);
  }
  if (!looksLikeAddress(email)) {
    // Do not log the value: whatever it is, it came out of a person's profile.
    logger.error(
      { provider: opts.providerId, emailPath: opts.emailPath },
      'oauth2 provider returned something that is not an address at the configured emailPath — refusing ' +
        'it, because every account reporting the same non-address would share one Horizon identity',
    );
    throw new UserinfoError(`the value at "${opts.emailPath}" is not an email address`);
  }
  return { email, name: readPath(body, opts.namePath) };
}

/** The top-level keys of the response, for the log line above. Deliberately
 *  keys ONLY — the body carries a person's profile and belongs in nobody's log. */
function topKeys(body: unknown): string[] {
  return body && typeof body === 'object' ? Object.keys(body as object).slice(0, 20) : [];
}


/** One authorized GET against a provider, bounded and timed out. */
async function getAuthorized(
  url: string,
  accessToken: string,
  what: string,
  doFetch: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  const res = await doFetch(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      // GitHub returns a different shape without it, and it is harmless
      // everywhere else.
      'user-agent': 'apache-skywalking-horizon',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return readBounded(res, what);
}

/**
 * The address a provider keeps in a LIST rather than on the profile.
 *
 * GitHub's `/user` reports `email: null` unless the operator has published one
 * on their public profile, which most have not — the real addresses live at
 * `/user/emails` as a list, and Gitee is shaped the same way. Without this the
 * common GitHub account cannot sign in at all.
 *
 * VERIFICATION IS THE POINT, not a detail. Roles resolve from the address, and
 * these providers let anyone attach any address to their account and leave it
 * unverified — so accepting one lets a stranger claim a colleague's address and
 * inherit their roles.
 *
 * So an entry must AFFIRM verification, and nothing else will do. Rejecting
 * only an explicit `verified: false` looks equivalent and is not: it passes the
 * string `"false"`, `0`, `null` and a missing key.
 *
 * Which FIELD affirms it is the provider's choice, so it is configuration
 * rather than a branch per vendor: GitHub says `verified: true` (the default
 * here), Gitee says `state: "confirmed"`. An operator names the field with
 * `emailVerifiedPath` and, when it is not a boolean, the value with
 * `emailVerifiedValue`.
 *
 * The cost is that a provider whose list affirms verification NOWHERE cannot be
 * used at all. That is the intended direction: an address is either provably
 * the person's or it is not usable as an identity.
 */
async function emailFromList(
  opts: {
    emailsEndpoint?: string;
    accessToken: string;
    emailPath: string;
    emailVerifiedPath?: string;
    emailVerifiedValue?: string;
    providerId: string;
  },
  doFetch: typeof fetch,
  timeoutMs: number,
): Promise<string | undefined> {
  let list: unknown;
  try {
    list = await getAuthorized(opts.emailsEndpoint!, opts.accessToken, 'emails', doFetch, timeoutMs);
  } catch (err) {
    // Same distinction as the userinfo call: a provider that could not be
    // reached is not one that reported no address, and reporting the former
    // as `no_email` points an operator at the account instead of the outage.
    throw new ProviderUnreachableError(
      `emails endpoint: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(list)) {
    logger.error({ provider: opts.providerId }, 'oauth2 emails endpoint did not return a list');
    return undefined;
  }

  const path = opts.emailVerifiedPath || 'verified';
  const usable = list.filter((e) => {
    if (!e || typeof e !== 'object') return false;
    if (!affirms(readAny(e, path), opts.emailVerifiedValue)) return false;
    return Boolean(readPath(e, opts.emailPath));
  });
  if (!usable.length) {
    // Say how many were rejected without naming any of them: the list is a
    // person's addresses.
    logger.error(
      { provider: opts.providerId, entries: list.length },
      'oauth2 emails endpoint returned no address that is BOTH `verified: true` and present at the ' +
        'configured emailPath — a provider that does not mark verification this way cannot be used here',
    );
    return undefined;
  }
  const primary = usable.find((e) => (e as { primary?: unknown }).primary === true);
  return readPath(primary ?? usable[0], opts.emailPath);
}
