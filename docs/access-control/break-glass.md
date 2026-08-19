# Break-Glass Access

Emergency local-admin credential that activates **only when LDAP is the active backend and the LDAP probe is currently failing**. Designed for the case where the directory goes down and the only operator account is LDAP-resolved.

## Configure

```yaml
auth:
  backend: ldap
  ldap:
    # ... normal LDAP config ...
  breakGlass:
    username: emergency-admin
    passwordHash: "${HORIZON_BREAK_GLASS_HASH}"
    roles: [admin]
```

## Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `breakGlass.username` | string (min 1) | — | yes (if block present) | Break-glass login name. Choose something not in the directory. |
| `breakGlass.passwordHash` | string (min 1) | — | yes (if block present) | Argon2id hash. Generate via `pnpm --filter bff cli:hash`. |
| `breakGlass.roles` | string[] | `['admin']` | no | Roles granted during a break-glass session. Defaults to admin because the purpose is recovery. |

The block is **optional** — leave it out (or commented) to disable break-glass entirely.

## Activation conditions

Break-glass is honored at login **only when both** are true:

1. `auth.backend: ldap` (the block is unused in local mode — a startup warning is logged if both are present).
2. The directory is unreachable at the moment of login. Horizon probes the directory continuously; "unhealthy" means the most recent probe (connect / bind / search) failed.

When activated:

- The login form accepts `breakGlass.username` + the password matching `breakGlass.passwordHash`.
- The created session carries `breakGlass.roles`.
- A WARN log line is emitted: `auth: break-glass login granted (LDAP unhealthy)`.

When LDAP is healthy again, the break-glass username is rejected at login — even if you type the right password. The session that was already opened during the outage **remains valid** until TTL or explicit logout.

## Verification

- The password is checked with the same Argon2id verification as the local backend.
- **Timing-safe** — a wrong username still incurs the full argon2 cost, so an attacker cannot learn the configured break-glass username from response timing.

## Noticing it

Every successful break-glass login writes a WARN line to the application log:

```
auth: break-glass login granted (LDAP unhealthy)
```

That is the only record, so it is the one to alert on. Wire your log pipeline to surface it — a break-glass login is by definition something that happened because the normal path was broken, and nobody should learn about it by reading logs later.

## Operational guidance

- **Hash, never plaintext.** Never put the bare password in `horizon.yaml`.
- **Use env-var interpolation** for the hash: `passwordHash: "${HORIZON_BREAK_GLASS_HASH}"`. Keeps the literal hash out of files that may end up in version control or backup tarballs.
- **Test the path** before you need it. Block LDAP at the network level (firewall rule, mock unreachable), confirm the login form accepts break-glass, then restore LDAP.
- **Rotate** the break-glass password on a schedule (quarterly is a common cadence). After rotation, verify the new hash loads via the admin Auth Status page.
- **Limit the role list.** The default `[admin]` is appropriate for genuine emergencies, but consider `[operator]` if your team's break-glass needs do not include user / role management.
- **Alert on use.** Any `auth.login.break-glass` event in production should page the on-call channel — break-glass is for outages, and an unexpected use is either someone testing in prod (still worth knowing) or a misuse.

## What break-glass cannot do

- It does **not** work when `backend: local` — local mode has no health failure mode, so the trigger condition cannot be met.
- It does **not** bypass RBAC. The session has whatever roles you grant via `breakGlass.roles`; if you set `[viewer]`, the session can only read.
- It does **not** persist beyond the LDAP outage's session — once LDAP is healthy again, no new break-glass logins succeed. Existing sessions live until TTL.

## Common mistakes

- **`breakGlass` block configured but `backend: local`.** Block is ignored; warning at startup. Either switch to LDAP backend or remove the block.
- **Same `username` as an LDAP user.** Works but is confusing when reading logs. Choose a name not in the directory (e.g., `emergency-admin`, `glass-break`).
- **Hash stored in version-controlled file.** Use `${ENV_VAR}` interpolation instead.
