# Authentication

Authentication backend selection. Detailed per-backend configuration lives under [Access Control](../access-control/local-backend.md); this page is the `horizon.yaml` shape.

## Shape

```yaml
auth:
  backend: local            # or: ldap

  local:
    users:
      - username: admin
        passwordHash: "$argon2id$v=19$..."
        roles: [admin]

  ldap:
    url: ldaps://ldap.corp:636
    bindDn: "cn=horizon,ou=services,dc=corp"
    bindPassword: "${HORIZON_LDAP_BIND_PW}"
    userBaseDn: "ou=people,dc=corp"
    userFilter: "(uid={username})"
    displayNameAttr: cn
    groupStrategy: memberOf
    groupBaseDn: ""
    memberAttr: member
    timeoutMs: 5000
    tlsInsecure: false
    groupMappings:
      - { group: "cn=horizon-admin,ou=groups,dc=corp", role: admin }
      - { group: "*", role: viewer }

  breakGlass:
    username: emergency-admin
    passwordHash: "${HORIZON_BREAK_GLASS_HASH}"
    roles: [admin]
```

## `auth.backend`

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `backend` | enum: `local` \| `ldap` | `local` | no | Active backend. Switching to `ldap` causes the `local` block to be ignored at login time (a warning is logged at startup if both are populated). |

The two blocks are **mutually exclusive at runtime**. Leaving the inactive block populated is allowed (useful for staging — flip the backend without re-typing the other side) but logs a warning.

## `auth.local`

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `local.users` | array | `[]` | required for local login | Array of user objects. Empty means the BFF boots but every local login is rejected. |
| `local.users[].username` | string (min 1) | — | yes | Unique login name. |
| `local.users[].passwordHash` | string (min 1) | — | yes | Argon2id hash. Generate via `pnpm --filter bff cli:hash`. Never store plain passwords. |
| `local.users[].roles` | string[] | `[]` | no | Roles assigned to this user. Empty array means no permissions (sessions still created; UI shows "no access" for everything). |

See [Local Backend](../access-control/local-backend.md) for hash generation and operational notes.

## `auth.ldap`

Required for LDAP login when `backend: ldap`. `groupMappings` must be non-empty before any LDAP user can sign in.

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `ldap.url` | string (min 1) | — | yes | Directory URL. `ldaps://` (TLS) or `ldap://` (plaintext). |
| `ldap.bindDn` | string | `""` | no | Service-account DN for searches. Empty = anonymous bind (only works if the directory permits). |
| `ldap.bindPassword` | string | `""` | no | Service-account password. Use `${VAR}` interpolation. |
| `ldap.userBaseDn` | string (min 1) | — | yes | Base DN for user searches. |
| `ldap.userFilter` | string | `(uid={username})` | no | Search filter template. `{username}` is substituted (RFC 4515 escaped). For Active Directory use `(sAMAccountName={username})`. |
| `ldap.displayNameAttr` | string | `cn` | no | LDAP attribute containing the user's display name. |
| `ldap.groupStrategy` | enum: `memberOf` \| `search` | `memberOf` | no | `memberOf` reads the attribute off the user entry (AD-style). `search` searches `groupBaseDn` for groups containing the user DN (OpenLDAP-style). |
| `ldap.groupBaseDn` | string | `""` | required if `groupStrategy: search` | Base DN for group searches. |
| `ldap.memberAttr` | string | `member` | no | Group attribute listing members. Only used when `groupStrategy: search`. |
| `ldap.timeoutMs` | number | `5000` | no | LDAP bind / search timeout in milliseconds. Positive integer. |
| `ldap.tlsInsecure` | boolean | `false` | no | Skip TLS certificate validation. **Never use in production.** |
| `ldap.groupMappings` | array | `[]` | required for LDAP login | Group DN → Horizon role bindings. Empty means the BFF boots but every LDAP login is rejected. |
| `ldap.groupMappings[].group` | string (min 1) | — | yes | LDAP group DN, or the literal `"*"` (matches any authenticated user — fallback). |
| `ldap.groupMappings[].role` | string (min 1) | — | yes | Horizon role assigned when the user's groups include `group`. First match wins; multiple matches union. |

See [LDAP Backend](../access-control/ldap-backend.md) for the full login flow and operational notes.

## `auth.breakGlass`

