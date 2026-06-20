# Sessions

HTTP session cookie configuration.

```yaml
session:
  ttlMinutes: 60
  cookieName: horizon_sid
  cookieSecure: false
```

## Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `ttlMinutes` | number | `60` | no | Session lifetime in minutes. Sessions are sliding: each authenticated request extends the session's last-seen time. A session that goes idle for longer than `ttlMinutes` is reaped and the next request returns 401. Positive integer. |
| `cookieName` | string | `horizon_sid` | no | Name of the session cookie. Change only if you are running multiple Horizon instances on the same hostname / different paths and need distinct cookies. |
| `cookieSecure` | boolean | `false` | no | When `true`, cookies carry the `Secure` flag (browser only sends over HTTPS). **Set to `true` in production behind a TLS terminator.** |

## Cookie shape (set on login)

| Attribute | Value | Source |
|---|---|---|
| name | `cookieName` | config |
| value | 256-bit base64url random session id | server |
| `HttpOnly` | always | server |
| `SameSite` | `Strict` | server |
| `Secure` | per `cookieSecure` | config |
| `Path` | `/` | server |

The cookie carries only a session id. The server-side session map holds username, roles, `createdAt`, `lastSeenAt`. Sessions are in-memory only — a BFF restart invalidates every session.

## Session storage

- In-memory `Map<sid, Session>`.
- A background reaper (60 s interval) deletes expired sessions.
- Each authenticated request extends the session's last-seen time (sliding TTL). A few identity-only checks read the session without extending it.

There is **no shared session store** between BFF instances. If you run multiple BFF replicas behind a load balancer, use sticky sessions, or accept that a failover causes a re-login.

## Hot reload

- `ttlMinutes` change applies to **new** sessions. Existing sessions keep their original TTL.
- `cookieName` change applies on next login. Existing sessions become unrecognized (the old cookie name is no longer read) — effectively a forced re-login for already-signed-in users.
- `cookieSecure` change applies on next login.

## Operational notes

- A BFF restart invalidates all sessions. Plan rolling restarts accordingly.
- The session count is exposed on the Admin → Auth Status page (`/admin/auth-status`) as "Active sessions".
- There is no "remember me" / refresh-token mechanism. Sliding TTL is the only extension.
