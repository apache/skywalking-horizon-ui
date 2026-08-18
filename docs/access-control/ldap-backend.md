# LDAP Backend

The LDAP backend authenticates users against an external directory (OpenLDAP, Active Directory, FreeIPA, 389-DS) and derives Horizon roles from LDAP group membership. Passwords are **never stored** by Horizon — login binds as the user with their typed password.

## Activate

```yaml
auth:
  backend: ldap
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
      - { group: "cn=sre,ou=groups,dc=corp", role: operator }
      - { group: "cn=platform,ou=groups,dc=corp", role: maintainer }
      - { group: "*", role: viewer }
```

Bootstrap rule: `ldap.groupMappings` must be non-empty before LDAP users can sign in. The BFF boots and surfaces the setup-required state on the login page, but no LDAP login succeeds until at least one mapping is configured.

## How sign-in works

Horizon never stores or reads stored passwords. A sign-in attempt authenticates **as the user** against the directory with the typed password, so the directory itself decides whether the password is valid. On success, Horizon reads the user's group memberships and maps them to roles via `groupMappings`.

What this means when you configure LDAP:

- **Group membership is read with the service account** (`bindDn`), not the user's own credentials. Many directories deny ordinary users read access to the group subtree, so the **service account must be able to see groups** — otherwise every user falls back to the `*` role.
- **`userFilter` must resolve to a single user.** If it matches more than one entry, the first match is used.
- **Roles are the union of all matching `groupMappings`** — a user in two mapped groups gets both roles' permissions.
- **Failures are deliberately indistinguishable.** A wrong password, a missing user, or no matching group all surface the same "Invalid credentials" message; the specific cause is never revealed to the browser.

## Field reference

See [`auth`](../setup/auth.md) for the field table.

## `userFilter` recipes

| Directory | Filter |
|---|---|
| OpenLDAP / POSIX | `(uid={username})` |
| Active Directory (sAMAccountName) | `(sAMAccountName={username})` |
| Active Directory (UPN) | `(userPrincipalName={username})` |
| Email-as-username | `(mail={username})` |
| Either uid or email | `(\|(uid={username})(mail={username}))` |

`{username}` is the literal placeholder — substituted at runtime with the typed username, escaped per RFC 4515. Do not pre-escape or quote.

## `groupStrategy` choice

| Strategy | When to use |
|---|---|
| `memberOf` | Active Directory and most modern OpenLDAP deployments. User entries carry a `memberOf` multi-valued attribute. Faster (single read, no second search). |
| `search` | OpenLDAP deployments where users do not carry `memberOf`. Requires `groupBaseDn` and uses `memberAttr` (usually `member` or `uniqueMember`). The **service account** (`bindDn`) — not the logging-in user — performs this search, so it must have read access to the group subtree. |

When unsure, try `memberOf` first; if a successful user bind returns no groups, switch to `search`.

## Group mappings

```yaml
groupMappings:
  - { group: "cn=horizon-admin,ou=groups,dc=corp", role: admin }
  - { group: "cn=sre,ou=groups,dc=corp",          role: operator }
  - { group: "cn=platform,ou=groups,dc=corp",     role: maintainer }
  - { group: "*",                                  role: viewer }
```

- **Exact DN match** on `group`, **case-insensitive**.
- `"*"` is a special fallback — matches any authenticated user. Use as the last entry to give everyone at least `viewer`.
- A user matching multiple groups gets the **union** of all matching roles. E.g., a user in both `cn=sre` and `cn=platform` ends up with `operator` and `maintainer` roles (effective verbs are the union of both role's grants).
- Order matters only in the sense of being listed; all matching entries contribute.

## Health and directory reachability

The login page continuously reflects whether the directory is reachable, so operators see an outage before a user reports a failed login. When the directory is unreachable, that state is also what arms [Break-Glass Access](break-glass.md).

The admin **Auth Status** page lets you confirm the connection (and the service bind) and test a username against the live directory — it shows the groups returned and the roles those groups resolve to, without the user needing to sign in. Use it to debug `groupMappings` and to verify the service account can read the group subtree.

## TLS

- `ldaps://` (TLS-on-connect) is the recommended scheme. Default port 636.
- `ldap://` with StartTLS upgrade is not currently supported — use `ldaps://`.
- `tlsInsecure: true` disables certificate validation. **Only for dev with self-signed certs.** Never in production.

If the LDAP server uses a private CA, the BFF process must trust it via the OS / Node trust store. Set `NODE_EXTRA_CA_CERTS=/path/to/ca-bundle.pem` to inject a CA without modifying the system store.

## Operations

| Action | How |
|---|---|
| Add a role grant | Append to `groupMappings`. Hot-reload picks it up; the next **new** session uses the new mapping. Existing sessions keep their captured role list — they pick up changes on re-login. |
| Move a user between LDAP groups | Handled by your LDAP admin tool, not Horizon. Next login resolves the new group set. |
| Test "what roles will user X get?" | Admin → Auth Status page has a **username resolver** — type a username, see the groups returned by LDAP and the resolved Horizon roles. No login required. |
| Trace a login failure | The application log carries a `auth: login rejected` warning with the username, source IP and backend. No password is logged, and the reason stays coarse on purpose — "no such user" and "wrong password" are deliberately indistinguishable, so the log cannot be used to enumerate who exists. For LDAP-side debugging, enable LDAP server logging on your directory. |

## Wire-up to OAP

OAP does **not** see Horizon's LDAP credentials. The user authenticates against the directory at the Horizon layer; OAP receives requests with whatever credentials are set in `oap.auth` (typically a single service account). See [Setup → oap](../setup/oap.md).

## Common mistakes

- **Service bind fails silently.** Wrong `bindDn` or `bindPassword` causes all logins to fail with a generic message. Verify by looking at LDAP server logs.
- **`groupStrategy: memberOf` on a directory that doesn't populate it.** Logins succeed but every user gets only the `"*"` fallback role. Switch to `search`.
- **`search` strategy with a locked-down group subtree.** Group resolution runs on the service account (`bindDn`), so grant *that* account read access to `groupBaseDn`. (The logging-in user does not need it — Horizon never uses the user's own bind for group lookup.)
- **Forgetting the `"*"` fallback.** A user who authenticates but matches no group mapping is rejected — change to `null` and the UI shows "Invalid credentials". Add `"*" → viewer` for graceful degradation.
- **`tlsInsecure: true` in production.** A man-in-the-middle on the LDAP connection can capture every typed password. Use proper certificates instead.
