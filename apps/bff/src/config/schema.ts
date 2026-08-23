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

import { z } from 'zod';
import { isIP } from 'node:net';
import { auditSchema } from './audit.js';
export { isHttpsOrLoopback, isLoopbackHostname } from '../util/loopback.js';
import { isHttpsOrLoopback } from '../util/loopback.js';

// Env-var-overridable bind defaults. The Docker image sets
// `HORIZON_SERVER_HOST=0.0.0.0` so a zero-config `docker run -p 8081:8081
// horizon-ui:local` reaches the BFF (the YAML default `127.0.0.1` would
// bind container-loopback and silently 502 from the host side). An
// explicit `server.host`/`server.port` in horizon.yaml always wins.
const serverHostDefault = process.env.HORIZON_SERVER_HOST ?? '127.0.0.1';
const serverPortDefault = (() => {
  const raw = process.env.HORIZON_SERVER_PORT;
  if (!raw) return 8081;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8081;
})();
const serverSchema = z
  .object({
    host: z.string().default(serverHostDefault),
    port: z.number().int().positive().default(serverPortDefault),
    staticDir: z.string().optional(),
    /**
     * The PUBLIC base URL operators reach this Horizon at, e.g.
     * `https://horizon.example.com`. One concept, two users: the OAuth
     * authorization server advertises it as its issuer, and single sign-on
     * builds its callback from it.
     *
     * Blank derives it from each request, which is right for a plain
     * deployment and wrong for two common ones: behind a proxy that rewrites
     * Host, and in dev, where Vite proxies `/api` with `changeOrigin` so the
     * BFF sees its own `127.0.0.1:8081` rather than the `:9091` the operator
     * is actually browsing — and the login then lands on a port that serves no
     * UI. Set it and both stop guessing.
     */
    publicUrl: z.string().default(process.env.HORIZON_PUBLIC_URL ?? ''),
    /**
     * Whether to believe `X-Forwarded-For` for the client address.
     *
     * `false` records the direct peer, which behind a proxy is the proxy. That
     * matters wherever Horizon records or acts on a client address — the login
     * audit log most of all, where every row would otherwise name the ingress.
     *
     * `true` is REFUSED. It means "trust the whole header", so any caller can
     * choose the address Horizon records by sending one; the refinement below
     * rejects it rather than accepting a setting that quietly makes the column
     * meaningless. Use a hop count or the ingress addresses instead:
     *
     *   number       the client is the Nth entry from the RIGHT of the header.
     *                `@fastify/forwarded` builds the list as
     *                `[socket peer, …X-Forwarded-For reversed]`, so the peer
     *                counts as one of the N — with one proxy in front, `1`.
     *                Too high is dangerous: once there is nothing left to
     *                skip it falls back to the LEFTMOST entry, whatever the
     *                caller sent.
     *   addr/CIDR    trust these addresses and take the first entry that is
     *                not one of them. A comma-separated list is accepted.
     *                Cannot make the too-high mistake, so prefer it.
     *
     * Restart-only: Fastify is constructed once with this value.
     */
    trustProxy: z
      .union([z.boolean(), z.number().int().positive(), z.string()])
      .default(false)
      .refine((v) => v !== true, {
        message:
          'server.trustProxy: true trusts the whole X-Forwarded-For header, so any caller can choose ' +
          'the address Horizon records. Use a hop count (e.g. 1) or the ingress address/CIDR instead.',
      })
      // Fastify parses a string value as addresses and THROWS on anything that
      // is not one — `proxy.internal` takes the process down at construction,
      // long after this file was read and with a message that names Fastify
      // rather than the setting. A hostname cannot work here even in
      // principle: the check runs per request against a peer address, and
      // resolving names on that path is not something Fastify does.
      .refine(
        (v) => typeof v !== 'string' || v.split(',').every((part) => isIpOrCidr(part.trim())),
        {
          message:
            'server.trustProxy must be a hop count, or addresses/CIDRs — not a hostname. Fastify ' +
            'matches it against the peer address and refuses to start on anything it cannot parse.',
        },
      )
      // `0.0.0.0/0` and `::/0` match every address there is, so they are
      // `true` written as a CIDR — the same attacker-chosen client address,
      // arriving past the check that refuses `true` by name.
      .refine(
        (v) => typeof v !== 'string' || !v.split(',').some((part) => matchesEveryAddress(part.trim())),
        {
          message:
            'server.trustProxy: a /0 block trusts every address, which is what `true` does. Name ' +
            'the ingress address or its real prefix instead.',
        },
      ),
  })
  .strict();

const oapSchema = z
  .object({
    /** OAP query host (GraphQL + `/status/*`). Single URL — query traffic
     *  is load-balanceable, any OAP node can answer. */
    queryUrl: z.string().url().default('http://127.0.0.1:12800'),
    /** OAP admin host (runtime rule mgmt, DSL/MQE/OAL, inspect, live
     *  debug). Single URL. Most endpoints get a single fire (OAP routes
     *  cluster-internal); live-debug status performs a DNS lookup on
     *  the hostname to discover all node IPs and probes each. */
    adminUrl: z.string().url().default('http://127.0.0.1:17128'),
    timeoutMs: z.number().int().positive().default(15000),
    auth: z
      .object({
        username: z.string().min(1),
        password: z.string().min(1),
      })
      .strict()
      .optional(),
    mqe: z
      .object({
        host: z.string().optional(),
        port: z.number().int().positive().optional(),
      })
      .strict()
      .default({}),
    zipkinUrl: z.string().url().default('http://127.0.0.1:9412/zipkin'),
  })
  .strict();

const localUserSchema = z
  .object({
    username: z.string().min(1),
    passwordHash: z.string().min(1),
    roles: z.array(z.string().min(1)).default([]),
  })
  .strict();

