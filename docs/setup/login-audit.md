# Login audit

Horizon can keep a durable record of **who signed in, when, and from where**. It is optional, off by default, and backed by a shared database rather than a file — one page under one permission, readable by an administrator.

It records sign-ins, not changes. "Who changed what" is not this feature: template and rule edits land in OAP's own records.

## What is recorded, and what deliberately is not

**Only what a valid credential produced.** That is the rule the whole feature is shaped around, and it has a security reason: Horizon can face the internet, and this feature adds no rate limit. If an unauthenticated caller could cause a row, they could fill your database from a laptop.

So a row exists for:

- every **successful** sign-in — password, LDAP, break-glass, single sign-on;
- every **use of a token**, counted per hour rather than one row per request — per credential for an API token, and per **person** for an OAuth token (see below);
- exactly **two refusals**, both of which happen *after* authentication has already succeeded:
  - the account authenticated but has no roles;
  - the LDAP account authenticated but matched no group mapping.

Everything else stays in the application log: a wrong password, an unknown user, an unreadable directory, an expired token, a mangled single sign-on callback. Those are the ones an attacker can produce at will, and a log stream that rotates is the right home for that volume.

A refused **password** sign-in is logged at `warn`, which is the shipped production level. The single sign-on and token paths currently log only their upstream failures, so a refused callback or an unusable bearer token leaves no line — if you are relying on those for detection, watch the request logs rather than the application log.

**A deployment using only local accounts records successes only.** No refusal is reachable there — a bad local password is never recorded — so the "Refused" series stays at zero permanently. The page says so, rather than leaving you to wonder.

## What a row holds

