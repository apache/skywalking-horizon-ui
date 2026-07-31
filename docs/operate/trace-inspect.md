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

# Trace Inspect

**Trace Inspect** (`/operate/trace-inspect`) is the cross-layer trace query tool in the sidebar. The per-layer [Traces](traces.md) tab starts from a layer and the service picked in its header; this page starts from nothing. Open it, name any service — or no service at all — and run one query across everything the trace store holds. It is built for the deep-dive that does not begin inside a dashboard: a trace id pasted from a log line or an alarm, a service you only know by name, or a "show me every error trace in the last hour, anywhere" sweep.

Like the other triage pages, it owns its own time range — the global topbar time picker does not apply — and nothing is fetched until you press **Run query**. Every condition is staged: edit as much as you like, then run.

## Sources

The **Source** toggle at the top switches between the two trace stores:

- **Native** — SkyWalking's own trace store, the same store the per-layer Traces tab queries.
- **Zipkin** — the Zipkin store behind OAP, with Zipkin's own service universe and query conditions.

On the per-layer tab, which store you see is decided by the layer template; here both are always one click away and you choose per query. Switching source clears the previous result so the two never mix.

## Target — pick it, type it, or leave it blank

For native traces the **Target** is optional: leaving it blank queries every service in the window. When you do want to scope it, there are two modes:

- **Pick** — choose a **Layer**, then a **Service** from that layer's catalog, then optionally narrow to one **Instance** and/or **Endpoint**. This is the discovery path: the dropdowns show you what exists.
- **Type** — enter a **Service name** directly, with a **Real** checkbox (leave it on for a normal instrumented service; turn it off for a virtual/peer service such as a database or remote endpoint that only exists as a conjectured node). **Instance** and **Endpoint** names are optional free text. Typing needs no layer at all — the name plus the Real flag identify the service.

The **→ edit as text** link converts the current Pick selection into the Type form — pick to discover, then tweak the name or flag by hand.

The **Zipkin** target is different because Zipkin has its own service universe (no layers, no SkyWalking ids): a **Service** field (blank means all services), plus **Remote service** and **Span name** narrowing fields whose suggestions load once a service is picked.

## Conditions

Native conditions:

| Condition | What it does |
|---|---|
| Trace ID | Paste a known trace id for a direct lookup. |
| Status | `ALL`, `SUCCESS`, or `ERROR`. |
| Order | Newest (by start time) or Slowest (by duration). |
| Duration (ms) | Min–max trace duration bounds, in milliseconds. |
| Tags | Comma-separated `key=value` pairs, AND-joined, with autocomplete (below). |
| Time | A rolling preset (15m, 30m, 1h, 3h, 6h, 12h, 24h) or **Custom…**, which swaps in an absolute start/end pair. The **×** returns to presets. |
| Limit | Result cap: 20, 30 (default), 50, or 100. |

Zipkin conditions are the store's own: **Duration (ms)** bounds, an **Annotation query** (`error` or `key=value` terms, AND-joined), plus the shared **Time** and **Limit**. There is no Trace ID field on the Zipkin side.

The **Tags** field autocompletes from the tags actually stored in the window: start typing to see known keys, type `=` to switch the suggestions to that key's known values, and press **Enter** to commit the pair — the field then primes a comma so you can keep typing the next one. Time windows are evaluated at second precision, same as the per-layer tab, so a trace that just finished still falls inside the window.

## Run query and the resolved query

**Run query** executes the staged conditions and replaces the result area. Next to it, a **Resolved query** toggle appears after each run: it names the source (and, for native, which trace query API answered) and expands to the exact condition that was sent — the service ids resolved from your picks or typed names, the computed window, and every filled-in default. When a query returns something unexpected, read this panel first: it shows what was actually asked, not what you meant.

## Distribution chart

Beside the conditions, a **Distribution** chart plots one dot per result — start time on the X axis, colored by success/error, with the duration surfaced on hover. Click a dot to open that trace, or drag a rectangle to brush a subset: the list below narrows to the brushed traces and shows an *N / total* count with a **clear** control. Brushing filters what is already loaded; it does not re-query.

## Results — segments or whole traces

For native traces, a banner above the results states which trace query API this OAP serves: on backends with whole-trace support (Trace Query v2) full traces come back inline; on any other backend (Trace Query v1) each row is a trace **segment** and clicking one fetches its full trace. This is a property of the storage backend, not a setting — see [Traces](traces.md) for the full explanation.

Clicking a row opens the same trace detail the per-layer tab uses: the span waterfall with its **Default** / **Tree** / **Statistics** layouts, per-span detail (meta, tags, logs, cross-trace refs, attached events), and the **id** / **url** copy buttons — a copied shareable URL reopens the trace in an overlay for whoever you send it to, on either store. While a trace is open, the result list folds into a collapsible rail on the left so you can step through traces without losing the query. **Escape** closes the span panel first, then the trace, in that order. Zipkin results render with the Zipkin waterfall and keep their Zipkin span shape.

## How it differs from the per-layer Traces tab

- **No layer, no header picker.** The target is part of the query form, optional, and can be a typed name — including services in layers you never open, or all services at once.
- **Both stores on one page.** Native vs. Zipkin is a per-query toggle here; on the layer tab it is fixed by the layer template.
- **Built for id-first triage.** Paste a trace id with no service at all and run — the common "a log/alarm gave me an id" entry point.

The waterfall, the distribution chart, the staged Run-query flow, and the v1/v2 behavior are identical to the per-layer tab — this page changes how you *scope* the query, not how results render.

## Permissions

The page and its queries require the `inspect:read` permission. Opening a trace's waterfall and the tag / Zipkin suggestion lists additionally use `traces:read`, and the Pick-mode layer/service dropdowns use `metrics:read` — the bundled roles that grant `inspect:read` include these. See [Roles and Permissions](../access-control/rbac.md).

## Related

- [Traces](traces.md) — the per-layer trace explorer, with the full waterfall and condition reference.
- [Log Inspect](log-inspect.md) — the cross-layer sibling for logs, browser errors, and pod tails.
- [Metrics Inspect](inspect.md) — the cross-layer view of OAP's metric catalog.