const ldapGroupMappingSchema = z
  .object({
    /** LDAP group DN (or the literal "*" to match any authenticated user). */
    group: z.string().min(1),
    /** Horizon role assigned when the user's group memberships include `group`. */
    role: z.string().min(1),
  })
  .strict();

const ldapSchema = z
  .object({
    /** Directory URL, e.g. `ldaps://ldap.corp:636` or `ldap://localhost:389`. */
    url: z.string().min(1),
    /** Optional service-account DN used for user/group searches.
     *  When empty, an anonymous bind is attempted for searches. */
    bindDn: z.string().default(''),
    /** Service-account password. Supports `${VAR:default}` interpolation
     *  in the YAML; empty means anonymous search. */
    bindPassword: z.string().default(''),
    /** Base DN under which user entries live (e.g. `ou=people,dc=corp`). */
    userBaseDn: z.string().min(1),
    /** Search filter; `{username}` is substituted with the typed username,
     *  escaped per RFC 4515. Default targets the common `uid` attribute. */
    userFilter: z.string().default('(uid={username})'),
    /** Attribute on the user entry that holds the display name. */
    displayNameAttr: z.string().default('cn'),
    /** Group membership strategy:
     *  - `memberOf`  → read the user entry's `memberOf` attribute (AD-style).
     *  - `search`    → search `groupBaseDn` for groups whose `memberAttr`
     *                   contains the user's DN (OpenLDAP-style). */
    groupStrategy: z.enum(['memberOf', 'search']).default('memberOf'),
    /** Base DN under which group entries live. Only used when
     *  `groupStrategy: 'search'`. */
    groupBaseDn: z.string().default(''),
    /** Group attribute that lists members (e.g. `member`, `uniqueMember`).
     *  Only used when `groupStrategy: 'search'`. */
    memberAttr: z.string().default('member'),
    /** Group DN → Horizon role bindings. First match wins; `"*"` matches
     *  every authenticated user. Order matters — put the highest-privilege
     *  rule first if you only want one role per user, or use multiple
     *  entries to assign multiple roles. */
    groupMappings: z.array(ldapGroupMappingSchema).default([]),
    /** Bind / search timeout in ms. */
    timeoutMs: z.number().int().positive().default(5000),
    /** When `true`, skip TLS certificate validation. Use only for dev
     *  directories with self-signed certs; never in production. */
    tlsInsecure: z.boolean().default(false),
  })
  .strict();

const breakGlassSchema = z
  .object({
    /** Username allowed to log in via break-glass. When unset, break-glass
     *  is disabled. */
    username: z.string().min(1),
    /** Argon2id hash of the break-glass password (use `pnpm --filter bff cli:hash`). */
    passwordHash: z.string().min(1),
    /** Roles granted when the break-glass session is established.
     *  Defaults to `['admin']` since the whole point of break-glass is
     *  recovering from a broken auth config. */
    roles: z.array(z.string().min(1)).default(['admin']),
  })
  .strict();

/** https, or http to a loopback host — the only place there is no network to
 *  read a secret off. An unparseable value is not secure. */
function isSecureUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === '::1');
}

/**
 * A single-sign-on provider. Everything vendor-specific is discovered from
 * `issuer` at runtime, so Google, Okta, Entra, Keycloak and Auth0 are the same
 * three fields — there is no per-provider code anywhere in Horizon.
 */
