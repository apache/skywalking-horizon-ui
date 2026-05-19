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

## Login flow

`apps/bff/src/user/ldap.ts`:

1. **Service bind** (if `bindDn` is set) or anonymous bind. Used to search for the user's DN.
2. **User search** — apply `userFilter` against `userBaseDn`, substituting `{username}` (RFC 4515 escaped). Expect exactly one result; multiple matches abort with `null`.
3. **User bind** — bind directly as the discovered DN with the typed password. A successful bind proves the password.
4. **Group resolution** — per `groupStrategy`:
   - `memberOf`: read the `memberOf` attribute from the user entry (AD-style).
   - `search`: search `groupBaseDn` for groups whose `memberAttr` contains the user's DN (OpenLDAP-style).
5. **Group → role mapping** — walk `groupMappings` in order. **First match wins per mapping** (a user matching multiple mappings gets the union of their roles).
6. Return `{ username, roles }` on success, `null` on any failure.

A failure at any step returns `null` — the UI shows a generic "Invalid credentials" message. No information leak about which step failed.

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
| `search` | OpenLDAP deployments where users do not carry `memberOf`. Requires `groupBaseDn` and uses `memberAttr` (usually `member` or `uniqueMember`). |

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

## Health probing

The BFF exposes `GET /api/auth/health` (polled by the login page every 5 seconds):

- `local`: backend is local — returns `reachable: true` unconditionally.
- `ldap reachable`: last LDAP probe succeeded.
- `ldap unreachable`: last probe failed.

The health probe runs:

1. TCP / TLS connect to `ldap.url`.
2. Service bind (or anonymous bind).
3. (Optional username resolver) A test search for a known username when invoked from the admin Auth Status page.

Probe failure is the trigger condition for [Break-Glass Access](break-glass.md).

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
| Trace a login failure | Audit log entry (`auth.login`, outcome `failure`) carries source IP and timestamp. No password is logged. For LDAP-side debugging, enable LDAP server logging on your directory. |

## Wire-up to OAP

OAP does **not** see Horizon's LDAP credentials. The user authenticates against the directory at the Horizon layer; OAP receives requests with whatever credentials are set in `oap.auth` (typically a single service account). See [Setup → oap](../setup/oap.md).

## Common mistakes

- **Service bind fails silently.** Wrong `bindDn` or `bindPassword` causes all logins to fail with a generic message. Verify by looking at LDAP server logs.
- **`groupStrategy: memberOf` on a directory that doesn't populate it.** Logins succeed but every user gets only the `"*"` fallback role. Switch to `search`.
- **Forgetting the `"*"` fallback.** A user who authenticates but matches no group mapping is rejected — change to `null` and the UI shows "Invalid credentials". Add `"*" → viewer` for graceful degradation.
- **`tlsInsecure: true` in production.** A man-in-the-middle on the LDAP connection can capture every typed password. Use proper certificates instead.
