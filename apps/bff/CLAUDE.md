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
- **One Horizon reads ONE deployment, and every node in it answers alike.** The
  timezone, the capability set, the layer-level table and the storage backend
  are properties of that deployment, not of whichever node a request lands on —
  Horizon may read any of them and get the same answer. So a process-level cache
  of any of those needs no per-`queryUrl` key: there is no second answer for a
  key to separate. Several of them carry one anyway, from before this was
  written down; it is harmless and load-bearing nowhere, and new code should not
  copy it.

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
Whether a route calls it is OUR decision about scope, not a reading of what the
storage supports — the table below is that decision.

### The cold scope is ours, not the protocol's

The protocol accepts `Duration.coldStage` on far more than we send it on. **We
send it for traces, logs and metrics, and nowhere else** — because those are the
only classes a deployment is advised to age into cold storage. Metadata, alarms,
the rest of the `records` group and everything from profiling stay hot: they are
small, and they are the first things an operator reaches for during an incident.

This is not a suggestion the code merely documents. `coldStage: true` **replaces**
the hot read, so sending it on an out-of-scope route does not widen the answer —
it empties it. A Cold toggle would blank the alarm list and the entity pickers.

| Sends `coldStage` | Never sends it |
|---|---|
| `trace.ts` — traces | `alarms.ts` — `/api/alarms`, `/api/alarms/count` |
| `log.ts`, `browser-errors.ts` — logs | `instance.ts` — the instance picker |
| `dashboard.ts`, `landing.ts`, `explore.ts` — metrics | `endpoint.ts` — the endpoint picker |
| `mqe-exec.ts` — one metric expression, run from the template editor | |
| `topology.ts`, `deployment.ts`, `instance-topology.ts`, `endpoint-dependency.ts`, `infra-3d-metrics.ts` — metrics | `events.ts` — events live in `records` |
| | `ebpf.ts` — network profiling |
| | `trace-tag.ts` — tag key/value autocomplete |
| | `ai/` — the assistant's own reads |

**Adding a route means placing it in this table.** The default is the right-hand
column: a route sends the flag only because its data is a trace, a log or a
metric.

**One read inside a left-hand route deliberately does not send it**: the layer
header's hourly KPI scan. What it holds is a property of the LAYER, not of the
pill one operator happens to have on, and a cache keyed by layer cannot hold two
answers for the same hour. It reads hot, always. Nothing is lost — a completed
hour that is minutes old has not aged into cold storage. The rest of the landing
route still honours the flag.

**Two of the right-hand rows are outside the scope for their own reasons**, not
because their data is hot-only:

- **Tag autocomplete** (`/api/{trace,log}-tags/{keys,values}` and the Zipkin
  pair) completes what the operator is TYPING. The candidate list is a property
  of the schema rather than of a window — narrowing it to whatever happens to
  exist in cold storage would offer fewer completions than the query it is
  helping to write can match. It carries no stage and asks for none.
- **The AI assistant** (`/api/ai/*`) passes `coldStage: false` explicitly rather
  than by omission, in `ai/lib/tools/visualization/tools.ts`. Its tools read on
  the operator's behalf but not from their screen, so inheriting a pill they set
  somewhere else would make an answer depend on invisible state. If cold ever
  becomes something the assistant can be ASKED for, it should be a parameter of
  the question, not an ambient flag.

**The stage is NOT part of any UI cache key**, on either side of the table. It
rides on the request header and reaches OAP with whatever the page asks for
next. Keying on it was tried and is wrong for a reason that has nothing to do
with correctness of storage: a key that moves when the pill flips has no cached
entry, so the query library fetches at once — which is the immediate page-wide
read the toggle deliberately does not perform. The trade is that the screen goes
on showing the previous stage's answer until the next read; the pill says what
the next read will ask for.

**Horizon does not check whether a group has a cold stage configured.** The
operator asks for cold, so Horizon asks OAP for cold. Inferring availability
from the TTL response would be a second-guess with no upstream contract behind
it, and it is per-group anyway, so one answer could not be right for every
query. A cold read against a group with no cold stage returns empty, which is
the honest answer. The Time To Live page reports the configuration; it gates
nothing.

## The template decides; the code does not second-guess it

Where a layer template states something, that statement is the answer. The BFF
reads it and applies it — it does not carry its own idea of what the value
should be, and it does not "improve" one that looks wrong.

The fields this covers today, under a layer's `layer-header`, `dashboards`,
`topology` and `endpointDependency` blocks: `orderBy`, the `columns` list with
each column's `metric` / `mqe` / `aggregation`, the sort direction inside a
`top_n(...)` expression, and the metric ids themselves.

**`topN` is NOT among them for the header**, whatever the sentence below once
claimed. `LayerHeaderConfig` has no such field and no bundled template declares
one — the number of rows the header's KPI aggregates is the page's, not the
template's. Say so rather than describing an ownership that does not exist:
half of "the template decides" is knowing which fields it actually decides.

Two consequences worth stating, because both have been mistaken for bugs:

- **`topN: 5` means the header describes five services, not the layer.** Its
  KPI aggregates the top five rows, so a 900-service layer shows the throughput
  of its five busiest. Holding every service's value would make a whole-layer
  rollup possible; it would not make it wanted.
- **A column that NAMES a metric must be one the template declares.** Naming
  `cpm` is asking the layer for something it already knows, so an undeclared
  name is refused rather than fetched — otherwise a caller widens the layer's
  surface by asking. A column that carries its own `mqe` is a different
  request: it names the expression to evaluate and is answered live. The
  Overview is built that way, synthesising `w_0`, `w_1`… from its own widgets,
  which no layer template declares and never will.
- **The hourly header cache holds only what the template declares.** Its
  whitelist is the set of (MQE, entity) pairs under `layer-header.columns`,
  matched on the EXPRESSION rather than the column's name — the name is the
  caller's own, and the Overview calls `service_cpm` "w_0". Anything outside
  that set is read live. Editing the declared columns discards the layer's held
  hour: the values were computed for different expressions, so serving them
  under the new ones would be a different number wearing a familiar label.

A code constant is for what the template has NO opinion about — a transport
bound like `bulkSize`, a timeout, a cache TTL. If you find yourself writing a
default for something a template already carries, read the template instead.

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