const ssoProviderSchema = z
  .object({
    /** Stable id. Appears in `state`, never in a URL —
     *  there is ONE callback for every provider. */
    id: z.string().min(1),
    /** Button label on the login page. Defaults to `id`. */
    displayName: z.string().default(''),
    /**
     * OPTIONAL icon for the button, as a `data:image/...` URI.
     *
     * Horizon ships NO vendor marks, and that is a licensing decision rather
     * than an omission: Google, GitLab and Okta each require prior written
     * permission for their logo, none of the six major providers' brand terms
     * addresses whether the asset may be redistributed in a release tarball at
     * all, and a recoloured or monochrome substitute breaks the same terms a
     * different way. The ASF projects that solve this well — DolphinScheduler,
     * and Superset/Airflow through Flask-AppBuilder — let the operator supply
     * it, so a deployment that has the vendor's permission (or is using its own
     * internal IdP) can look right without the project redistributing anything.
     *
     * A `data:` URI ONLY, never raw SVG markup and never a remote URL: it
     * renders through `<img src>`, which cannot execute script the way inlined
     * SVG can, and the content-security-policy already permits `data:` images
     * while forbidding every remote origin.
     */
    icon: z
      .string()
      .default('')
      .refine((v) => v === '' || /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(v), {
        message: 'icon must be a base64 data: URI, e.g. "data:image/svg+xml;base64,PHN2Zy4uLg=="',
      }),
    /**
     * How this provider is spoken to.
     *
     * `oidc` (default) discovers everything from `issuer` and verifies a signed
     * ID token — the safer path, and what Google, Okta, Entra, Keycloak,
     * Auth0, GitLab, Authing and Casdoor all support.
     *
     * `oauth2` is for providers that never adopted OIDC: GitHub, Gitee, and
     * the Chinese consumer platforms. There is no discovery document and no ID
     * token, so the endpoints are configured by hand and identity comes from
     * calling a userinfo endpoint with the access token. That is a weaker
     * proof — a bearer token read from a userinfo URL, not a signature over
     * claims — so it is opt-in per provider rather than a silent fallback.
     */
    kind: z.enum(['oidc', 'oauth2']).default('oidc'),
    /** The provider's issuer URL. Horizon reads
     *  `<issuer>/.well-known/openid-configuration` for its endpoints and keys,
     *  which is why adding an OIDC provider needs no code. Required for
     *  `kind: oidc`, unused for `oauth2`. */
    issuer: z.string().default(''),
    /** `oauth2` only — the three endpoints discovery would otherwise supply. */
    authorizationEndpoint: z.string().default(''),
    tokenEndpoint: z.string().default(''),
    userinfoEndpoint: z.string().default(''),
    /**
     * `oauth2` only — a second endpoint whose body is a LIST of addresses,
     * consulted when the profile carries none. GitHub's `/user` reports
     * `email: null` unless the operator publishes one on their public profile,
     * so for most accounts `/user/emails` is the only place the address exists.
     * Entries marked `verified: false` are skipped, and a `primary` entry wins.
     */
    emailsEndpoint: z.string().default(''),
    /**
     * `oauth2` only — where the email lives in the userinfo response, as a dot
     * path (`email`, `data.email`, `user.primary_email`). Providers disagree
     * wildly and none of them is wrong; this is the one field that makes the
     * adapter generic rather than a pile of per-vendor branches.
     */
    emailPath: z.string().default('email'),
    /**
     * `oauth2` only — a dot path to a BOOLEAN in the userinfo response saying
     * the address at `emailPath` is verified. The value must be `true` (or the
     * string `"true"`); anything else, including a missing key, refuses the
     * sign-in.
     *
     * This exists because `kind: oauth2` has no ID token to carry
     * `email_verified`, and an unverified address cannot be an identity here:
     * roles resolve from the address, so accepting a self-asserted one lets a
     * stranger claim a colleague's address and inherit their roles. Set this,
     * or `emailsEndpoint` — a provider that states verification NEITHER way
     * cannot prove who its users are, and Horizon refuses to start rather than
     * treat an unproven claim as an identity.
     */
    emailVerifiedPath: z.string().default(''),
    /**
     * `oauth2` only — the value at `emailVerifiedPath` that AFFIRMS
     * verification, for a provider that does not use a boolean. Gitee spells it
     * `state: "confirmed"`, so `emailVerifiedPath: state` with
     * `emailVerifiedValue: confirmed`. Blank means the boolean `true` (or the
     * string `"true"`), which is what GitHub and most others send.
     *
     * This also applies to the entries of `emailsEndpoint`, so which field
     * proves an address is configuration rather than a branch per vendor.
     */
    emailVerifiedValue: z.string().default(''),
    /** `oauth2` only — where a display name lives, if anywhere. */
    namePath: z.string().default('name'),
    clientId: z.string().min(1),
    /** SECRET — env-only. The code exchange is server-to-server. */
    clientSecret: z.string().default(''),
    /** Extra scopes beyond the defaults (`openid email profile` for oidc; none
     *  for oauth2, where the provider decides what an email needs — GitHub
     *  wants `user:email`, Gitee wants `emails`). */
    scopes: z.array(z.string().min(1)).default([]),
    /** Email domains allowed to sign in AT ALL. Empty means any verified email
     *  the provider will authenticate — which for a public provider like
     *  Google is the entire internet, so it is rarely what you want. */
    allowedDomains: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .superRefine((p, ctx) => {
    // Fail at config-parse time rather than at the first login attempt: a
    // provider missing the fields its own kind needs can never work, and
    // finding that out from a browser redirect is a poor way to learn it.
    // The client secret goes to the token endpoint, so a plaintext provider
    // URL puts it on the wire. Loopback stays allowed for a local mock.
    for (const [field, value] of [
      ['issuer', p.issuer],
      ['authorizationEndpoint', p.authorizationEndpoint],
      ['tokenEndpoint', p.tokenEndpoint],
      ['userinfoEndpoint', p.userinfoEndpoint],
      ['emailsEndpoint', p.emailsEndpoint],
    ] as const) {
      if (value && !isHttpsOrLoopback(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `provider "${p.id}": ${field} must be https (or a loopback address) — the client secret is sent to this provider`,
        });
      }
    }
    if (p.kind === 'oidc' && !p.issuer) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['issuer'], message: `provider "${p.id}": issuer is required for kind: oidc` });
    }
    if (p.kind === 'oauth2') {
      for (const f of ['authorizationEndpoint', 'tokenEndpoint', 'userinfoEndpoint'] as const) {
        if (!p[f]) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [f], message: `provider "${p.id}": ${f} is required for kind: oauth2 (there is no discovery document to read it from)` });
        }
      }
      // The client SECRET is posted to `tokenEndpoint` and the access token is
      // sent to the other two, so plain HTTP puts both on the wire in clear.
      // `oidc` gets this free: its endpoints come from a discovery document
      // fetched over https, and `issuer` is checked the same way below.
      // Loopback is exempted for development against a provider on the same
      // machine, which is the one case where there is no network to read.
      for (const f of ['authorizationEndpoint', 'tokenEndpoint', 'userinfoEndpoint', 'emailsEndpoint'] as const) {
        if (p[f] && !isSecureUrl(p[f])) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [f],
            message:
              `provider "${p.id}": ${f} must be https — the client secret and the access token are sent to ` +
              `these endpoints, and plain HTTP puts them on the wire in clear. http:// is accepted only for ` +
              `localhost or 127.0.0.1.`,
          });
        }
      }
      // The `kind: oidc` branch gets this free — a signed ID token carries
      // `email_verified`, and route.ts refuses anything but an affirmative one.
      // `oauth2` has no ID token, so verification has to be configured, and it
      // has to be REQUIRED: silently trusting a profile field is how a provider
      // that lets anyone type any address into their profile becomes a way to
      // sign in as somebody else.
      if (!p.emailsEndpoint && !p.emailVerifiedPath) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['emailVerifiedPath'],
          message:
            `provider "${p.id}": kind: oauth2 needs proof that the address it reports is verified — set ` +
            `emailsEndpoint (a list whose entries carry \`verified: true\`) or emailVerifiedPath (a boolean ` +
            `in the userinfo response). A provider that states verification neither way cannot prove its ` +
            `users' addresses, and roles here resolve from the address.`,
        });
      }
    }
  });

