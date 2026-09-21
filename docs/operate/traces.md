<!--
Licensed to the Apache Software Foundation (ASF) under one or more
contributor license agreements.  See the NOTICE file distributed with
this work for additional information regarding copyright ownership.
The ASF licenses this file to You under the Apache License, Version 2.0
(the "License"); you may not use this file except in compliance with
the License.  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# Traces

The Traces tab is the distributed-trace explorer inside a layer. You pick a service, set conditions (status, sort, duration, tags, time window), run the query, then click a result to read its span timeline. It surfaces the trace stores the layer is configured for: SkyWalking-native traces, Zipkin traces, and either of those through the TraceQL (Grafana Tempo) API.

Traces are triage data, so this tab owns its own time range and conditions. It is not driven by the global topbar time picker, and it does not auto-refresh: you set your conditions and press **Run query**. Nothing is fetched until you do — until then the list shows a "Pick your conditions, then click Run query." prompt.

## Which trace stores appear

A layer names the trace stores it exposes, and **each one becomes its own row in the sidebar**:

| Row | What it queries |
|---|---|
| **Traces** | SkyWalking's own trace query. |
| **Zipkin Traces** | OAP's Zipkin v2 API, which also carries the OpenTelemetry traces OAP converts into Zipkin form. |
| **TraceQL - Native** | The TraceQL API over the native spans. |
| **TraceQL - Zipkin** | The TraceQL API over the Zipkin spans. |
| **TraceQL - OTLP** | The TraceQL API over the OTLP spans OAP stored as they arrived, converting nothing. |

Each row can be renamed per layer, so what you see in your deployment may differ. Stores are kept as separate rows rather than one row with a toggle because their span models and their query conditions genuinely differ, and a row that silently switched stores would change what a field means under you.

