# Login audit

Horizon can keep a durable record of **who signed in, when, and from where**. It is optional, off by default, and backed by a shared database rather than a file — one page under one permission, readable by an administrator.

It records sign-ins, not changes. "Who changed what" is not this feature: template and rule edits land in OAP's own records.

## What is recorded, and what deliberately is not

**Only what a valid credential produced.** That is the rule the whole feature is shaped around, and it has a security reason: Horizon can face the internet, and this feature adds no rate limit. If an unauthenticated caller could cause a row, they could fill your database from a laptop.

So a row exists for:

- every **successful** sign-in — password, LDAP, break-glass, single sign-on;
- exactly **two refusals**, both of which happen *after* authentication has already succeeded:
  - the account authenticated but has no roles;
  - the LDAP account authenticated but matched no group mapping.

Everything else stays in the application log: a wrong password, an unknown user, an unreadable directory, an expired token, a mangled single sign-on callback. Those are the ones an attacker can produce at will, and a log stream that rotates is the right home for that volume.

A refused **password** sign-in is logged at `warn`, which is the shipped production level. The single sign-on and token paths currently log only their upstream failures, so a refused callback or an unusable bearer token leaves no line — if you are relying on those for detection, watch the request logs rather than the application log.

**A deployment using only local password accounts records successes only.** Both recordable refusals happen after a directory or an identity provider has already verified someone — no group mapped to a role, or no role for the account — and neither can arise where the only accounts are local ones. A bad local password is never recorded at all. The "Refused" series is therefore flat by design on such a deployment, and a flat line there is not a sign that recording has stopped.

## What a row holds

