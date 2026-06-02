# Audit Log

The audit log records sensitive operations as JSON Lines, one event per line, append-only. Configure the path via `audit.file` in `horizon.yaml` (see [Setup → audit](../setup/audit.md)).

## Event Fields

Each event has these fields:

| Field | Meaning |
|---|---|
| `ts` | ISO-8601 timestamp. |
| `actor` | Username, or `null` for system events. |
| `action` | Operation name, such as `auth.login` or `addOrUpdate`. |
| `verb` | RBAC verb checked, when applicable. |
| `target` | Resource id or name, when applicable. |
| `outcome` | `success` / `ok` / `break-glass` for normal flows; the OAP `applyStatus` or `http_<code>` on an upstream failure. |
| `details` | Extra context for the operation. |
| `fromIp` | Requester IP. |
| `sessionId` | Session id, when a session exists. |

One event per line, `\n`-terminated. Use `jq -c` to filter:

```sh
tail -f horizon-audit.jsonl | jq -c 'select(.action | startswith("auth."))'
```

## Recorded actions

The recorded set can grow between releases. The current set:

| Action | Outcome values | Notes |
|---|---|---|
| `auth.login` | `success`, `failure` | Standard login. `details.backend` is `local` or `ldap`. On success `details.roles` carries the resolved role list. |
| `auth.login.break-glass` | `break-glass` | Emergency admin login. Logged in addition to a WARN application log line. |
| `auth.logout` | `success` | Explicit logout (cookie cleared). Sessions that simply expire are not logged. |
| `addOrUpdate` | OAP `applyStatus`, or `http_<code>` on failure | DSL Management — create / update a rule. `target` is the rule name; `details.catalog` is the rule catalog (alarm, MAL, OAL, …). |
| `inactivate` | OAP `applyStatus`, or `http_<code>` | DSL Management — deactivate a rule. |
| `delete` | OAP `applyStatus`, or `http_<code>` | DSL Management — delete a rule. `details.mode` is the delete mode. |
| `alarms.config.save` | `ok`, or an error status on failure | Alarm page setup save. |
| `setup.save` | `success`, or an error status on failure | Per-user setup state write (service / instance / endpoint setup). |
| `debug.start` | `ok`, or an error status on failure | Live Debugger — start a session. |
| `debug.stop` | `ok`, or an error status on failure | Live Debugger — stop a session. |

`outcome` is a short literal for normal flows (`success`, `ok`, or `break-glass`) and, when the underlying OAP call fails, the OAP `applyStatus` value or `http_<code>`. This makes audit-time error correlation straightforward: an entry with `outcome: "http_503"` tells you OAP returned a server error.

## Example entries

### Successful local login

```json
{
  "ts": "2026-05-18T09:14:02.118Z",
  "actor": "alice",
  "action": "auth.login",
  "outcome": "success",
  "fromIp": "10.0.5.12",
  "sessionId": "k7r...",
  "details": { "backend": "local", "roles": ["operator"] }
}
```

### Failed LDAP login

```json
{
  "ts": "2026-05-18T09:14:08.221Z",
  "actor": "alice",
  "action": "auth.login",
  "outcome": "failure",
  "fromIp": "10.0.5.12",
  "details": { "backend": "ldap" }
}
```

(No `sessionId` — no session was created.)

### Break-glass login

```json
{
  "ts": "2026-05-18T14:29:33.456Z",
  "actor": "emergency-admin",
  "action": "auth.login.break-glass",
  "outcome": "break-glass",
  "fromIp": "192.0.2.10",
  "sessionId": "z3a...",
  "details": { "backend": "ldap" }
}
```

### Rule write

```json
{
  "ts": "2026-05-18T15:02:11.004Z",
  "actor": "alice",
  "action": "addOrUpdate",
  "verb": "rule:write",
  "target": "service_resp_time_rule",
  "outcome": "success",
  "details": { "catalog": "alarm" },
  "fromIp": "10.0.5.12",
  "sessionId": "k7r..."
}
```

## File format

- **JSON Lines.** One JSON object per line, `\n`-terminated.
- **Append-only.** The file is only ever appended to — never truncated or rotated.
- **No rotation built in.** Pair with `logrotate`, `vector`, `fluent-bit`, or a sidecar shipper.

## Storage placement

- **Durable storage required.** Break-glass logins, rule edits, and setup changes should outlive the container.
- **Filesystem perms** matter for forensic integrity — typically `0640` (BFF user write, ops group read), not world-readable. Adjust to your operations posture.
- **Encrypted at rest** if your compliance posture requires it. Use disk-level encryption (LUKS, EBS encryption) — the BFF itself does not encrypt.

## What is NOT in the audit log

- **Read operations.** Dashboard fetches, alarm queries, MQE reads are not logged (volume would be unworkable, and reads have no side effects). Configure `debugLog.enabled` for wire-level read logging.
- **Typed passwords.** Never logged. Failed logins show the actor but not the attempted password.
- **OAP response bodies.** Audit entries reference what was attempted, not the underlying response payload. For payload-level visibility, use `debugLog` (`./horizon-wire.jsonl`).

## In-memory "seen cache"

In addition to the on-disk audit log, the BFF keeps an in-memory record of recent successful logins:

- Records: username, source (`local` / `ldap` / `break-glass`), roles, last-seen timestamp, last IP.
- Reset on BFF restart.
- Visible on the Users admin page.

This is a UX convenience — it lets the Users page show "who has logged in to this BFF instance recently" without parsing the audit log. For historical / cluster-wide analysis, parse the JSONL file directly.

## Wire-up to log pipelines

JSON Lines is ingestable by almost everything. Common pipelines:

| Pipeline | Configuration |
|---|---|
| Vector | `[sources.horizon] type = "file"`, `format = "json"` |
| Fluent Bit | `INPUT tail`, `Parser json` |
| Promtail / Loki | `pipeline_stages: - json` |
| Elastic Filebeat | `filebeat.inputs: - type: filestream`, `parsers: - ndjson` |
| Splunk Universal Forwarder | `INDEXED_EXTRACTIONS=JSON` |

Index on `actor`, `action`, `outcome` for the common queries ("all admin actions by user X in the last 24h").