/**
 * What an SSO identity may do — ONE table for every provider.
 *
 * Not per-provider, and that is a correctness constraint rather than a
 * simplification. Roles are re-resolved on EVERY request from a username and
 * nothing else — that is what stops a token outliving its owner's access — and
 * at that moment there is no record of which provider authenticated it. A
 * per-provider table therefore cannot be honoured for tokens at all; keeping
 * one made the config promise something the architecture could not keep, and
 * produced a failure nobody could read: two providers whose tables disagreed
 * about an address resolved it to NO roles, and a credential with no roles is
 * refused, so adding a second provider logged every agent out with a 401.
 *
 * Deliberately NOT group- or claim-based, for the same reason: Horizon holds a
 * username at re-resolution time, no ID token and no claims, and nowhere to
 * have stored them. Group mapping needs a persistent store this server does
 * without. The mapping has to be a pure function of the address.
 *
 * Who may sign in AT ALL is still per-provider — see `allowedDomains`. That is
 * authentication; this is authorization.
 */
const ssoRolesSchema = z
  .object({
    /** Roles for anyone an SSO provider authenticates, before the overrides.
     *  `viewer` deliberately: an external identity provider says who someone
     *  is, never what they may do here. */
    defaultRoles: z.array(z.string().min(1)).default(['viewer']),
    /** Exact address wins over its domain, which wins over `defaultRoles`. */
    roleByEmail: z.record(z.string(), z.array(z.string().min(1))).default({}),
    roleByDomain: z.record(z.string(), z.array(z.string().min(1))).default({}),
  })
  .strict()
  .default({ defaultRoles: ['viewer'], roleByEmail: {}, roleByDomain: {} });

const ssoSchema = z
  .object({
    /** Sign-in providers. Empty (the default) means no buttons and no OIDC
     *  routes doing anything — password login is unaffected either way.
     *  A provider says HOW someone proves who they are; what they may then do
     *  is `roles` below, which is deliberately not per-provider. */
    providers: z.array(ssoProviderSchema).default([]),
    roles: ssoRolesSchema,
  })
  .strict()
  .default({});

const authSchema = z
  .object({
    /** Active auth backend. Switching to `ldap` causes `auth.local` to be
     *  ignored (a warning is logged at startup if both are populated). */
    backend: z.enum(['local', 'ldap']).default('local'),
    local: z
      .object({
        users: z.array(localUserSchema).default([]),
      })
      .strict()
      .default({ users: [] }),
    ldap: ldapSchema.optional(),
    /** Optional break-glass account, only honored when `backend: 'ldap'`
     *  AND the LDAP probe is currently failing. Logged loudly in the
     *  server log on every use. */
    breakGlass: breakGlassSchema.optional(),
    /**
     * Single sign-on, ADDITIVE to `backend` rather than replacing it.
     *
     * Deliberately not a third `backend` value: an operator who adds Google
     * still wants the local break-glass account to work, and making SSO
     * exclusive is how a misconfigured provider locks everyone out of their
     * own observability during an incident.
     */
    sso: ssoSchema,
    /** Path to a JSON file of API tokens — the non-browser credential, for
     *  scripts, CI and MCP clients. A path rather than inline values because
     *  `horizon.yaml` is committed and holds no secrets, and because a token
     *  list grows per operator, which suits a mounted Secret. Empty disables
     *  token auth entirely; a token names a USER, and roles resolve from that
     *  user per request, so a token can never outlive their access. */
    tokensFile: z.string().default(''),
  })
  .strict()
  .default({ backend: 'local', local: { users: [] } });

/** An IP literal or a CIDR block, which is all Fastify's `trustProxy` accepts
 *  in string form. Kept here so a bad value is refused where it was written. */
function isIpOrCidr(value: string): boolean {
  const [addr, bits, ...rest] = value.split('/');
  if (rest.length > 0 || !addr) return false;
  const version = isIP(addr);
  if (version === 0) return false;
  if (bits === undefined) return true;
  if (!/^\d+$/.test(bits)) return false;
  const n = Number(bits);
  return n >= 0 && n <= (version === 4 ? 32 : 128);
}

/** A CIDR whose prefix length is zero: every address matches it. */
function matchesEveryAddress(value: string): boolean {
  const [addr, bits] = value.split('/');
  return bits !== undefined && Number(bits) === 0 && isIP(addr ?? '') !== 0;
}