| | |
|---|---|
| Time | to the second |
| Auth Channel | password, LDAP, break-glass, single sign-on. Single sign-on also names the protocol that proved the identity — **OIDC** means a signed ID token Horizon verified, **OAuth** means an address read from the provider's userinfo call, which is the weaker of the two |
| Provider | for single sign-on, which provider proved the identity — the id you gave it in `auth.sso.providers` |
| Login ID | the login name, or the verified email address on the single sign-on path. "Auth Channel" says which |
| Roles | what the sign-in granted, comma-separated. Recorded rather than looked up later, because a role table changes and the question is what this person was given at this moment |
| Result | accepted, or refused with the reason |
| Client address | where the sign-in came from (see [Addresses behind a proxy](#addresses-behind-a-proxy)) |
| Recorded by | which Horizon process wrote the row, and its address |

**Token use is not recorded here, and that is the boundary the page draws.** Presenting an API token on a request is not a login — nobody signs in — so it produces no audit row. What a token did is a matter of *traffic*, and it is counted on the page's **Token usage** tab instead: one row per token per hour, not one per request. A token that is refused is not counted either, and — as noted above — currently leaves no line anywhere; watch the request logs for those.

It records the **sign-in**, and nothing about the systems around it: no OAP state, and no configuration detail of the identity provider beyond which one it was.

**Passwords, tokens, session identifiers and single sign-on exchange material are never recorded.** Neither is the hash a token is verified against. Where a credential has to be named at all — on the Token usage tab — it is named by its *id*, which identifies a credential without being one.

**Email addresses appear only for single sign-on**, where the verified address is the identity Horizon uses. Local and LDAP accounts have no email field for Horizon to record.

**The protocol is recorded per sign-in, not looked up from the provider afterwards.** A provider can be reconfigured or removed, and the row has to keep saying what was true at the time — the same reason the granted roles are stored rather than re-derived. One provider can also serve both: Okta and Keycloak do OIDC and plain OAuth2 alike, so the vendor's name does not settle how strongly an identity was proven.

**"Recorded by" names the Horizon process and where it can be reached.** The process half changes on every restart, which is what lets replicas count independently without ever colliding. The address half is the pod address when Kubernetes supplies one through `POD_IP`, and otherwise the first external address of the host — set `POD_IP` yourself on a machine with several interfaces, where picking one is a guess. Loopback and link-local addresses are never recorded: neither says where the process can be reached from anywhere else, and a row claiming `127.0.0.1` wrote it is worse than one that leaves the column empty.

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
| `postgres.connectionTimeoutMs` | `5000` | Never on a sign-in — the login path performs no database work at all |
| `postgres.statementTimeoutMs` | `1000` | Never on a sign-in, but it does bound the audit page's own queries — raise it if a wide range times out |

**A database can never delay a sign-in.** Sign-ins are buffered in memory and written in the background, so the login path never waits on the database at all — an unreachable database is invisible to someone signing in. The cost is that an abrupt crash loses whatever is still buffered. While the database is reachable that is small — at most `eventBatchRows` rows or `eventBatchSeconds` seconds, whichever comes first. While it is unreachable, records accumulate in memory instead, up to a 10,000-row ceiling, and a crash then loses however much of that has built up.

**`maxRowsPerHour` bounds what one Horizon process can add to the table in an hour.** A fifty-person team produces on the order of a hundred rows a *day*, so the default is orders of magnitude of headroom — if it is ever reached, something is wrong and the page tells you. Past the limit, records are dropped rather than queued, and the page shows the count.

## Reading the page

**Admin → Login audit.** Two tabs, because the two records answer different questions at different grains: **Login** is people arriving, **Token usage** is hours of machine traffic.

### Login

Top to bottom: an hourly summary, the filters, then the list.

The summary is stacked by how people signed in, over the last 2, 6 or 12 hours. It is **estimated, and summed across nodes** — each Horizon process counts what it tried to record, and the page adds those counters together for the hour, so a bar is the whole deployment's total rather than any one node's. The counters are close to the stored rows without being reconciled against them. The one per-node figure on the page is in the footer, which reports the process you happen to be talking to. The list below is the record itself — the rows as they were written, not a separate count reconciled against them.

Records refused by the hourly limit are deliberately *not* drawn as a bar. They appear as a note instead when the count is non-zero, because they describe records that were never written, and charting them beside records that were would read as extra volume.

One other count is kept but **not shown on the page**: writes whose outcome could not be confirmed. They are *unconfirmed* rather than known-lost — a write that commits and then times out leaves the row in the database and the count here, and nothing on Horizon's side can tell that from a write that never landed. It reaches the application log rather than the page: the recovery line names how many accumulated during an outage.

**Filters** are **Time range**, **Auth Channel** and **Login ID** — the same three the list is headed with. `Login ID` matches **exactly** — it names one principal, so a partial name finds nothing. There is deliberately nothing else: this page is read, not queried, and every extra predicate is an index to carry and another way to ask the database something slow. The other fields on a row are for reading once you have found it.

The list pages 50 at a time and reports only whether there is more, never a total. Selecting a row expands the investigation fields.

### Token usage

Presenting an API token is not a sign-in, so it produces no audit row — what a token did is a matter of traffic. This tab counts that traffic: **one row per token per hour**, newest hour first.

**Only API tokens from the tokens file are counted.** The other bearer Horizon accepts is the access token its own authorization server issues to an agent or MCP client at sign-in. That one is deliberately left out: the sign-in behind it is already a row on the Login tab, so counting its requests here as well would report one person's session as machine traffic. Browser sessions never reach this tab at all — they carry a cookie, not a token.

Pick a **Time range** — the last 2, 6 or 12 hours, or **Custom…** for an explicit start and end. Twelve hours is the widest span the page will read; a custom range longer than that is refused rather than silently trimmed, and a request that reaches the server for more is clamped to the last twelve.

**The range you get is widened to whole groups, and the picker shows it back.** A group is an hour, so asking for 10:50–11:10 is answered as 10:00–12:00 — both hours it touches, rather than the one it happens to end in. After a query the start and end you see are the ones actually read.

**A group is one whole hour, and the hours are UTC shown on your clock.** Where your offset is a whole number of hours the groups fall on the hour, as you would expect. Where it is not — India at +05:30, Adelaide at +09:30, Nepal at +05:45 — a group runs from half or quarter past to half or quarter past, because an hour bucket has to begin somewhere and that somewhere is the top of the UTC hour. The group headings always state the span they cover — and on the day a clock goes back, where both ends of the repeated hour read the same, the heading carries each end's offset so the two are still distinguishable.

Each hour is one group. Its header gives the hour, a bar showing that hour against the busiest in the range, and two figures that always describe the **whole** hour: **Uses**, every request whose token was accepted, and **Credentials**, how many distinct tokens made them.

**Accepted means the credential was recognised, not that the request succeeded.** A token is counted the moment it resolves to a live account — before permissions are consulted — so a request that is then refused for lack of a role, or that fails further on, is still a use. That is deliberate: the tab answers "what is this credential doing", and a token hammering endpoints it may not touch is exactly the thing you want visible. A token that fails to resolve at all is never counted, so the figures cannot be moved by someone without a valid credential.

The rows beneath name only the **busiest ten** tokens, and the line above the table always says which case you are looking at — *"Every credential used in this hour is listed"* when nothing was dropped, or *"Top 10 of N credentials — the rest are counted in the total, not listed"* when there were more. The unlisted ones are still inside the hour's **Uses** and **Credentials**, so the sample never disagrees with the totals above it.

Per row, in order: the token **id** — which names a credential without being one — its **Uses** for that hour, that as a **Rate** per second, and the **User** it acts as.

**Treat a token id as permanent, and never give it to a second person.** The id is what every hour of history is filed under, and history is not rewritten: if you edit a token's owner in the tokens file, or delete a token and later add a new one reusing its id, the hours already recorded keep the name they were written with, and the same id then spans two owners with nothing on the page to separate them. Retire an id rather than reassigning it — issuing a new token gives you a new one for free. The two measures sit beside the credential they belong to, and the rate is written to the same precision on every row so the column reads as one scale; a rate too small to show at that precision is written as a floor (`<0.001/s`) rather than as zero.

An hour with no token traffic still appears, saying so. An hour that is still in progress counts only what has happened so far.

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

- one `error` line when the connection is first lost, naming a sanitised cause, and one `info` line when it comes back, with how long it was down and how many records could not be confirmed as written. Not one line per sign-in — a long outage would bury the cause it is trying to surface;
- the page renders an explicit "cannot be reached" state rather than an empty table, because an empty table would claim there is nothing to show when there is;
- records are held in memory and written when the database returns. A long enough outage exhausts that buffer; the count of what could not be confirmed is reported in the recovery log line, not on the page.

## Multiple Horizon replicas

Each process writes its own rows and reports its own health, so the status line at the foot of the page describes **whichever replica answered your request**, not the cluster. The list and the summary read across all of them.
