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

The Traces tab is the distributed-trace explorer inside a layer. You pick a service, set conditions (status, sort, duration, tags, time window), run the query, then click a result to read its span timeline. It surfaces two trace stores — SkyWalking-native traces and Zipkin traces — depending on what the layer is configured for.

Traces are triage data, so this tab owns its own time range and conditions. It is not driven by the global topbar time picker, and it does not auto-refresh: you set your conditions and press **Run query**. Nothing is fetched until you do — until then the list shows a "Pick your conditions, then click Run query." prompt.

## Which trace store appears

A layer template carries a `traces.source` setting that decides which trace store the tab queries:

- **`native`** (the default when a layer has no `traces` block) — only the SkyWalking-native trace explorer.
- **`zipkin`** — only the Zipkin trace explorer.
- **`both`** — two separate sidebar tabs, Trace (native) and Zipkin Trace. Native and Zipkin spans have different shapes and different query conditions, so they are kept as distinct tabs rather than one tab with a toggle.

Mesh and Kubernetes-flavored layers commonly land on Zipkin; instrumented-agent layers land on native.

## Native traces

The native explorer queries SkyWalking's own trace store. The service is taken from the layer's Service header picker at the top of the page; the in-tab conditions narrow within that service.

### Conditions

All conditions are staged in the toolbar and only take effect on **Run query** — editing a field does not refetch on its own.

| Condition | What it does |
|---|---|
| Instance | Restrict to one service instance. Defaults to All. Resets when you switch service. |
| Endpoint | Restrict to one endpoint. Defaults to All. A dropdown of the service's endpoints (capped at 50). |
| Status | `ALL`, `SUCCESS`, or `ERROR` — the trace state. |
| Order | `BY_START_TIME` (Newest) or `BY_DURATION` (Slowest). |
| Limit | Cap on result rows: 30 by default. The server caps a single page at 200. |
| Time range | A rolling preset (Last 15 min through Last 24 hours) or a Custom… absolute start/end pair. |
| Trace ID | Paste a known trace id to look it up directly. |
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
| Open trace ID | Paste a trace id to open it directly. |
| Limit | Result cap: 10, 30, 50, 100, or 200. |
| Time range | A lookback preset (Last 15 min through Last 24 hours) or a Custom range… absolute window. |

As with the native tab, conditions are staged and only applied on **Run query**.

Each Zipkin result shows its duration and error state, with a duration bar colored fast-to-slow (errored traces are forced to the error color). Selecting a trace renders the Zipkin span waterfall, and a span detail panel exposes the span's duration, kind, and Zipkin tags. Because the two stores have different span formats, there is no field mapping between native and Zipkin results — Zipkin spans keep their Zipkin shape.

## Troubleshooting

- **"No traces in window."** — the query ran but matched nothing. Widen the time range, relax the Status / Duration / Tag conditions, or confirm the service is actually reporting traces.
- **An `unreachable` chip on the list** — the trace store did not answer. For native traces this points at OAP or its storage backend; for Zipkin it points at the configured Zipkin endpoint. The two stores fail independently — one being down does not blank the other.
- **Rows are segments, not whole traces** — that is expected on storage backends without whole-trace support; the banner says so. Click a segment to fetch its full trace.
- **A pasted trace id from a log row won't resolve** — older traces can sit outside the default lookup window or in a cold storage tier. Open the trace from the log row (which carries its timestamp) rather than pasting the id cold, so the lookup is widened around the right time.
- **No data even with a valid service** — double-check the time range first; this tab does not follow the global topbar, so the window is whatever the tab's own Time range control says.

## Related

- [3D Infrastructure Map](infra-3d-map.md) — topology-level view of the same services these traces flow through.
- [Metrics Inspect](inspect.md) — confirm which metrics a service is reporting when traces look incomplete.
- [Layer Dashboard Templates](../customization/layer-templates.md) — where a layer's `traces.source` is configured.