**A layer picks its stores in its template.** Mesh and Kubernetes-flavored layers commonly expose Zipkin; instrumented-agent layers expose native. A layer whose template says nothing shows the native row, which is what it has always shown. The TraceQL rows additionally need their URL set in [OAP Connection](../setup/oap.md#traceql-trace-stores-oaptraceql); a row whose URL is unset says so instead of searching something else.

Which stores a layer exposes is set in **Dashboard setup → Layer dashboards → (layer) → Trace**, and documented in [Layer Dashboard Templates → `traces`](../customization/layer-templates.md#traces).

## Native traces

The native explorer queries SkyWalking's own trace store. The service is taken from the layer's Service header picker at the top of the page; the in-tab conditions narrow within that service.

### Conditions

All conditions are staged in the toolbar and only take effect on **Run query** — editing a field does not refetch on its own. The **Filter** / **Trace ID** switch beside the title picks between these conditions and a lookup by id; see *Looking a trace up by its id* below.

| Condition | What it does |
|---|---|
| Instance | Restrict to one service instance. Defaults to All. Resets when you switch service. |
| Endpoint | Restrict to one endpoint. Defaults to All. A dropdown of the service's endpoints (capped at 50). |
| Status | `ALL`, `SUCCESS`, or `ERROR` — the trace state. |
| Order | `BY_START_TIME` (Newest) or `BY_DURATION` (Slowest). |
| Limit | Cap on result rows: 30 by default. The server caps a single page at 200. The list says when the window held more traces than the limit returned — there is no total on the wire, only "there is more". |
| Time range | A rolling preset (Last 15 min through Last 24 hours) or a Custom… absolute start/end pair. |
| Duration range (ms) | Min–max trace duration, in milliseconds. |
| Tag | Free-form span tags as `key=value` (for example `http.status_code=500`). Press Enter to add; each committed tag shows as an Active-tag chip. Multiple tags are AND-joined. |

The time window is evaluated at second precision so a trace that just finished still falls inside it — minute rounding would drop the most recent (and usually most interesting) traces during triage.

### Richer vs. universal results, by storage backend

What a result row represents depends on the storage backend behind OAP, and Horizon detects this automatically — you do not configure it:

- On backends that support it, the explorer fetches **whole traces with their spans inline**. The list shows complete traces, and selecting one renders its waterfall immediately with no second round-trip. A banner reads "This OAP serves traces via Trace Query v2 API" and "Full traces are returned inline."
- On any other backend, the explorer falls back to the **universal basic query**, which returns trace **segments**. Each row is one segment; the full trace is fetched on click. The banner reads "Trace Query v1 API" and "Each row is a trace segment — click one to fetch its full trace."

The banner stays visible across both the browse list and the open-trace view, so it is always clear what a row represents. The richer inline view is a property of the storage backend, not a setting — if your rows are segments, the backend does not support whole-trace queries.

### Duration distribution

Beside the conditions, a Distribution chart plots one dot per result: the X axis is the trace's start time, and the dot's duration (the Y value) is surfaced on hover. Error traces are drawn in the error color, successful ones in the accent color.

The chart is an in-page filter. Click a dot — or drag a rectangle across several — to pick a subset; the result list then narrows to just the picked traces and the header switches to an "N picked" count with a Reset button. This filters what is already loaded; it does not issue a new query.

### Result list and the trace waterfall

Each row in the result list shows the trace's root endpoint, an OK/ERR status flag, the duration, and a bar sized relative to the slowest trace in the set. Click a row to open it.

Selecting a trace opens the detail view, which offers three layouts:

- **Default** — the span waterfall: an indented timeline, one row per span. Each row carries a service-colored bar positioned and sized by the span's start offset and duration, a span-kind glyph, a component icon, the endpoint or peer name, and the span's own duration. Errored spans are highlighted. A flag badge marks spans that carry attached events.
- **Tree** — the same spans drawn as a zoomable node graph.
- **Statistics** — spans rolled up by name, with count and total / average / maximum duration, sortable per column.

Span kinds are grouped into entry (server), exit (client), local, producer, and consumer families, each with its own glyph and color. The waterfall stitches spans across segments using their parent references, so a single trace that spans multiple services renders as one connected timeline.

Click any span row to open its detail panel:

- **Meta** — service, instance, endpoint, kind, component, peer, layer, start time, duration, and error flag.
- **Cross-trace refs** — when a span references a parent in a *different* trace, those references are listed with the parent trace id, parent segment, parent span, and ref type. The trace id is a link that opens that other trace.
- **Tags** — the span's key/value tags.
- **Logs** — per-span log entries with their timestamps.
- **Attached Events** — named events on the span with their start/end times and summary key/values.

The detail view's header KPIs report the trace's start time, total duration, span count, and the number of distinct services it touched. You can copy the trace id or a shareable URL from there; opening a shared `?traceId=` link lands directly on the trace in an overlay.

## Zipkin traces

When a layer enables Zipkin, the Zipkin tab queries an upstream Zipkin store through OAP. Zipkin organizes data by its own service universe (the `localEndpoint.serviceName` reported on each span), which can drift from SkyWalking's service list, so this tab carries its own service controls rather than binding to the shell's Service picker.

### Conditions

| Condition | What it does |
|---|---|
| Service | Free-text service name (with suggestions). Empty means every service. |
| Remote service | Narrow to spans calling a given remote service. Requires a service to be picked first. |
| Span name | Narrow to one span/operation name. Requires a service to be picked first. |
| Min duration (ms) / Max duration (ms) | Duration bounds, entered in milliseconds. |
| Annotations | Zipkin annotation query — `error` or `key=value` terms, AND-joined. |
| Limit | Result cap: 10, 30, 50, 100, or 200. The list says when the window held more traces than the limit returned. |
| Time range | A lookback preset (Last 15 min through Last 24 hours) or a Custom range… absolute window. |

As with the native tab, conditions are staged and only applied on **Run query**, and the **Filter** / **Trace ID** switch beside the title picks between them and a lookup by id.

Each Zipkin result shows its duration and error state, with a duration bar colored fast-to-slow (errored traces are forced to the error color). Zipkin ships no status field, so that state is read from the span's tags — see [How a span's status is decided](#how-a-spans-status-is-decided). Selecting a trace renders the Zipkin span waterfall, and a span detail panel exposes the span's duration, kind, and Zipkin tags. Because the two stores have different span formats, there is no field mapping between native and Zipkin results — Zipkin spans keep their Zipkin shape.

## How a span's status is decided

**Where a span reports its own status, that is what you see.** A native span carries OAP's error flag, and a natively stored **OTLP** span keeps the status its SDK set. A **Zipkin** span has no status field at all, and an OTLP span *converted* to Zipkin arrives `unset` — OAP's converter sets none — so for those there is nothing to report.

**Where it does not, the status is read from the attributes the span carries**, by one table shared across every store — the Zipkin row, the TraceQL rows, and each one's result list. An attribute not listed here is never read as a status.

A TraceQL **search** result is a third case: it carries a `status` of its own per span, so a list can show failures without opening each trace. Where that says `error` or `ok` the row is settled at once; where it says `unset`, the traces still undecided are read afterwards and the markers below settle them.

| Attribute | `error` when | `ok` when | says nothing when |
|---|---|---|---|
| `error` | any other value, an empty one included | `false`, `0` | — |
| `http.status_code` | 400 and above | below 400 | not a number, empty included |
| `http.response.status_code` | 400 and above | below 400 | not a number, empty included |
| `rpc.status_code` | any other code, named or numeric | `0`, `OK` | empty |
| `grpc.status_code` | any other code, named or numeric | `0`, `OK` | empty |
| `rpc.grpc.status_code` | any other code, named or numeric | `0`, `OK` | empty |
| `otel.status_code` | `ERROR`, `STATUS_CODE_ERROR`, `2` | `OK`, `STATUS_CODE_OK`, `1` | `UNSET`, or anything else |
| `status.code` | `ERROR`, `STATUS_CODE_ERROR`, `2` | `OK`, `STATUS_CODE_OK`, `1` | `UNSET`, or anything else |
| `exception.type` | present, an empty one included | — | — |
| `error.kind` | present, an empty one included | — | — |
| `error.type` | present, an empty one included | — | — |
| `error.message` | present, an empty one included | — | — |
| `error.object` | present, an empty one included | — | — |

**An empty `error` is a failure, and that is deliberate.** In Zipkin the tag's presence is the signal and its value is only the message, so a span that failed without one writes `error=""`. The single place it is read the other way is a **TraceQL search** result: OAP writes every projected attribute onto every span of a trace there, filling in the ones a span does not have with an empty value, so an empty attribute in that one response means the span never carried it. Opening the trace reads the span's real attributes and settles it.

Two attributes on one span can disagree, and so can two spans in one trace. **Failure wins both times, and success is never assumed:** a span reporting a 200 alongside an `exception.type` is failed, a trace is failed as soon as one span is, and a trace is successful only when a span says so and none says otherwise. A trace nothing spoke for stays unknown.

Resolution goes in this order:

1. **A span** — its own status if it has one, otherwise the markers above, otherwise unknown (shown as `unset` on the TraceQL rows, which is OTLP's own word for it).

2. **A trace** — failed as soon as one span is, successful only when a span says so and none says otherwise, unknown when nothing spoke.

Two markers on one span can disagree, and so can two spans in one trace. **Failure wins both times, and success is never assumed:** a span reporting a 200 alongside an `exception.type` is failed. A trace nothing spoke for stays unknown rather than being called a success.

## TraceQL traces

The TraceQL rows query traces through [Grafana Tempo's query language](https://grafana.com/docs/tempo/latest/traceql/), which OAP answers over Tempo's HTTP API. A TraceQL trace is an **OpenTelemetry** trace and is shown as one: opaque span ids, a span kind, a three-valued status (ok / error / unset), resource attributes kept apart from span attributes, and the instrumentation scope. Nothing is folded into SkyWalking's own span shape, so what you read is what the protocol defines.

**Each row is a different store, not a different view of one.** *TraceQL - Native* reads the SkyWalking spans and *TraceQL - Zipkin* the Zipkin ones, both converted to OTLP to answer. *TraceQL - OTLP* reads spans OAP stored exactly as they arrived, converting nothing — so attributes keep their own types, and events, links, status messages and the instrumentation scope are what the SDK exported. Where a deployment's OTLP traces live depends on how its receiver was configured to keep them, and only one of the two rows will hold them.

The OTLP row also has fields the other two cannot offer: the `kind` intrinsic, `resource.service.instance.id`, and Tempo's `span:`-prefixed spellings. The **Schema reference** on each row lists what that store can filter, which is the shortest way to see the difference.

The one reading Horizon does add is the span kind. OTLP has no entry and exit — it has client, server, producer and consumer — so the views name them the way every other trace surface does: a **server** or **consumer** span is an **Entry** (a call or a message arriving), a **client** or **producer** span an **Exit** (one leaving), and an **internal** span is **Local**. The protocol's own word is shown beside it on the span detail, in the statistics table and in the waterfall's tooltip, so nothing about the OTLP data is hidden behind the reading.

The page is laid out like the native one — conditions and a duration distribution on top, results below, the trace opening beside the list — and the same Default / Tree / Statistics views, span dialog, and trace-id and URL copy buttons are there.

### Three ways to query

The switch beside the title picks between:

- **Builder** — rows filled from the store: service, span name, status, a duration range, and span tags, with a result **Limit** and the **Time range**. The expression it produces is shown under the rows, and **Edit as TraceQL** carries it into the editor.
- **TraceQL** — the expression by hand, with highlighting, a **Schema reference** listing the fields and tags this store reports, and autocomplete for fields and for a tag's values. **Shift+Enter** runs it.
- **Trace ID** — up to 20 ids, each locked in with **Enter**, with a **Time range** that starts at **No time range**. This API reads one id per request, so the ids are read one after another; anything past the 20th is reported as skipped rather than read.

Nothing is queried until you press **Run query**.

### What the editor checks

Horizon checks one thing: that the query names fields it can place in this store's **schema**. Open **Schema reference** under the editor to see them — the intrinsics `duration`, `name` and `status`, the resource attributes for that store, and the span tags it reported for the window you are querying. Clicking any of them inserts it.

It checks the SHAPE of a field, not the spelling of a tag: `span.typo` passes, because the tag list is what the store happened to report for the window you are querying rather than the set of tags that exist, and flagging a tag nothing carried in the last hour would be wrong more often than right.

What appears under the query:

- **A field the schema cannot place.** An attribute needs a scope — `span.http.method`, `resource.service.name`, or the unscoped form with a leading dot, `.http.method`. Written bare, `http.method` is neither an intrinsic nor a scoped attribute, and is flagged; so is a bare name that is not one of the three intrinsics, and a resource attribute belonging to the other store (`resource.instance` is native, `resource.remote.service` is Zipkin).
- **A `status` the language does not define.** It takes `ok`, `error` or `unset`.
- **An expression that is not one complete spanset**, or a condition left without a value — `{duration>` on its own.

**Every finding is a warning, and the query always runs.** Horizon does not predict what the backend will do with a form it parsed: which parts of TraceQL a given OAP applies is a property of that build, and a query it accepts but answers wrongly is a bug worth reporting upstream, not something to guess at here. If the source refuses a query, its own message appears where the results would be.

### Time range

The tab carries its own **Time range**, from *Last 15 min* to *Last 24 hours* or a **Custom range…** with absolute From / To values, and the topbar's global picker is disabled while you are on it — as it is on every trace row. Nothing re-reads on a timer: the window is captured when you press **Run query**, so an auto-refresh tick cannot widen a search you are reading.

A **From** / **To** field takes `YYYY-MM-DD HH:mm` — the same order in every language — and the button beside it opens a calendar whose month and weekday names follow the language picked in Horizon, not the browser's. Type the value or pick it; the field commits once the whole thing is there, so a half-typed date never runs a query. A custom range spans at most **7 days**, and **Run query** stays disabled while the pair is incomplete or inverted, with the reason under the field.

### Service picker

The TraceQL API has no notion of a layer: it lists every service of the underlying store. A layer can carry a regular expression that narrows its **picker** to the services it owns; result rows are never filtered by it, so cross-service traces still appear.

## Looking a trace up by its id

On the **Traces** and **Zipkin Traces** tabs, the **Filter** / **Trace ID** switch beside the title picks how the tab queries. (The TraceQL rows have their own three-way switch, described above, and no **Cold** control — the Tempo API has no cold-stage parameter.) On **Trace ID** the conditions give way to an id field and a **Time range**, and **Run query** reads the id within that range — with no service (not even the one picked in the layer header) and no other condition — and refuses to run without an id. Switching back to **Filter** finds the conditions as you left them. Nothing is read until you press **Run query**: switching, or pressing **Enter** in the id field, reads nothing.

- **Time range** starts at **No time range**, which finds the trace wherever the hot and warm stages keep it. A preset or **Custom…** searches only that range — the only way to reach the cold stage, with **Cold** on.
- On the native tab, paste one trace id. On a backend that lists segments, the trace's segments are listed — up to 100, and the list says when there are more.
- On the Zipkin tab, paste an id and press **Enter** to lock it in as a chip, and add as many as you need; **Run query** reads them all at once. Ids are shown the way Zipkin stores them — lower-case, padded to 16 or 32 hex digits — and a value that is not a trace id is refused with the reason under the field. The ids that matched nothing are named above the results.

With **No time range**, OAP 11.0.0 and earlier on BanyanDB look an id up in the last 24 hours only, and no lookup reaches the cold stage. On OAP 11.0.0 and earlier a Zipkin lookup ignores the time range you pick.

## Troubleshooting

- **"No traces in window."** — the query ran but matched nothing. Widen the time range, relax the Status / Duration / Tag conditions, or confirm the service is actually reporting traces.
- **An `unreachable` chip on the list** — the trace store did not answer, and the reason is printed in a banner above the results. For native traces this points at OAP or its storage backend; for Zipkin it points at the configured Zipkin endpoint; for a TraceQL row it points at that datasource's URL, or says no URL is configured for it. The stores fail independently — one being down does not blank the others.
- **A TraceQL search comes back refused** — the message under the results is OAP's own. It answers what that deployment can do with the query you sent, which is a property of the OAP you are running rather than of Horizon; take it to the OAP side.
- **A TraceQL row says the source is not configured** — its URL is empty in `oap.traceql`. A URL that IS set but does not answer reads **unreachable** instead: the module is off in OAP, or the port is wrong. See [TraceQL trace stores](../setup/oap.md#traceql-trace-stores-oaptraceql).
- **A TraceQL result's status is unknown rather than OK** — the Tempo search response carries no verdict of its own, so Horizon settles each row from the markers a span carries and then, once the list is on screen, by reading the traces still undecided; the list header counts those down. What survives is a trace no span spoke for: none set a status, and none carried a marker either — see [How a span's status is decided](#how-a-spans-status-is-decided). That is not turned into a success. Running the query again restarts the check.
- **Run query is greyed out** — the tab does not yet know which service to read. It says which: *Resolving service…* while the picked service is being looked up, or a note that the selected service is not in this layer (it aged out of OAP, was renamed, or the link points elsewhere) — pick another one. The native and Zipkin tabs read for one service, so they wait instead of querying the whole layer — a lookup by trace id needs none, and the TraceQL rows can search **All services**, because the Tempo API takes a service as an ordinary condition rather than as the subject of the query.
- **Rows are segments, not whole traces** — that is expected on storage backends without whole-trace support; the banner says so. Click a segment to fetch its full trace.
- **A trace looked up by its id is not found** — a time range you picked has to cover when the trace happened, so widen it or pick **No time range**. With no time range, OAP 11.0.0 and earlier on BanyanDB cover only the last 24 hours, and the cold stage is not read. Open the trace from the log row that named it (which carries its timestamp), or pick a time range around when it happened, with **Cold** on if it has aged into cold storage.
- **No data even with a valid service** — double-check the time range first; this tab does not follow the global topbar, so the window is whatever the tab's own Time range control says.

## Related

- [Trace Inspect](trace-inspect.md) — the cross-layer trace query tool: look up a trace by id or query any service (picked, typed by name, or all of them) without entering a layer.
- [3D Infrastructure Map](infra-3d-map.md) — topology-level view of the same services these traces flow through.
- [Metrics Inspect](inspect.md) — confirm which metrics a service is reporting when traces look incomplete.
- [Layer Dashboard Templates](../customization/layer-templates.md) — where a layer's trace stores are configured.
