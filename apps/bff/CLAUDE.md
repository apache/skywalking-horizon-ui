# CLAUDE.md — the BFF's conversation with OAP

Everything about **how Horizon talks to OAP** lives here: which endpoints exist,
what each one is for, and the wire rules that are easy to get wrong. The root
`CLAUDE.md` keeps the project-wide principles and points here for this.

`client/` is the ONLY layer that talks to OAP. If you are adding a call from
anywhere else, that is the bug — read the layering rules in the root file first.

## The endpoints — there are four, and they are not interchangeable

Configured under `oap:` (see `src/config/schema.ts`). Every one is a separate
URL, and using the wrong one fails in a way that reads like "OAP is broken".

| Config | Default | Carries |
|---|---|---|
| `oap.queryUrl` | `http://127.0.0.1:12800` | GraphQL query-protocol + `/status/*` |
| `oap.adminUrl` | `http://127.0.0.1:17128` | runtime rule mgmt, DSL/MQE/OAL, inspect, live debug, `/ui-management/*` |
| `oap.zipkinUrl` | `http://127.0.0.1:9412/zipkin` | the Zipkin-compatible trace API |
| `oap.mqe.host` / `.port` | unset | optional MQE override |

Two things that have cost real time:

- **Template management is on the ADMIN host, not the query port.** OAP moved
  `/ui-management/templates*` to the admin server in 11.0.0. An OAP without that
  surface (any 10.x) cannot serve templates to Horizon at all — the supported
  configuration there is `templates.mode: readonly`, not something Horizon
  silently falls back to.
- **Query traffic is load-balanceable, admin traffic is not always.** Any OAP
  node answers a query. Admin endpoints mostly get a single fire because OAP
  routes rule operations cluster-internally (`client/cluster.ts` deliberately
  does NOT fan out) — the exception is live-debug status, which resolves the
  admin hostname through DNS to find every node IP and probes each.

`oap.auth` (basic) and `oap.timeoutMs` apply to all of them.

## Cancellation

A read the operator abandoned must stop costing OAP work. The caller's
`AbortSignal` travels route → `buildOapOpts` → GraphQL client, combined with
rather than replacing the client's own timeout.

- **Reads only.** Anything that MUTATES — creating a profiling task, pushing a
  template — runs to completion, or a closed tab could leave it half applied.
  Those routes deliberately pass nothing.
- **"The client is gone" is asked of the RESPONSE socket alone.** A request's
  own readable is destroyed as soon as its body has been read, so consulting it
  reports every authenticated read as abandoned. See `http/client-gone.ts`.
- **A probe that was cancelled measured nothing, so it must not be CACHED.**
  `getServerOffsetMinutes` and `getOapCapabilities` both hold process-global
  caches; writing an abort-derived fallback into either lets one abandoned
  request answer every other request with a conclusion nobody reached.

## Time, step, and timezone

- **Step precision is page-family-specific.** Dashboards / overviews / landing
  scale step with the rolling window (MINUTE / HOUR / DAY). Alarms / traces /
  logs / live debugger use SECOND because they query event-style data anchored
  at second precision — MINUTE rounding chops off the most recent (most
  interesting) events. MQE traffic backdrops use MINUTE because metrics are
  aggregated at minute granularity.
- **String format is determined by step.** Mixing them throws
  `verifyDateTimeString` on OAP. Read `DurationUtils.java` in the skywalking
  repo for the canonical mapping.
- **OAP has a per-request bucket cap.** Long windows must be chunked. Storage
  backends impose stricter caps that vary by backend — probe, don't assume.
- **All time strings are OAP-server local.** Not UTC, not browser-local. The
  server's offset is exposed via `getTimeInfo`. The BFF owns this conversion;
  the UI displays in browser-local.

## Cold stage

`Duration.coldStage: true` **REPLACES** the hot+warm read with a cold-only read
— it does not union the two. The BFF honors the header verbatim and does NOT
auto-route by time range.

**It is BanyanDB-only, and it is per-group.** Other backends silently ignore the
flag. In `bydb.yml` each group carries its own `enableColdStage` (default
`false`), and only these eight expose it: `records`, `trace`, `zipkinTrace`,
`recordsLog`, `recordsBrowserErrorLog`, `metricsMinute`, `metricsHour`,
`metricsDay`. (The group keys are not the wire field names — the TTL response
calls the last two `log` and `browserErrorLog`.)

