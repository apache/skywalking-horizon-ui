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
 * Who an OIDC sign-in makes you, in Horizon's terms.
 *
 * The provider answers WHO you are; this file answers WHAT YOU MAY DO, and the
 * two are deliberately kept apart. An external identity provider is not
 * entitled to grant privileges inside Horizon — hence `defaultRoles: [viewer]`
 * and an explicit override table rather than trusting a claim.
 *
 * THE CONSTRAINT THAT SHAPES ALL OF THIS: roles are re-resolved on every
 * request from the username alone (see `user/roles.ts`), because that is what
 * makes a token unable to outlive its owner's access. At that moment there is
 * no ID token and no claims — they existed once, at login, and Horizon has
 * nowhere to have kept them. So the mapping must be a PURE FUNCTION of the
 * email address. Group-claim mapping is not a missing feature here, it is a
 * feature that needs a persistent store Horizon does not have.
 */

import type { HorizonConfig } from '../../config/schema.js';

export type OidcProvider = HorizonConfig['auth']['sso']['providers'][number];
/** The single role table every provider shares. */
export type OidcRoles = HorizonConfig['auth']['sso']['roles'];

export function findProvider(config: HorizonConfig, id: string): OidcProvider | undefined {
  return config.auth.sso.providers.find((p) => p.id === id);
}

export function oidcEnabled(config: HorizonConfig): boolean {
  return config.auth.sso.providers.length > 0;
}

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

/**
 * May this address sign in at all?
 *
 * An empty `allowedDomains` admits every address the provider will
 * authenticate — for a public provider like Google that is the whole internet.
 * `validateBootstrap` warns about it once at boot rather than per request.
 */
export function domainAllowed(provider: OidcProvider, email: string): boolean {
  if (provider.allowedDomains.length === 0) return true;
  const d = domainOf(email);
  // EXACT, and a subdomain is a different domain. The outbound-link policy
  // matches subdomains, and copying that here was wrong: a link policy judges
  // where a URL points, while this decides who someone IS.
  //
  // On a shared issuer the two diverge badly. `accounts.google.com` serves
  // every Workspace tenant, and there is no claim naming which — so whoever
  // controls DNS for any delegated label under your domain (a dev cluster, a
  // department, a lab) can stand up their own tenant on it, verify it with a
  // TXT record they can already publish, and inherit the parent domain's
  // roles. Workspace addresses are exact-domain anyway, so the suffix rule
  // bought nothing and widened the grant to everyone who owns any label below.
  return provider.allowedDomains.some((a) => d === a.toLowerCase().replace(/^@/, ''));
}

/**
 * The roles an SSO identity holds RIGHT NOW, from the ONE role table.
 *
 * Called at login and again on every subsequent request, and it must return
 * the same answer for the same config — see the file comment. Which provider
 * authenticated the person is deliberately not an input: at re-resolution time
 * there is no record of it, so a rule that depended on it could not be applied
 * consistently between the login and the requests that follow.
 *
 * Most specific wins: an exact address beats its domain, which beats the
 * default.
 */
export function rolesForEmail(roles: OidcRoles, email: string): string[] {
  const lower = email.toLowerCase();
  for (const [addr, r] of Object.entries(roles.roleByEmail)) {
    if (addr.toLowerCase() === lower) return r;
  }
  // Exact, for the reason spelled out in `domainAllowed`: a subdomain is a
  // different domain, and on a shared issuer it can belong to someone else.
  const d = domainOf(lower);
  for (const [dom, r] of Object.entries(roles.roleByDomain)) {
    if (d === dom.toLowerCase().replace(/^@/, '')) return r;
  }
  return roles.defaultRoles;
}

/**
 * Roles for a username that may or may not be an OIDC identity.
 *
 * Consulted by `RoleResolver` AFTER local users and LDAP, so a local account
 * with the same name shadows an SSO one — which is the order that keeps a
 * break-glass admin working when a provider misbehaves.
 *
 * Returns `[]` for anything that is not an address a configured provider would
 * admit, which is what makes an unknown user resolve to no roles and be
 * refused.
 */
export function oidcRolesFor(config: HorizonConfig, username: string): string[] {
  if (!oidcAdmits(config, username)) return [];
  return rolesForEmail(config.auth.sso.roles, username);
}

/**
 * Would ANY configured provider sign this person in?
 *
 * Existence, separated from authorization, because the two answers diverge:
 * with `rbac.enabled: false` roles carry no information (everyone holds `*`),
 * so "has no roles" cannot be read as "is nobody" — and a credential for
 * somebody who is nobody has to be refused whatever the role table says.
 */
export function oidcAdmits(config: HorizonConfig, username: string): boolean {
  if (!username.includes('@')) return false;
  // A provider still decides WHO may sign in through it; only the roles moved.
  return config.auth.sso.providers.some((p) => domainAllowed(p, username));
}
