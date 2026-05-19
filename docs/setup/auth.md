# auth

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

See [Break-Glass Access](../access-control/break-glass.md) for the trigger conditions and audit behavior.

## Bootstrap validation summary

| Condition | Result |
|---|---|
| `backend: local` and `local.users` empty | startup warning; login rejected until a user is configured |
| `backend: ldap` and `ldap` missing | startup warning; login rejected until LDAP is configured |
| `backend: ldap` and `ldap.groupMappings` empty | startup warning; login rejected until a mapping is configured |
| `backend: ldap` and `local.users` populated | warning at startup |
| `breakGlass` populated but `backend: local` | warning at startup (block is unused in local mode) |