const rbacSchema = z
  .object({
    /** When false, every authenticated session is granted `*`. */
    enabled: z.boolean().default(true),
    roles: z
      .record(z.string(), z.array(z.string().min(1)))
      .default({
        // Data catalog + the read-only inspect tools (metric / trace / log
        // inspect, all `inspect:read`). Deliberately NOT `*:read` so a viewer
        // can't see rule definitions, live-debug sessions, setup screens, or
        // cluster / TTL / config internals.
        viewer: [
          'metrics:read',
          'alarms:read',
          'events:read',
          'traces:read',
          'logs:read',
          'browser-errors:read',
          'inspect:read',
          'topology:read',
          'profile:read',
          'overview:read',
          'infra-3d:read',
          'ai:read',
          'mcp:read',
        ],
        // Viewer baseline plus the platform-monitoring reads (cluster
        // health + OAP internals). Maintainer's whole job is watching
        // SkyWalking itself.
        maintainer: [
          'metrics:read',
          'alarms:read',
          'events:read',
          'traces:read',
          'logs:read',
          'browser-errors:read',
          'topology:read',
          'profile:read',
          'overview:read',
          'cluster:read',
          'inspect:read',
          'ttl:read',
          'config:read',
          'infra-3d:read',
          'ai:read',
          'mcp:read',
        ],
        // Configures observability: dashboards, alarm rules, DSL/OAL,
        // diagnostics. Inherits viewer + platform reads so operators
        // can verify their changes against live data. No reserved verb is
        // granted here (see RESERVED_VERBS): granting one promises a
        // capability now and silently confers it the day something enforces it.
        operator: [
          'metrics:read',
          'alarms:read',
          'events:read',
          'traces:read',
          'logs:read',
          'browser-errors:read',
          'source-map:write',
          'topology:read',
          'profile:read',
          'cluster:read',
          'inspect:read',
          'ttl:read',
          'config:read',
          'overview:read',
          'overview:write',
          'setup:read',
          'dashboard:read',
          'dashboard:write',
          'alarm-setup:read',
          'alarm-rule:read',
          'infra-3d:read',
          'rule:read',
          'rule:write',
          'rule:write:structural',
          'rule:delete',
          'live-debug:read',
          'live-debug:write',
          'profile:enable',
          'ai:read',
          'mcp:read',
        ],
        admin: ['*'],
      }),
    /** Landing route per role; the UI uses this to send users to the
     *  page that fits their job after login. Cluster status lives at
     *  `/operate/cluster` (operator tooling against OAP). */
    landingByRole: z
      .record(z.string(), z.string())
      .default({
        viewer: '/',
        maintainer: '/operate/cluster',
        operator: '/',
        admin: '/operate/cluster',
      }),
  })
  .strict()
  .default({});

const sessionSchema = z
  .object({
    ttlMinutes: z.number().int().positive().default(60),
    cookieName: z.string().default('horizon_sid'),
    cookieSecure: z.boolean().default(false),
  })
  .strict()
  .default({ ttlMinutes: 60, cookieName: 'horizon_sid', cookieSecure: false });

// Env-var-overridable defaults for the four state-file paths. The
// Docker image sets `HORIZON_*_FILE=/data/...` so an operator running
// the published image without a custom `horizon.yaml` (or with one
// that omits these blocks) gets writes routed to the writable `/data`
// volume instead of `/app` (which is root-owned and EACCESes).
const wireLogDefault = process.env.HORIZON_WIRE_LOG_FILE ?? './horizon-wire.jsonl';


const debugLogSchema = z
  .object({
    enabled: z.boolean().default(false),
    file: z.string().default(wireLogDefault),
    maxBodyChars: z.number().int().nonnegative().default(8192),
    redactAuthHeaders: z.boolean().default(true),
  })
  .strict()
  .default({
    enabled: false,
    file: wireLogDefault,
    maxBodyChars: 8192,
    redactAuthHeaders: true,
  });

const querySchema = z
  .object({
    /** Max services a layer landing runs metric MQE for, per request. The
     *  landing always lists ALL services, but only fetches column metrics
     *  for up to this many — the TRUE top-N by the landing's `orderBy`
     *  column (a cheap single-metric ranking pass picks them when a layer
     *  exceeds the cap). The UI surfaces "top N of M" whenever the cap
     *  bites, so nothing is silently dropped. Raise it if your OAP +
     *  storage backend can take the larger fan-out; lower it to protect a
     *  modest deployment. Default 100. */
    landingServiceCap: z.number().int().positive().default(100),
    /** N for the Overview KPI tiles' self-aggregating MQE. Each tile column
     *  is `sum|avg(top_n(<metric>,{{topn}},DES[,attr0='<layer>']))` — the
     *  layer-wide rollup happens SERVER-SIDE via OAP's `top_n`, so the BFF
     *  substitutes this into the `{{topn}}` placeholder before firing (one
     *  global query per tile, no per-service fan-out). 100 covers every
     *  layer on a normal deployment; raise it only if a single layer holds
     *  more than 100 services and the tail matters to the aggregate. */
    overviewTopN: z.number().int().positive().default(100),
  })
  .strict()
  .default({ landingServiceCap: 100, overviewTopN: 100 });

// JS source maps for de-obfuscating BROWSER-layer error stacks (#6784).
// Maps live in the BFF process heap — there is NO OAP-side storage — so
// the budgets below bound a per-instance, intentionally-ephemeral cache.
// `HORIZON_SOURCEMAPS_DIR` is set by the Docker image to /app/sourcemaps
// so a mounted maps directory is picked up with zero YAML.
const sourceMapsDirDefault = process.env.HORIZON_SOURCEMAPS_DIR ?? '';
const sourceMapsSchema = z
  .object({
    /** Master switch for the upload / static-mount / resolve capability.
     *  When false the Browser Errors tab still lists errors, but the map
     *  controls are hidden and the source-map routes reject. */
    enabled: z.boolean().default(true),
    /** Reject any single `.map` larger than this (upload or mount). Maps
     *  carrying `sourcesContent` are commonly 5–40 MiB; large bundles run
     *  bigger. Default 64 MiB. */
    maxFileBytes: z.number().int().positive().default(64 * 1024 * 1024),
    /** Budget for the resident UPLOADED maps (raw `.map` bytes in the Node
     *  heap). An upload bigger than this is rejected; past it, least-recently-
     *  used uploads are evicted. A small parsed-map cache rides on top
     *  (bounded by count + this budget), so plan ~2x headroom; mounted maps
     *  are disk-backed and don't count. Lowering it trims on the next
     *  upload / resolve / list. Default 512 MiB. */
    maxTotalBytes: z.number().int().positive().default(512 * 1024 * 1024),
    /** Cap on the NUMBER of maps held, independent of bytes — bounds the
     *  in-memory uploaded set (LRU-evicted past it) and the count of
     *  statically-mounted maps indexed at boot (the rest are skipped).
     *  Default 128. */
    maxFileCount: z.number().int().positive().default(128),
    /** Directory scanned at boot for statically-provisioned `.map` files
     *  (Docker/k8s mount). Disk-backed: evictable from memory but reloaded
     *  on demand, so they survive restarts and aren't deletable from the
     *  UI. Empty disables the static mount. */
    bootMountDir: z.string().default(sourceMapsDirDefault),
  })
  .strict()
  .default({});