Emergency admin credential, honored **only** when `backend: ldap` AND the LDAP probe is currently failing.

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `breakGlass.username` | string (min 1) | — | yes (if block present) | Break-glass login name. |
| `breakGlass.passwordHash` | string (min 1) | — | yes (if block present) | Argon2id hash. |
| `breakGlass.roles` | string[] | `['admin']` | no | Roles granted during the break-glass session. Defaults to admin since the purpose is recovery. |

See [Break-Glass Access](../access-control/break-glass.md) for the trigger conditions and what it logs.

## `auth.tokensFile` — API tokens

Everything above logs a **person** in through a browser. Scripts, CI jobs and AI agents have no browser, and until now their only option was to POST `/api/auth/login` and keep the session cookie alive — which expires mid-run and is awkward to script.

An **API token** is the credential for those callers. It is not tied to any one feature: a token authenticates on **every** route, under exactly the verb policy that route already declares.

```yaml
auth:
  tokensFile: "${HORIZON_AUTH_TOKENS_FILE:}"   # empty disables token auth
```

It is a **path**, not a list of values, for two reasons: `horizon.yaml` is committed and holds no secrets, and a token list grows per caller, which suits a mounted Secret (`0600`) far better than one environment variable.

### Minting one

```
pnpm --filter @skywalking-horizon-ui/bff cli:token sre \
     --label "ci / nightly-report" --days 90 [--roles viewer]
```

It prints the token **once** and the entry to add — it does not write the file, because the file is usually a Secret this process cannot write. That is also why tokens are provisioned by an operator rather than self-served by a user.

The format is deliberately plain — a random secret and its SHA-256 — so Vault, SOPS or four lines of shell can produce it just as well:

```bash
secret=$(openssl rand -base64 24 | tr -d '=+/')
id=$(openssl rand -hex 3)
echo "token: hzn_${id}_${secret}"
echo "hash:  sha256:$(printf %s "$secret" | shasum -a 256 | cut -d' ' -f1)"
```

Use `printf %s`, not `echo` — `echo` appends a newline, producing a valid-looking hash that never matches.

### The file

```json
[
  { "id": "7f3a2b",
    "label": "ci / nightly-report",
    "username": "sre",
    "hash": "sha256:4c1e…",
    "created": "2026-08-17",
    "expires": "2026-11-15" }
]
```

**A token names a user, not a role set.** Roles resolve from that user on every request, so a token can never carry more than its owner currently holds, and removing or disabling the user revokes every token they hold — without editing the file.

An optional `roles` array is a **cap**, intersected with the user's live roles. It narrows a credential (a CI token that only reads) and can never grant a role the user lacks. If the intersection is empty the token is refused.

### Rotation and revocation

The file is **re-read on a 30-second interval**, not watched. Kubernetes replaces a mounted Secret by swapping a symlink, and a file watcher commonly misses that *silently* — for a credential file, a missed update means a revoked token keeps working.

If the file is **deleted or its mount is lost**, every token is refused immediately rather than kept alive — a missing credential file is a revocation, not a hiccup. A file that is present but unreadable (a torn read mid-rotation) keeps serving the last good copy for five minutes and is then dropped.

So revocation is: remove the entry, then wait for propagation. Two things affect how long that takes, and both are outside Horizon:

- A Secret mounted with **`subPath` never updates at all.** Only a pod restart picks it up.
- Normal Secret propagation is roughly a minute (kubelet sync plus cache), *before* Horizon's own 30 seconds.

To revoke faster than the file allows, delete the user or remove their roles. With `backend: local` that takes effect on the next request. With `backend: ldap` a successful role lookup is cached for 30 seconds, so allow for that — a *failed* lookup is never cached, so a directory blip does not extend the window.

### Using one

```
curl -H "Authorization: Bearer hzn_7f3a2b_…" https://horizon.example/api/menu
```

A token names a user, so the server log records the acting **username** exactly as it does for a browser session.

## Single sign-on

Horizon can send people to your identity provider to sign in — Google, Okta, Entra, Keycloak, Auth0, or anything else that speaks OpenID Connect. It is **additive**: password login keeps working alongside it, deliberately, so a misconfigured provider never locks you out of your own observability during an incident.

### Which providers Horizon supports

`kind` names the protocol, and it decides how much Horizon can prove about who signed in.

