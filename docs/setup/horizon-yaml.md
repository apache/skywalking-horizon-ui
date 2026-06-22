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
| `sourceMaps` | In-memory source-map budgets + static mount for the Browser Logs tab. | [Browser Logs & Source Maps](../operate/browser-source-maps.md) |
| `performance` | How hard the BFF fans queries out to OAP, plus render / per-request record caps. | [below](#performance-tuning) |
| `layers` | Layers to hide from the sidebar. | [below](#excluded-layers) |

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
sourceMaps: { enabled?, maxFileBytes?, maxTotalBytes?, maxFileCount?, bootMountDir? }

performance:
  bulk:
    topology:  { nodeBulkSize?, edgeBulkSize?, concurrency? }
    infra3d:   { metricBulkSize?, metricConcurrency?, topologyConcurrency?, templateConcurrency? }
    landing:   { bulkSize?, concurrency? }
    dashboard: { bulkSize? }
  limits:
    topologyMaxNodes?: number
    topologyMaxEdges?: number
    maxPageSize: { traces?, logs?, browserLogs? }

layers:  { excluded?: [{ key, reason? }] }
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
- `sourceMaps.enabled`, `sourceMaps.maxTotalBytes`, `sourceMaps.maxFileCount` — applied on the next source-map upload / resolve / list. Lowering a budget trims the in-memory **uploaded** set then (least-recently-used first). It does **not** shrink maps already loaded from the static mount — see below.

These changes require a process restart:

- `server.host`, `server.port` — the listener already bound.
- Capability probes — the OAP schema introspection cache is per-process.
- `sourceMaps.bootMountDir` — the static source-map directory is scanned once at startup, so a new directory (and newly-dropped `.map` files) needs a restart. The count of maps loaded from that mount is fixed by the startup scan as well: lowering `sourceMaps.maxFileCount` afterwards trims only the in-memory uploaded set, never the already-mounted maps — restart to re-scan a mount against a lower count.
- **Raising** `sourceMaps.maxFileBytes` — the multipart upload size limit is fixed at startup; lowering it applies live.

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

## Performance tuning

```yaml
performance:
  bulk:
    topology:  { nodeBulkSize: 150, edgeBulkSize: 200, concurrency: 4 }
    infra3d:   { metricBulkSize: 6, metricConcurrency: 4, topologyConcurrency: 4, templateConcurrency: 8 }
    landing:   { bulkSize: 6, concurrency: 8 }
    dashboard: { bulkSize: 6 }
  limits:
    topologyMaxNodes: 5000
    topologyMaxEdges: 15000
    maxPageSize: { traces: 100, logs: 100, browserLogs: 100 }
```

The `performance` block tunes how hard Horizon drives your OAP and storage backend. **Every default equals the built-in value, so the whole block is optional** — omit it and Horizon behaves exactly as it does without it. Every value is also **clamped to a hard ceiling**: a number above the ceiling is pulled back down to it (config can only lower the load below a built-in limit, never raise it past one). Hot-reloadable — a change takes effect on the next request of that kind.

The rule of thumb: **raise these on a beefy OAP with a fast storage backend** that can absorb more parallel queries (you'll fill pages and maps faster); **lower them on a modest deployment** where a busy OAP rejects or slows under the burst.

### `performance.bulk` — query fan-out

These govern how Horizon batches and parallelizes its metric queries to OAP. Each family has a **bulk size** (how many metric expressions ride in one OAP request — fewer, larger requests vs. more, smaller ones) and most have a **concurrency** (how many of those requests are in flight at once).

| Section | Tunes | Defaults |
|---|---|---|
| `bulk.topology` | The service-map family (topology, instance topology, deployment, endpoint dependency) node/edge metric fan-out. | `nodeBulkSize: 150`, `edgeBulkSize: 200`, `concurrency: 4` |
| `bulk.infra3d` | The 3D Infrastructure Map's metric, topology, and template loading. | `metricBulkSize: 6`, `metricConcurrency: 4`, `topologyConcurrency: 4`, `templateConcurrency: 8` |
| `bulk.landing` | The per-layer landing's service-column metric batches. | `bulkSize: 6`, `concurrency: 8` |
| `bulk.dashboard` | A dashboard's widget metric fan-out. | `bulkSize: 6` |

- **Raise `concurrency` / `*Concurrency`** to load a large topology, 3D map, landing, or dashboard faster when OAP has headroom. **Lower it** (toward `1`) if OAP rejects or slows under the burst of parallel requests.
- **Bulk sizes** trade request count against request size: a larger bulk means fewer, fatter OAP requests. OAP rejects an oversized request, so each bulk size is capped — leave it at the default unless you have a specific reason to change it.
- For the 3D map specifically, these knobs are also described in context on the [3D Infrastructure Map](../operate/infra-3d-map.md) page.

### `performance.limits` — render & record caps

| Field | Caps | Default |
|---|---|---|
| `topologyMaxNodes` | The render valve for a service map — a graph with more nodes than this is **rejected with a "narrow the scope" notice** rather than drawn as an unreadable hairball. | `5000` |
| `topologyMaxEdges` | The same valve on edges. | `15000` |
| `maxPageSize.traces` | The maximum **records** fetched per Traces request (the storage `LIMIT`, not a page count). The page-size picker on the page maxes at this same value, so a client can't out-ask the dropdown. | `100` |
| `maxPageSize.logs` | The same per-request record cap for Logs. | `100` |
| `maxPageSize.browserLogs` | The same per-request record cap for Browser Logs. | `100` |

- **`topologyMaxNodes` / `topologyMaxEdges`** are a readability and safety valve, not a data limit — if your deployment legitimately has a graph this large, raising them lets it render (at the cost of a denser scene and a heavier draw). Lower them if you'd rather force operators to scope down sooner.
- **`maxPageSize.*`** bound how many rows one Traces / Logs / Browser-Logs request pulls from storage. Some storage backends fail or slow on large list queries — lower these to keep list pages cheap on a constrained backend; raise them (up to the ceiling) if your backend serves big result sets comfortably and operators want more rows per fetch.

## Excluded layers

```yaml
layers:
  excluded:            # defaults when the block is omitted:
    - key: FAAS              # deprecated
      reason: Deprecated.
    - key: VIRTUAL_GATEWAY   # not planned
      reason: Not planned to set up.
```

`layers.excluded` hides specific layers from the sidebar even when OAP
reports them in `listLayers`. Keys are OAP layer keys (UPPER_SNAKE), matched
case-insensitively. `reason` is a note for whoever reads the file — it is
not shown in the UI; an excluded layer simply doesn't appear.

- **Defaults**: `FAAS` and `VIRTUAL_GATEWAY` are excluded when the block is
  omitted. Set `excluded: []` to surface **every** layer OAP reports.
- This is the only hide list — there is no hard-coded one. The other way a
  layer disappears is an admin explicitly disabling its template on the
  Layer dashboards page.

## Cross-references

- A field that affects user-visible behavior at runtime is also visible on **Admin → Auth Status** (`/admin/auth-status`) for live verification — see [Admin Pages](../access-control/admin-pages.md).
- The wire-level effect of any `oap.*` change is visible in `horizon-wire.jsonl` when `debugLog.enabled: true` — see [debugLog](debug-log.md).