// AI assistant (chat/LLM). OFF by default. Transport-pluggable + vendor-neutral:
// the DEFAULT is `openai-compatible` (any OpenAI-shaped endpoint — OpenAI,
// DeepSeek-direct, local models, AI gateways, Azure-OpenAI, or Claude behind a
// gateway), configured with just model + baseUrl + apiKey. `provider` is only
// set for a non-OpenAI-shaped SERVICE — today `bedrock` (AWS Converse + bearer).
// The API key is a SECRET: set it via `${HORIZON_AI_API_KEY:}` env interpolation
// only — never inline in the YAML — and it is redacted from logs.
// Env-overridable defaults let a file-less container enable the
// feature with `HORIZON_AI_*` alone (mirrors sourceMaps / templates.mode).
const aiEnabledDefault = process.env.HORIZON_AI_ENABLED === 'true';
const aiProviderDefault: 'openai-compatible' | 'bedrock' =
  process.env.HORIZON_AI_PROVIDER === 'bedrock' ? 'bedrock' : 'openai-compatible';
const aiModelDefault = process.env.HORIZON_AI_MODEL ?? '';
const aiBaseUrlDefault = process.env.HORIZON_AI_BASE_URL ?? '';
const aiRegionDefault = process.env.HORIZON_AI_REGION ?? '';
const aiApiKeyDefault = process.env.HORIZON_AI_API_KEY ?? '';
// Client IndexedDB conversation-history cap (MB); server-side history is a future mode.
const aiHistoryMaxMbDefault = ((): number => {
  const n = Number(process.env.HORIZON_AI_HISTORY_MAX_MB);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
})();
const aiSchema = z
  .object({
    /** Master switch. When false, the chat route rejects (503) and the UI
     *  launcher is hidden — no provider is ever constructed. */
    enabled: z.boolean().default(aiEnabledDefault),
    /** Transport. `openai-compatible` (default) = any OpenAI-shaped endpoint via
     *  `baseUrl` (OpenAI, DeepSeek-direct, local models, gateways, Claude behind
     *  a gateway); `bedrock` = Amazon Bedrock Converse (needs a Bedrock model
     *  id + a Bedrock bearer key; region can come from AWS env/config). Set
     *  `provider` only for a non-OpenAI-shaped service. */
    provider: z.enum(['openai-compatible', 'bedrock']).default(aiProviderDefault),
    /** Model id. For `bedrock` this MUST be the Bedrock / inference-profile id
     *  (e.g. `deepseek.v3.2`, `us.anthropic.claude-...`), NOT the bare Anthropic
     *  id — do not auto-prefix, the operator/user supplies the exact id. */
    model: z.string().default(aiModelDefault),
    /** OpenAI-compatible base URL. Used only when `provider: 'openai-compatible'`. */
    baseUrl: z.string().default(aiBaseUrlDefault),
    /** AWS region for `provider: 'bedrock'`. OPTIONAL — leave blank to read it
     *  from AWS_REGION / AWS_DEFAULT_REGION in the environment. Set it only to
     *  pin a region in Horizon config. */
    region: z.string().default(aiRegionDefault),
    /** SECRET — env-only (`${HORIZON_AI_API_KEY:}`). For `bedrock` this is the
     *  Bedrock bearer API key (ABSK…). Redacted from logs. */
    apiKey: z.string().default(aiApiKeyDefault),
    // Inference params (temperature, output-token caps) are deliberately NOT
    // config knobs — the gateway / provider / model owns them. The agent fixes
    // temperature at 0 internally for tool-calling determinism.
    /** OVERRIDE the bundled system prompt. Empty → use the shipped default.
     *  Best set as a YAML block scalar (multi-line); `${HORIZON_AI_SYSTEM_PROMPT}`
     *  also works for a single-line override. */
    systemPrompt: z.string().default(''),
    /** OVERRIDE the bundled starter prompts (the chat's example chips). Empty →
     *  use the shipped defaults. Each string is one starter shown to the user. */
    starters: z.array(z.string().min(1)).default([]),
    /** Client IndexedDB conversation-history cap (MB). */
    history: z
      .object({ maxMb: z.number().int().positive().default(aiHistoryMaxMbDefault) })
      .strict()
      .default({}),
  })
  .strict()
  .default({});

// MCP — external agents (Claude Code, Codex, Claude Desktop, …) reading
// Horizon through the Model Context Protocol. Deliberately NOT nested under
// `ai`: that block configures the model Horizon TALKS TO for its own assistant,
// while MCP leaves the model on the caller's side entirely. Enabling one has
// nothing to do with the other, and a deployment with no provider configured at
// all can still serve MCP.
//
// ON by default, because it is not a new exposure: `/api/mcp` requires the same
// login as every other route, is gated by `mcp:read`, and each tool re-checks
// its own read verb. An agent sees exactly what the operator it authenticated
// as can already see in a browser.
const mcpSchema = z
  .object({
    enabled: z.boolean().default(process.env.HORIZON_MCP_ENABLED !== 'false'),
    /**
     * What this deployment calls itself to an agent.
     *
     * An operator watching production and staging connects BOTH, and every
     * Horizon otherwise introduces itself with the same name and the same
     * instructions — so an answer does not say which system it came from, and
     * a model holding two can attribute one's data to the other. Naming the
     * deployment server-side fixes that for the agent, independently of
     * whatever the operator happened to call the connection on their end.
     *
     * Defaults to the host of `server.publicUrl`, which is already the one
     * value that distinguishes deployments, so most get this for free.
     */
    name: z.string().default(process.env.HORIZON_MCP_NAME ?? ''),
  })
  .strict()
  .default({});