The flag reaches the BFF as the `x-horizon-cold-stage` header, is stashed once
per request on `req.coldStage`, and routes splice it in via `withColdStage`.
**Whether a route calls `withColdStage` is the ground truth for whether that
data has a cold stage at all** — and the UI mirrors it: a query whose route
applies the flag needs the stage in its cache key, because an answer from one
stage is not an answer to the other's question.

**Deliberately NOT cold-staged:** metadata, the instance and endpoint pickers,
and alarms. Operationally we do not recommend putting these in cold storage —
they are small, and they are what an operator reaches for first during an
incident. So their UI queries do not carry the stage in their key either. If
that recommendation ever changes, both sides change together.

## Metric entity-scope is load-bearing

Every OAP metric lives under exactly one entity scope (Service / ServiceInstance
/ Endpoint / relations / Process / All). OAP does not auto-rollup between
scopes — querying at the wrong scope returns empty results regardless of MQE
wrapping. Before adding or moving a metric, verify its scope against the OAP
catalog and confirm it matches the page that will render it. Never invent a
BFF-side rollup to bridge a scope mismatch.

## TTL is shaped by the storage backend

**Only BanyanDB implements per-class TTL.** OAP ships three storage plugins, and
`BanyanDBTTLStatusQuery` is the sole implementation of the storage-side TTL
query — the ElasticSearch and JDBC providers both register the *same*
`DefaultStorageTTLStatusQuery`, so they fall through to `TTLStatusQuery.getTTL()`,
which builds `RecordsTTL(coreRecordDataTTL ×5)` and
`MetricsTTL(coreMetricsDataTTL ×4)` — **the same number repeated**. There is no
third case: it is BanyanDB or it is those two knobs, `core.recordDataTTL` and
`core.metricsDataTTL`, with the five/four-way breakdown simply not existing.
(JDBC covers MySQL, PostgreSQL, H2 and TiDB alike.)

Things worth remembering:

- The BanyanDB numbers are **hot plus every additional lifecycle stage**, summed
  — not the hot TTL alone.
- **The `bydb.yml` group keys are not the wire field names.** The TTL response
  says `log` and `browserErrorLog`; the groups are `recordsLog` and
  `recordsBrowserErrorLog`. Pointing an operator at the wire name sends them to
  a key that does not exist.
- **`records` is not "alarms".** That one group holds alarms, alarm recovery,
  events, the three sampled-trace records, the four top-N records and every
  profiling record (profile / eBPF / async-profiler / JFR / pprof) plus GenAI
  evaluations — 22 models sharing one `ttl` and one `enableColdStage`. Naming it
  after any single one of them is wrong, which is why the UI calls it *Others*.
- `logic/oap/backend.ts` infers the backend from exactly this: if the record
  values differ from one another, it is BanyanDB. Anything rendering a per-class
  breakdown must branch on that, or it presents a structure the backend does not
  have.

## Other sharp edges

- **Storage backends have undocumented limits.** Page sizes, nested selections,
  and per-record sub-queries fail at backend-specific thresholds. Degrade list
  queries to the cheapest selection that satisfies the screen; probe before
  defaulting.
- **OAP IDs are not always per-record unique.** Some wire `id` fields key on the
  alarmed/related entity, not the firing instance. Disambiguate composite keys
  with timestamp before using `id` as a row key.
- **Paging is `pageNum`/`pageSize`, never a cursor**, and no total is returned.

## Do not invent fields

The GraphQL query-protocol and the admin REST surface are **fixed** — owned by
the skywalking repo, not this one.

- If a screen needs data the protocol doesn't expose, flag it. The right fix is
  a query-protocol change upstream, not a BFF-side fabrication.
- **The schemas and Java implementations are the authoritative spec** — read
  `oap-server/server-query-plugin/.../query-protocol/*.graphqls` and
  `oap-server/server-core/.../query/` before guessing at a wire shape.
- **When a wire shape is in doubt: the schema, then the Java, then a live
  server.** An older UI's source is evidence about the past, not a decision
  about the present. Never cite it as the reason a thing must be a certain way.