**`kind: oidc` — anything that speaks OpenID Connect.** There is no per-provider code: given an `issuer`, Horizon reads `<issuer>/.well-known/openid-configuration` for the endpoints and signing keys, verifies the ID token's signature and its nonce, and requires the provider to say the address is verified. Google, Okta, Microsoft Entra ID, Keycloak, Auth0, Authing and Casdoor all work this way, and so does anything else certified — the list is not a whitelist, it is examples.

**`kind: oauth2` — the ones that never adopted OIDC.** No discovery document and no ID token, so you supply the three endpoints by hand and identity comes from a userinfo call. That is a weaker proof and the table below says which of them actually work.

| Protocol | Proof of identity | Config |
|---|---|---|
| `oidc` | Signature over claims, bound to this login by a nonce | `issuer` and Horizon reads the rest |
| `oauth2` | Whatever a userinfo endpoint answers to a bearer token | three endpoints plus `emailPath`, by hand |

Prefer `oidc` wherever the provider offers it. With `oauth2`, a token issued to a *different* application at the same provider answers the userinfo call identically — what protects the flow is that the code is exchanged server-to-server with the client secret, and that `state` and PKCE bind the callback to this browser.

**A provider that returns no email address cannot be used at all**, in either mode: roles resolve from the address, so there is nothing for Horizon to key on. For those, put an identity provider in front — Authing and Casdoor both speak OIDC to Horizon and handle the vendor-specific part themselves, which is how most deployments in China do it.

### What single sign-on needs to work at all

Five things. Miss any of them and the failure is usually a redirect that ends somewhere unhelpful, so it is worth checking them in order.

| | What | Missing it looks like |
|---|---|---|
| 1 | **`server.publicUrl`** — the address people actually browse | The callback is built from the request instead, which is wrong behind any proxy or ingress: logins return to an internal address, or to the wrong port |
| 2 | **A provider entry** with `id` and `clientId` | Config refuses to parse — both are required outright |
| 3 | **`clientSecret`** | Boot logs an **error** naming the provider: it cannot complete a login. The button appears and the exchange fails |
| 4 | **`issuer`** (for `kind: oidc`) or all three endpoints (for `kind: oauth2`) | Config refuses to parse, naming the provider and the field |
| 5 | **The callback registered with the provider**: `<publicUrl>/api/auth/oidc/callback` | The provider refuses before Horizon is ever reached — Google calls it `redirect_uri_mismatch` |

Everything else has a working default. `roles` grants `viewer`; `allowedDomains` empty admits anyone with an account at that provider; `displayName` falls back to the id.

Two that are optional but usually wanted:

- **`allowedDomains`** — empty means the whole internet for a public provider. Right for a demo, almost never right internally.
- **`emailsEndpoint`** — required in practice for GitHub, whose profile reports no address for most accounts. See below.

