# horizon.yaml Reference

`horizon.yaml` is the single configuration file for the Horizon BFF. Validation runs at startup and again on every hot reload. A file that fails validation is **rejected**; the BFF keeps the previously valid config rather than serving with broken settings.

This page is the top-level map. Each subsection has its own detail page:

| Section | Purpose | Details |
|---|---|---|
| `server` | HTTP listener and static asset path. | [server](server.md) |
| `oap` | OAP query / admin / Zipkin URLs, timeouts, basic-auth. | [oap](oap.md) |
| `auth` | Active backend (local or LDAP), local users, LDAP binding, break-glass. | [auth](auth.md) |
| `rbac` | Role definitions, permission grants, landing route per role. | [rbac](rbac.md) |
| `session` | Cookie name, TTL, secure flag. | [session](session.md) |
| `audit` | Audit log file path. | [audit](audit.md) |
| `setup` / `alarms` | State file paths. | [files](files.md) |
| `debugLog` | Wire-level request/response log for troubleshooting. | [debugLog](debug-log.md) |
| `query` | Per-request query limits (the layer-landing service cap). | [below](#query-limits) |

## Top-level shape

```yaml
server: { host, port, staticDir? }

oap:
  queryUrl: string
  adminUrl: string
  zipkinUrl?: string
  timeoutMs?: number
  auth?: { username, password }
  mqe?: { host?, port? }

auth:
  backend: local | ldap
  local?: { users: [{ username, passwordHash, roles? }] }
  ldap?: { ... }
  breakGlass?: { username, passwordHash, roles? }

rbac:
  enabled?: boolean
  roles?: { <name>: [verb, ...] }
  landingByRole?: { <name>: "/route" }

session: { ttlMinutes?, cookieName?, cookieSecure? }
audit:   { file? }
setup:   { file? }
alarms:  { file? }
debugLog: { enabled?, file?, maxBodyChars?, redactAuthHeaders? }
```

## Environment variable interpolation

`${VAR}` and `${VAR:default}` are expanded **before** YAML parsing.

- `${VAR}` — fail-loud. Expands to the env var; if unset, expands to empty string and the schema decides whether empty is valid. Use for secrets so a missing env var stops startup.
- `${VAR:default}` — fail-soft. Expands to the env var, or the literal `default` if unset. Use for optional non-secret values.

```yaml
oap:
  auth:
    password: "${HORIZON_OAP_PW}"             # fails loud if unset
ldap:
  bindPassword: "${HORIZON_LDAP_PW:}"         # empty if unset (works for anonymous bind)
```

## Bootstrap rules

The BFF validates the file shape at startup and on every hot reload. Schema errors still reject the file; auth bootstrap gaps are softer so a first-run container can render the login page with a setup-required banner.

Auth gaps that boot with a warning but reject login:

1. `auth.backend: local` and `auth.local.users` is empty.
2. `auth.backend: ldap` and `auth.ldap` block is missing.
3. `auth.backend: ldap` and `auth.ldap.groupMappings` is empty.

There is no "default admin/admin" fallback.

## Warnings (do not block startup)

- `auth.backend: ldap` but `auth.local.users` populated → local users will be ignored.
- `debugLog.enabled: true` in a config without `debugLog.redactAuthHeaders: true`.
- `session.cookieSecure: false` (acceptable for localhost dev; log noise reminds you in production).

## Hot reload behavior

The config is re-read on file change and the new values take effect without a restart:

- Auth backend selection (re-evaluated on next login).
- RBAC roles and policy (re-evaluated on next route call).
- OAP URLs and credentials (used on next outbound call).
- Session TTL (new sessions use the new TTL; existing sessions keep their original).

Two changes require a process restart:

- `server.host`, `server.port` — the listener already bound.
- Capability probes — the OAP schema introspection cache is per-process.

## Query limits

```yaml
query:
  landingServiceCap: 100   # default
```

`query.landingServiceCap` bounds how many services a **layer landing** runs
column-metric MQE for, per request. The service picker always **lists every
service** in the layer, but only fetches metric columns for up to this many —
and when a layer has more, the BFF runs one cheap single-metric pass (the
landing's order-by column over every service) to pick the **true top-N**, then
fetches the full columns for just those. Services below the cap still appear in
the picker, showing **`low`** in the order-by column (and `—` for the others,
which were never probed) — every service stays browsable and selectable. The
picker header reads **"metrics: top N"** so the metric trim is never silent.

- **Default `100`.** Most layers have fewer services and render in full.
- **Raise it** (e.g. `300`, `500`) if your OAP and storage backend can take
  the larger fan-out and you want metrics for more services at once.
- **Lower it** to protect a modest deployment from heavy landings.

**What it bounds.** The cap limits the **full-column** MQE fan-out (the
expensive part — every configured column × service). When a layer exceeds
it, the **true top-N** is found by a single cheap pass that evaluates only
the order-by column for every service — so on a very large layer that one
ranking pass still scales with the service count (it's one metric, batched
through a bounded-concurrency pool, not the full column set). The cap is
therefore a bound on the *expensive* fan-out, not a hard ceiling on total
OAP traffic. If you need a hard ceiling on a pathological layer, lower the
cap and pair it with a tighter OAP rate limit.

Hot-reloadable — a change takes effect on the next landing request.

## Cross-references

- A field that affects user-visible behavior at runtime is also visible on **Admin → Auth Status** (`/admin/auth-status`) for live verification — see [Admin Pages](../access-control/admin-pages.md).
- The wire-level effect of any `oap.*` change is visible in `horizon-wire.jsonl` when `debugLog.enabled: true` — see [debugLog](debug-log.md).