| | |
|---|---|
| When | to the second |
| How | password, LDAP, break-glass, single sign-on, API token, OAuth token |
| Who | the login name, the verified email address, an API token's id, or — for an OAuth token — the account it was issued for. "How" says which |
| Roles | what the sign-in granted, comma-separated. Recorded rather than looked up later, because a role table changes and the question is what this person was given at this moment |
| Result | accepted, or refused with the reason |
| From | the client address (see [Addresses behind a proxy](#addresses-behind-a-proxy)) |
| Provider | for single sign-on, which provider proved the identity |
| Recorded by | which Horizon process wrote the row, and its address |

It records the **sign-in**, and nothing about the systems around it: no OAP state, and no configuration detail of the identity provider beyond which one it was.

**An OAuth token is recorded per person, not per credential**, and that is deliberate rather than an omission. Horizon mints a fresh token identifier on every access-token call, so counting by credential would make the table grow with request volume instead of with the number of people using it — a client that refreshes on every request would produce thousands of rows a day on its own. The row therefore names the account the token was issued for. Telling one OAuth client from another is therefore not something this log can do.

**Passwords, tokens, session identifiers and single sign-on exchange material are never recorded.** Neither is the hash a token is verified against. The token *id* is recorded, which names a credential without being one.

**Email addresses appear only for single sign-on**, where the verified address is the identity Horizon uses. Local and LDAP accounts have no email field for Horizon to record.

## Turning it on

```yaml
audit:
  enabled: true
  provider: postgres
  postgres: ${HORIZON_AUDIT_POSTGRES:null}
```

The connection settings are a secret, so supply them through the environment variable as JSON rather than committing a connection string:

```json
{
  "url": "postgres://horizon@db.internal:5432/horizon?sslmode=verify-full",
  "caFile": "/etc/horizon/pg-ca.crt",
  "retentionDays": 90
}
```

**The whole `audit` block takes effect at startup.** Editing it in a live configuration file does not turn the feature on, off, or repoint it — restart Horizon.

Horizon creates its own tables on first connection. If the account may not create tables, set `postgres.autoMigrate: false` and have a DBA create them first: start Horizon once with a privileged account against a scratch database and copy the `CREATE TABLE` / `CREATE INDEX` statements it applies, or grant `CREATE` on the schema for the first boot only.

### TLS is required away from loopback

The records carry usernames, verified email addresses and client addresses. A connection string whose host is not this machine — anything other than `localhost`, `127.0.0.x` or `::1` — must ask for `sslmode=verify-full` (or `verify-ca`), and Horizon refuses to start the feature otherwise. `sslmode=require` is **not** enough: it encrypts without checking who answered, which stops someone listening and not someone impersonating. Use `caFile` when your database presents a certificate from a private authority.

If the database is reached over a network you control — a Postgres in the same Kubernetes namespace, say — you can accept an unencrypted connection deliberately:

```json
{ "url": "postgres://horizon@audit-db:5432/horizon", "allowCleartext": true }
```

It is off by default and has to be named, because `pg` will connect in cleartext without complaint and the records are worth protecting. Turning it on logs a warning naming the host at every start, so nobody inherits the setting without being told.

### Settings

| | default | |
|---|---|---|
| `enabled` | `false` | |
| `provider` | `none` | `none` or `postgres` |
| `maxRowsPerHour` | `1000` | Per Horizon process, per hour. A safety valve, not a throttle |
| `eventBatchRows` | `50` | Sign-ins are written in batches; whichever trigger comes first |
| `eventBatchSeconds` | `15` | |
| `flushIntervalSeconds` | `60` | How often token counts and statistics are written |
| `postgres.retentionDays` | `90` | How long rows are kept |
| `postgres.sweepIntervalMinutes` | `60` | How often expired rows are removed |
| `postgres.poolMax` | `4` | |
| `postgres.allowCleartext` | `false` | Accept an unencrypted connection to a non-loopback host |
| `postgres.autoMigrate` | `true` | Whether Horizon creates its own tables |
| `postgres.connectionTimeoutMs` | `5000` | Background work only — never a sign-in |
| `postgres.statementTimeoutMs` | `1000` | Background work only — never a sign-in |

**A database can never delay a sign-in.** Sign-ins are buffered in memory and written in the background, so the login path never waits on the database at all — an unreachable database is invisible to someone signing in. The cost is that an abrupt crash loses whatever is still buffered: at most `eventBatchRows` rows or `eventBatchSeconds` seconds.

**`maxRowsPerHour` bounds what one Horizon process can add to the table in an hour.** A fifty-person team produces on the order of a hundred rows a *day*, so the default is orders of magnitude of headroom — if it is ever reached, something is wrong and the page tells you. Past the limit, records are dropped rather than queued, and the page shows the count.

## Reading the page

**Admin → Login audit.** Top to bottom: an hourly summary, the filters, then the list.

The summary is stacked by how people signed in, over the last 2, 6 or 12 hours. It is **estimated and per node** — the counts are what each Horizon process tried to record, close to the stored rows without being reconciled against them. The list below is the exact record.

Two things are deliberately *not* drawn as bars, and appear as a note instead when they are non-zero — they describe records that were never written, so charting them beside records that were would read as extra volume:

- records refused by the hourly limit;
- writes whose outcome could not be confirmed, and token uses dropped when a long outage exhausted the in-memory buffers.

**Filters** are the time range, how someone signed in, and who — `Who` by prefix, so the first characters of an opaque token id are enough. There is deliberately nothing else: this page is read, not queried, and every extra predicate is an index to carry and another way to ask the database something slow. The other fields on a row are for reading once you have found it.

The list pages 50 at a time and reports only whether there is more, never a total. Selecting a row expands the investigation fields.

## Permissions

One permission, `audit:read`, and **a wildcard does not include it.** A role granted `"*:read"` gets every other read in Horizon and not this one; the same is true of the read-only scope an MCP client is granted by default. Only the built-in **administrator** role, a bare `"*"`, or the verb named explicitly will do:

```yaml
roles:
  security:
    - "audit:read"
```

That exception exists because the log holds verified email addresses and client addresses, and a read-only integration should not acquire them by side effect.

There is no write permission and no delete: **the log is append and query.** Rows arrive from the sign-in paths and leave only when retention expires them.

## Addresses behind a proxy

By default Horizon records the address it is actually talking to, which behind an ingress or a load balancer is the proxy — so every row would name the same host.

To record the real client, tell Horizon how far to trust `X-Forwarded-For`:

```yaml
server:
  trustProxy: 1              # one proxy in front of Horizon
  # trustProxy: "10.0.0.0/8" # or: the addresses you own
```

A **number** counts hops from the right of the header, and Horizon's own peer counts as one — so a single ingress is `1`. Setting it too high is dangerous: once there is nothing left to skip, the leftmost value wins, and that one is whatever the caller sent. An **address or CIDR** cannot make that mistake, because it stops at the first address you do not own; prefer it when you know your ingress range.

**`true` is refused.** It means "trust the whole header", so any caller could choose the address Horizon writes down — and an address column that looks authoritative while being attacker-chosen is worse than no column at all.

This setting is read once at startup, so changing it needs a restart. It also affects how Horizon builds single sign-on callback URLs; set `server.publicUrl` explicitly and that coupling goes away.

## When the database is unreachable

Sign-ins keep working. That is the point of buffering them.

What happens instead:

- one `error` line when the connection is first lost, naming a sanitised cause, and one `info` line when it comes back, with how long it was down and how much was lost. Not one line per sign-in — a long outage would bury the cause it is trying to surface;
- the page renders an explicit "cannot be reached" state rather than an empty table, because an empty table would claim there is nothing to show when there is;
- records are held in memory and written when the database returns. A long enough outage exhausts that buffer, and the count of what was dropped appears on the page.

## Multiple Horizon replicas

Each process writes its own rows and reports its own health, so the status line at the foot of the page describes **whichever replica answered your request**, not the cluster. The list and the summary read across all of them.