// OAuth — Horizon issuing tokens, which is a different thing from Horizon
// verifying who you are (`auth.*`). This block makes Horizon an OAuth 2.1
// authorization server so an MCP client can send its user through a browser
// login instead of being handed a secret out of band.
//
// OFF by default, and the only piece of this feature that is. Everything else
// MCP added is another client of routes that already existed; an authorization
// server is genuinely new surface — dynamic client registration is an
// unauthenticated endpoint by spec, and issued tokens outlive browser sessions.
// On an internal deployment reached only from Claude Code or Codex, the API
// token in `auth.tokensFile` may be all anyone needs.
const oauthSchema = z
  .object({
    enabled: z.boolean().default(process.env.HORIZON_OAUTH_ENABLED === 'true'),
    /** SECRET — env-only. HMAC key over every issued value. Rotating it
     *  invalidates every outstanding token and client registration at once,
     *  which is the only bulk revocation a store-less server can offer. */
    signingKey: z.string().default(process.env.HORIZON_OAUTH_SIGNING_KEY ?? ''),
    /** The PUBLIC base URL clients reach Horizon at. Defaults to
     *  `server.publicUrl`; set here only to advertise an issuer that differs
     *  from it. Required (via one or the other) when enabled, and deliberately
     *  never derived from the Host header: discovery metadata tells a client
     *  where to send its user to log in, so letting a request header decide
     *  that would let anyone who can set Host point the login elsewhere. */
    issuer: z.string().default(process.env.HORIZON_OAUTH_ISSUER ?? ''),
    accessTokenMinutes: z.number().int().positive().default(60),
    /** 0 disables refresh tokens — every expiry then sends the user back
     *  through the browser. */
    refreshTokenDays: z.number().int().nonnegative().default(30),
    /**
     * Hosts whose Client ID Metadata Documents this server will fetch.
     *
     * A client may identify by URL instead of registering (Claude Code does),
     * which means this server fetches a URL an unauthenticated caller chose.
     * Every such fetch is https-only, refused for any non-public resolved
     * address, un-redirected, bounded and timed out — but on a locked-down
     * deployment you may want it narrower still. Empty means "any public
     * host"; a list confines it, e.g. ["claude.ai", "anthropic.com"].
     */
    clientMetadataHosts: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .default({});

// in the UI (an excluded layer simply doesn't appear).
// Layers hidden from the sidebar / menu even when OAP reports them in
// `listLayers`. An operator can clear `excluded` to surface every reported
// layer, or add keys for internal-only layers they don't want on the menu.
// The `reason` is documentation for whoever reads this file — it isn't shown
const excludedLayerSchema = z
  .object({
    /** OAP layer key (UPPER_SNAKE), matched case-insensitively. */
    key: z.string().min(1),
    /** Why it's hidden — operator-facing note, not surfaced in the UI. */
    reason: z.string().optional(),
  })
  .strict();
const DEFAULT_EXCLUDED_LAYERS = [
  { key: 'FAAS', reason: 'Deprecated.' },
  { key: 'VIRTUAL_GATEWAY', reason: 'Not planned to set up.' },
];
const layersSchema = z
  .object({
    excluded: z.array(excludedLayerSchema).default(DEFAULT_EXCLUDED_LAYERS),
  })
  .strict()
  .default({ excluded: DEFAULT_EXCLUDED_LAYERS });

// ────────────────────────────────────────────────────────────────────
// Performance / behavior tuning — how hard the BFF fans queries out to
// OAP, plus the render / fetch caps that protect storage. OPERATIONAL,
// per-deployment, hot-reloaded — NOT dashboard content (those live in
// templates published to OAP). Defaults equal the built-in values, so
// omitting this block changes nothing. Most values carry a `.max()`, and it
// REJECTS rather than clamps: a number above the ceiling fails validation, so
// it exits at boot or bounces the whole reload — it is not pulled down to the
// limit. `topologyMaxNodes` / `topologyMaxEdges` have no ceiling on purpose,
// because a genuinely large graph is a reason to raise them.
const performanceSchema = z
  .object({
    bulk: z
      .object({
        // Service-map family routes (topology / instance-topology /
        // deployment / endpoint-dependency). `*BulkSize` = aliased MQE
        // fragments per OAP request; `concurrency` = parallel requests.
        topology: z
          .object({
            nodeBulkSize: z.number().int().min(1).max(500).default(150),
            edgeBulkSize: z.number().int().min(1).max(500).default(200),
            concurrency: z.number().int().min(1).max(16).default(4),
          })
          .strict()
          .default({}),
        // 3D infrastructure-map metric fan-out.
        infra3d: z
          .object({
            metricBulkSize: z.number().int().min(1).max(12).default(6),
            metricConcurrency: z.number().int().min(1).max(8).default(4),
            topologyConcurrency: z.number().int().min(1).max(16).default(4),
            templateConcurrency: z.number().int().min(1).max(32).default(8),
          })
          .strict()
          .default({}),
        // Per-layer landing: metric columns fetched in service batches.
        landing: z
          .object({
            bulkSize: z.number().int().min(1).max(12).default(6),
            concurrency: z.number().int().min(1).max(16).default(8),
          })
          .strict()
          .default({}),
        // Dashboard widget metric fan-out.
        dashboard: z
          .object({
            bulkSize: z.number().int().min(1).max(12).default(6),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    limits: z
      .object({
        // Service-map render valve: a graph larger than this is rejected
        // with a "narrow the scope" notice rather than drawn unreadably.
        topologyMaxNodes: z.number().int().positive().default(5000),
        topologyMaxEdges: z.number().int().positive().default(15000),
        // Max rows one page of each event list DISPLAYS — NOT a page count,
        // and not the storage LIMIT to the row: every read fetches one row
        // past the page it shows, which is the only way to know a next page
        // exists (page 1 asks for size + 1; later pages ask for the page and
        // a one-row probe beside it). The UI page-size picker maxes at the
        // same value, so a client can't out-ask the dropdown.
        maxPageSize: z
          .object({
            traces: z.number().int().min(1).max(500).default(100),
            logs: z.number().int().min(1).max(500).default(100),
            browserLogs: z.number().int().min(1).max(500).default(100),
            // Events are grouped client-side (one deploy = many per-instance
            // rows), so we fetch a deeper raw page than the other feeds.
            events: z.number().int().min(1).max(500).default(200),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
  })
  .strict()
  .default({});

// Template source mode — LOAD-BEARING, see CLAUDE.md "Template source".
//
// `live` (default) uses OAP 11's `/ui-management/templates*` REST API and the
// OAP-stored row is the ONLY source: an unreachable store BLOCKS the route
// rather than substituting the disk bundle, so an operator never sees shipped
// defaults presented as their own configuration.
// `readonly` renders from the local disk bundle and never calls a
// template-management API. That plus bundled PREVIEW in the admin editor are
// the only two doors the bundle reaches the runtime through.
// OAP 10 has a legacy GraphQL template API which Horizon does not consume, so
// an OAP 10.x REQUIRES `readonly` — Horizon will not fall back on its behalf.
// The OAP query API is still used + boot-checked in either mode.
// Env-overridable so a file-less container can pick the mode.
const templatesModeDefault: 'live' | 'readonly' =
  process.env.HORIZON_TEMPLATES_MODE === 'readonly' ? 'readonly' : 'live';
const templatesSchema = z
  .object({
    mode: z.enum(['live', 'readonly']).default(templatesModeDefault),
  })
  .strict()
  .default({ mode: templatesModeDefault });

/** Hosts a template's outbound link may point at. Horizon is a closed
 *  console: the only operator-supplied link is a layer template's
 *  `documentLink` ("docs ↗" in the layer header), and it may only leave the
 *  origin for a host listed here.
 *
 *  The default carries the project's own documentation domain because all 44
 *  bundled layer templates link there — it is a DEFAULT, not a built-in
 *  exemption, so an operator who wants a fully closed console sets this to
 *  `[]` and every outbound link stops rendering. Add your own wiki here.
 *
 *  A site-relative link (`/runbook/…`) never needs listing; it does not leave
 *  the origin. Non-http(s) schemes are refused outright, wherever they come
 *  from — that check is not configurable. */
const TRUSTED_LINK_DOMAINS_DEFAULT = ['skywalking.apache.org'];

const securitySchema = z
  .object({
    // Hostnames, not URLs or patterns. A value with a scheme, a path, a port
    // or a wildcard would never match — `new URL(...).hostname` is what it is
    // compared against — so it is refused at boot rather than silently
    // matching nothing, which would read as "the allow-list is not working".
    trustedLinkDomains: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .refine((v) => /^[a-z0-9.-]+$/.test(v) && !v.startsWith('.') && !v.endsWith('.'), {
            message:
              'must be a bare hostname such as "wiki.internal" — no scheme, port, path or wildcard (a host matches itself and its subdomains)',
          }),
      )
      .default(TRUSTED_LINK_DOMAINS_DEFAULT),
  })
  .strict()
  .default({ trustedLinkDomains: TRUSTED_LINK_DOMAINS_DEFAULT });

export const configSchema = z
  .object({
    server: serverSchema.default({}),
    layers: layersSchema,
    templates: templatesSchema,
    security: securitySchema,
    oap: oapSchema.default({}),
    auth: authSchema,
    rbac: rbacSchema,
    session: sessionSchema,
    debugLog: debugLogSchema,
    query: querySchema,
    sourceMaps: sourceMapsSchema,
    ai: aiSchema,
    mcp: mcpSchema,
    oauth: oauthSchema,
    audit: auditSchema,
    performance: performanceSchema,
    // Deprecated + ignored. The 3D-map config moved to OAP (a template kind);
    // the old file-backed `infra3d.file` knob is gone. Accepted here (rather
    // than rejected by `.strict()`) so an existing config carrying the block
    // still boots — the value is unused.
    infra3d: z.unknown().optional(),
  })
  .strict();

export type HorizonConfig = z.infer<typeof configSchema>;
export type AiConfig = z.infer<typeof aiSchema>;
export type McpConfig = z.infer<typeof mcpSchema>;
export type OAuthConfig = z.infer<typeof oauthSchema>;
export type TemplatesConfig = z.infer<typeof templatesSchema>;
export type SourceMapsConfig = z.infer<typeof sourceMapsSchema>;
export type LdapConfig = z.infer<typeof ldapSchema>;
export type LocalUser = z.infer<typeof localUserSchema>;
export type BreakGlassConfig = z.infer<typeof breakGlassSchema>;

// Re-exported so every existing importer keeps one place to reach for.
export { auditConfigProblem } from './audit.js';
export type { AuditConfig, AuditPostgresConfig } from './audit.js';
