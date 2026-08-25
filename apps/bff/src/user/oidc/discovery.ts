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
 * OpenID Connect discovery — the reason Horizon has no per-provider code.
 *
 * Given an `issuer`, `<issuer>/.well-known/openid-configuration` names the
 * authorization endpoint, the token endpoint and the JWKS. Google, Okta, Entra,
 * Keycloak and Auth0 all publish it, so "add Google" and "add Okta" are the
 * same three config fields and zero lines of TypeScript.
 *
 * Fetched lazily and cached: a provider's endpoints change on the order of
 * years, while its signing KEYS rotate often — which is why the keys are not
 * cached here but by `jose`'s remote key set, which refetches on an unknown
 * `kid`.
 */

import { createRemoteJWKSet } from 'jose';
import { logger } from '../../logger.js';
import { readBounded } from './userinfo.js';
import { isHttpsOrLoopback } from '../../util/loopback.js';

export interface ProviderMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwks: ReturnType<typeof createRemoteJWKSet>;
  /** Discovery says whether the provider supports PKCE. Absent means the
   *  provider predates the field; we send the challenge regardless, since a
   *  server that does not understand it ignores it. */
  supportsS256: boolean;
}

interface RawMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  jwks_uri?: string;
  /** Read only to check its scheme — the OIDC path takes the address from a
   *  verified ID token, not from userinfo. */
  userinfo_endpoint?: string;
  code_challenge_methods_supported?: string[];
}

const CACHE_MS = 6 * 60 * 60_000;
const DISCOVERY_TIMEOUT_MS = 10_000;
const cache = new Map<string, { at: number; meta: ProviderMetadata }>();

export class DiscoveryError extends Error {}

export async function discover(issuer: string, fetchImpl: typeof fetch = fetch): Promise<ProviderMetadata> {
  const key = issuer.replace(/\/+$/, '');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.meta;

  const url = `${key}/.well-known/openid-configuration`;
  let raw: RawMetadata;
  try {
    const res = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      // Discovery runs before any login can proceed, so a provider that
      // accepts the connection and stalls would block every sign-in attempt.
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = (await readBounded(res, 'discovery')) as RawMetadata;
  } catch (err) {
    throw new DiscoveryError(
      `Could not read OpenID configuration from ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!raw.authorization_endpoint || !raw.token_endpoint || !raw.jwks_uri) {
    throw new DiscoveryError(`${url} is missing authorization_endpoint, token_endpoint or jwks_uri`);
  }
  // The document is fetched from the provider, so its contents are the
  // provider's choice rather than the operator's. A plaintext token endpoint
  // here would put the client secret on the wire, so the same rule the config
  // applies to a configured endpoint applies to a discovered one.
  for (const [name, value] of [
    ['authorization_endpoint', raw.authorization_endpoint],
    ['token_endpoint', raw.token_endpoint],
    ['jwks_uri', raw.jwks_uri],
    ['userinfo_endpoint', raw.userinfo_endpoint],
  ] as const) {
    if (value && !isHttpsOrLoopback(value)) {
      throw new DiscoveryError(`${url} advertises a non-https ${name}: ${value}`);
    }
  }
  // The issuer in the document is what an ID token's `iss` must equal. A
  // provider whose document disagrees with the URL it was fetched from is
  // either misconfigured or not the provider you think it is.
  if (raw.issuer && raw.issuer.replace(/\/+$/, '') !== key) {
    throw new DiscoveryError(`${url} declares issuer "${raw.issuer}", which is not ${key}`);
  }

  const meta: ProviderMetadata = {
    issuer: key,
    authorizationEndpoint: raw.authorization_endpoint,
    tokenEndpoint: raw.token_endpoint,
    jwks: createRemoteJWKSet(new URL(raw.jwks_uri)),
    supportsS256: (raw.code_challenge_methods_supported ?? []).includes('S256'),
  };
  cache.set(key, { at: Date.now(), meta });
  logger.info({ issuer: key, supportsS256: meta.supportsS256 }, 'oidc: discovered provider metadata');
  return meta;
}

/** Test seam, and the only way to force a re-read after a provider rotates
 *  something structural. */
export function clearDiscoveryCache(): void {
  cache.clear();
}