**One coupling worth knowing before you change provider config.** An [API token](#authtokensfile--api-tokens) whose username is an email address resolves its roles through this block, on every request — so removing a provider, or narrowing `allowedDomains` so it no longer admits that address, revokes those tokens immediately. That is the intended behaviour, and it is also a way to lock out an agent by accident.

There is no per-provider code. Given an `issuer`, Horizon reads `<issuer>/.well-known/openid-configuration` for the endpoints and signing keys, so every OIDC provider is the same handful of fields:

```yaml
auth:
  sso:
    providers:
      - id: google
        displayName: "Google"
        issuer: "https://accounts.google.com"
        clientId: "${HORIZON_OIDC_GOOGLE_CLIENT_ID}"
        clientSecret: "${HORIZON_OIDC_GOOGLE_CLIENT_SECRET}"
        allowedDomains: ["example.com"]
      - id: okta
        displayName: "Okta"
        issuer: "https://acme.okta.com"
        clientId: "${HORIZON_OIDC_OKTA_CLIENT_ID}"
        clientSecret: "${HORIZON_OIDC_OKTA_CLIENT_SECRET}"

    # ONE role table, shared by every provider above.
    roles:
      defaultRoles: ["viewer"]
      roleByEmail:
        sre-lead@example.com: ["operator"]
```

**A provider says how you sign in; `roles` says what you get, and it is not per-provider.** That is a constraint rather than a simplification: roles are re-resolved on every request from a username and nothing else — which is what stops an API token outliving its owner's access — and at that moment there is no record of which provider authenticated it. A per-provider table could never be honoured for a token, so keeping one would let the config promise something that cannot be delivered.

Who may sign in *at all* stays per-provider: that is `allowedDomains`, and it is authentication rather than authorization.

One configured provider becomes a button on the login page; two or more become a picker with an arrow to continue.

### Providers that do not speak OIDC

Some providers never adopted OpenID Connect: no discovery document, no ID token. `kind: oauth2` covers those, where you supply the three endpoints by hand and identity comes from a userinfo call:

```yaml
      - id: github
        displayName: "GitHub"
        kind: oauth2
        clientId: "${HORIZON_OIDC_GITHUB_CLIENT_ID}"
        clientSecret: "${HORIZON_OIDC_GITHUB_CLIENT_SECRET}"
        authorizationEndpoint: "https://github.com/login/oauth/authorize"
        tokenEndpoint: "https://github.com/login/oauth/access_token"
        userinfoEndpoint: "https://api.github.com/user"
        emailsEndpoint: "https://api.github.com/user/emails"   # see below — GitHub needs this
        scopes: ["user:email"]      # the provider's own vocabulary, not OIDC's
        emailPath: "email"          # where the address lives in ITS response
        namePath: "login"           # what to SHOW — GitHub's handle, not the address
```

**`namePath` decides what the signed-in operator is called on screen.** An address is a poor label for a person, and for GitHub it is often not the one colleagues know — `namePath: "login"` shows `wu-sheng` where `name` would show a full name and the default would show the address. This is **display only**: roles and every permission check use the verified address, which stays visible in the tooltip. LDAP has the same control in `auth.ldap.displayNameAttr` (`cn` by default), and an OIDC provider supplies it automatically from its `name` or `preferred_username` claim.

**`emailsEndpoint` is what makes GitHub work for most accounts.** `GET /user` reports the address published on the *public profile*, and returns `null` for everyone who has not published one — which is the default. Point `emailsEndpoint` at a second endpoint whose body is a list of addresses and Horizon reads each entry with the same `emailPath`. An entry marked `primary` wins.

**When `emailsEndpoint` is set it is the only source consulted** — the profile field is not read at all. That order is the security property, not an optimisation: a profile address is usually free text the account holder typed, so letting it win over a checked list would let a stranger type a colleague's address and inherit their roles.

**The address must be affirmed as verified, and Horizon will not start without a way to check.** Roles resolve from the address, and these providers let anyone attach any address to their account and leave it unverified. So a `kind: oauth2` provider must configure one of two things, and a provider that has neither is rejected when the config is parsed:

| | when to use it |
|---|---|
| `emailsEndpoint` | the provider keeps addresses in a list carrying a verification flag (GitHub, Gitee) |
| `emailVerifiedPath` | the verification flag sits on the profile response itself |

Silence is never an affirmation: a missing flag, a `null`, a `0` and the string `"false"` are all refused, so only an explicit affirmative admits an address.

**Which field affirms it is configurable**, because providers disagree. The default is `verified: true`, which GitHub and most others send. Gitee spells it `state: "confirmed"`, so name the field and the value:

```yaml
      - id: gitee
        kind: oauth2
        # …endpoints…
        emailsEndpoint: "https://gitee.com/api/v5/emails"
        scopes: ["user_info", "emails"]
        emailVerifiedPath: "state"        # the field that affirms it
        emailVerifiedValue: "confirmed"   # the value that counts as affirmed
```

`emailPath` is a dot path into whatever JSON that provider returns — `email`, `data.email`, `user.primary_email`. Providers disagree and none of them is wrong; this field is what makes one adapter cover all of them instead of a branch per vendor.

**This is a weaker proof of identity, and worth knowing why.** With OIDC, Horizon verifies a signature over the claims and a nonce, so a token minted for a different application cannot be replayed here. Plain OAuth2 has no such binding: identity is whatever the userinfo endpoint says when handed a bearer token, and a token issued to another application at the same provider answers identically. The compensating controls are that the token is fetched server-to-server with the client secret over TLS, and that `state` and PKCE still bind the callback to this browser and this flow. Prefer `oidc` where the provider offers it.

Missing endpoints are rejected when the config is parsed, not at the first login.

**`kind: oauth2` needs the provider to return an EMAIL from one bearer-token call**, because Horizon keys identity on an address (see the roles section above). That rules some providers out entirely, and it is worth being specific rather than leaving you to discover it:

| Provider | Works? | |
|---|---|---|
| GitHub | yes | needs `emailsEndpoint: https://api.github.com/user/emails` and the `user:email` scope — `/user` alone reports `null` for any account without a published profile address |
| Gitee | shape supported, not verified against a live instance | Use `emailsEndpoint: https://gitee.com/api/v5/emails` with `emailVerifiedPath: state` and `emailVerifiedValue: confirmed`, plus the `emails` scope. Do **not** read the address from `/api/v5/user`: that field is the user-selected *public email* and carries no verification signal at all, and for an account that has hidden its address it is the literal string `未公开邮箱` rather than an address |
| **WeChat** | **no** | Returns `openid`/`unionid` and a profile (nickname, avatar, city) — **no email field exists**. The token is also a query parameter rather than a bearer header, and the call needs an extra `openid` argument. WeCom holds an email but only behind a second, POST-based call with a corp credential, unavailable to third-party apps since June 2022. |
| **DingTalk** | **no** | Its newer flow does return an email, but not from a bearer-token userinfo call in this shape. |
| Feishu / Lark | partly | Its token step does not take a client secret where this adapter puts it. |

For any of the above marked no, put an identity provider in front: **Authing** or **Casdoor** speak OIDC to Horizon and handle the vendor-specific part themselves. That is how most Chinese deployments do it, and it is a better answer than a per-vendor adapter here.

### Button icons

Horizon ships **no vendor logos**, and that is a licensing decision rather than an omission. Google, GitLab and Okta each require prior written permission for their mark; Microsoft's own documentation and its corporate guidelines contradict each other; and none of the major providers' brand terms addresses whether the asset may be redistributed inside a release tarball at all. A recoloured or monochrome substitute breaks the same terms a different way — Google's terms forbid changing the logo's colour.

So a button shows the provider's `displayName` as text, and you may supply an icon yourself:

```yaml
      - id: google
        displayName: "Google"
        icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0i…"
```

A `data:` URI only — never a remote URL (the content-security-policy forbids every remote origin) and never raw SVG markup (it renders through `<img>`, which cannot execute script). If your organisation has permission to use a provider's mark, or you run your own identity provider, this is where its icon goes.

### Two worked examples

These are the shapes of two providers verified end to end against Horizon — one of each `kind`. Secrets come from the environment; never write them into `horizon.yaml`.

**Google, via OIDC.** Three fields, because everything else is discovered from the issuer. Create the credential under **APIs & Services → Credentials → OAuth client ID → Web application** in the Google Cloud console, and add Horizon's callback as an *Authorized redirect URI*:

```yaml
auth:
  sso:
    providers:
      - id: google
        displayName: "Google"
        issuer: "https://accounts.google.com"
        clientId: "${HORIZON_SSO_GOOGLE_CLIENT_ID}"
        clientSecret: "${HORIZON_SSO_GOOGLE_CLIENT_SECRET}"
        allowedDomains: ["your-company.com"]   # omit and ANY Google account can sign in
```

The client id Google issues ends in `.apps.googleusercontent.com`, which is a useful check that you copied the right value.

**GitHub, via plain OAuth2.** No discovery document and no ID token, so the endpoints are written out. Create it under **Settings → Developer settings → OAuth Apps** — an *OAuth App*, not a *GitHub App*; they are different things and only the former does this flow:

```yaml
      - id: github
        displayName: "GitHub"
        kind: oauth2
        clientId: "${HORIZON_SSO_GITHUB_CLIENT_ID}"
        clientSecret: "${HORIZON_SSO_GITHUB_CLIENT_SECRET}"
        authorizationEndpoint: "https://github.com/login/oauth/authorize"
        tokenEndpoint: "https://github.com/login/oauth/access_token"
        userinfoEndpoint: "https://api.github.com/user"
        emailsEndpoint: "https://api.github.com/user/emails"
        scopes: ["user:email"]
        emailPath: "email"
        namePath: "login"          # show the handle colleagues know, not the address
```

`emailsEndpoint` and the `user:email` scope are both required, not optional: `/user` reports `email: null` for any account that has not published an address on its public profile, which is the default, so without them the common GitHub account cannot sign in. It is also what satisfies the verification requirement — its entries carry `verified`.

**One role table serves both**, because roles resolve from the address and a credential carries no record of which provider issued it:

```yaml
    roles:
      defaultRoles: ["viewer"]      # anyone a provider admits, before overrides
      roleByEmail:
        you@your-company.com: ["admin"]
      roleByDomain:
        your-company.com: ["maintainer"]
```

An address nobody names gets `defaultRoles`. Most specific wins: an exact address beats its domain, which beats the default.

### Registering the callback

There is **one** callback for every provider — the provider is identified inside the request, not in the URL — so you register the same address with each of them:

```
https://<your-horizon>/api/auth/oidc/callback
```

Set `server.publicUrl` to the address operators actually reach Horizon at. Without it the callback is derived from each request, which is right for a plain deployment and wrong behind a proxy that rewrites `Host` — the provider then rejects the login with a redirect-URI mismatch.

You do **not** need to register any JavaScript origin. The code exchange is server-to-server; the browser never talks to the provider's token endpoint.

### What an SSO login grants

An identity provider tells Horizon **who** someone is. It never decides what they may do here, so:

- `sso.roles.defaultRoles` is `["viewer"]` unless you say otherwise.
- `allowedDomains` decides who may sign in at all, matched against the **email address the provider reports**. Be careful what that address actually is: signing in with Google reports the *Google account's* address — `@gmail.com` for a personal account, or the organisation's domain only if that organisation runs Google Workspace. A domain that merely receives forwarded mail is not a Google account domain, so restricting to it rejects almost everyone.
- **A subdomain is a different domain.** `corp.com` admits `you@corp.com` and not `you@dev.corp.com`; list every domain you mean. This is deliberate: a public issuer such as Google serves every tenant from one address and tells Horizon nothing about which, so whoever controls DNS for a label under your domain could otherwise verify a tenant on it and inherit your roles. The same exactness applies to `roleByDomain`.
- **Empty means anyone with an account at that provider.** For an internal deployment that is the entire internet and almost never what you want. For a **public demo** it may be exactly right: every visitor gets `viewer`, and each session carries a real identity instead of everyone sharing one published account.
- `sso.roles.roleByEmail` and `sso.roles.roleByDomain` override the default, most specific first. One table covers every provider.

Roles are mapped from the **email address**, not from group or role claims. That is a deliberate constraint, not an omission: Horizon re-resolves a user's roles on every request — that is what stops an API token outliving its owner's access — and at that moment it holds a username and nothing else. Claims exist only during the login itself, and Horizon has nowhere to keep them. Group-based mapping needs a persistent store, which Horizon does not have.

A user with no role after mapping is refused, and the refusal is logged.

**A change to this block reaches an open browser session at the next sign-in, not before.** A session carries the roles it was granted when it was created, so demoting someone, or removing them, leaves any tab they already have open working as it was until they sign out or the session expires. Credentials with no session — an API token, an OAuth token — are the opposite: they re-resolve on every request and stop working immediately. If you need a person out *now*, restart the BFF; that clears every session, because sessions live in memory and nowhere else.

### Troubleshooting

**`redirect_uri_mismatch` from the provider** — what Horizon sent does not byte-match what you registered. Set `server.publicUrl` and register exactly `<publicUrl>/api/auth/oidc/callback`. Providers match exactly: `localhost` and `127.0.0.1` are different, and so is a trailing slash.

**"That email domain is not allowed to sign in here"** — the address is outside `allowedDomains`. Matching is exact, so a subdomain needs its own entry.

**"Your account has no role in Horizon"** — authentication worked, mapping produced nothing. Add a `sso.roles.defaultRoles` or a `roles.roleByDomain` entry.

**"The sign-in provider could not be reached"** — Horizon could not read the discovery document. Check the `issuer` value and that the BFF has outbound access to it.

**Single sign-on failed** — the provider's own reason is in the BFF log (providers name the misconfiguration precisely; the browser deliberately gets a generic message).

## Bootstrap validation summary

| Condition | Result |
|---|---|
| `backend: local` and `local.users` empty | startup warning; login rejected until a user is configured |
| `backend: ldap` and `ldap` missing | startup warning; login rejected until LDAP is configured |
| `backend: ldap` and `ldap.groupMappings` empty | startup warning; login rejected until a mapping is configured |
| `backend: ldap` and `local.users` populated | warning at startup |
| `breakGlass` populated but `backend: local` | warning at startup (block is unused in local mode) |
