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

# Logs

Horizon surfaces logs through two distinct tabs, each backed by a different OAP source.

The **Logs** tab queries the logs SkyWalking has *collected and stored* — application and service log records, indexed and filterable, correlated with traces. The **Pod Logs** tab does something different: it live-tails a Kubernetes pod's container logs *on demand*, pulled straight from the Kubernetes API through OAP and never persisted. They appear as separate tabs because they answer different questions — "what did this service log over the last half hour?" versus "what is this pod printing to stdout right now?".

Which tabs a layer shows depends on the layer template. The **Logs** tab appears on layers whose template enables it (for example `GENERAL`, `MESH`, `MESH_DP`, `NGINX`, `ENVOY_AI_GATEWAY`, the mini-program and mobile layers). The **Pod Logs** tab appears only on the Kubernetes-aware layers `K8S_SERVICE`, `MESH`, and `MESH_DP`.

For browser JavaScript errors reported by the browser agent — a separate stream with its own source-map de-obfuscation — see [Browser Logs & Source Maps](browser-source-maps.md). That is not the same as the collected service logs described here.

## Stored logs

Open a layer that has a **Logs** tab and pick a service in the header. The stored log stream loads for that service over the page's own time range, newest first.

### Scoping and filtering

The conditions bar narrows the stream. Every filter is optional; together they are AND-joined.

- **Instance** — restrict to one service instance. The default is **All**. On a sidecar layer this picker is labelled **Sidecar**.

- **Endpoint** — restrict to one endpoint. Type to search the endpoint list, then click a result to pin it; the **×** clears it back to **All**.

- **Trace ID** — paste a trace id to show only the log lines correlated with that trace. This is also how a log lands when you arrive from a trace — the field pre-fills and the stream is already scoped.

- **Tags** — a single `key=value` field with autocomplete. Start typing a key to see suggested keys; type `=` to switch the suggestions to known values for that key; press **Enter** to commit the tag. Committed tags show as removable chips under the bar and ride along on the query as additional filters.

- **Level** — the **Levels** strip above the stream doubles as a filter. Click `error`, `warn`, `info`, or `debug` to show only that level; click again to clear. The level filter is sent to OAP as a `level` tag, so pagination and counts reflect the filtered set. The `other` chip (lines whose level tag is missing or unrecognized) is informational only — it has no server-side value to filter on, so it is not clickable.

Edits to the conditions refresh the stream automatically. **Run query** is the explicit "I'm done editing, refresh now" button and resets to the first page.

### Time range

The **Logs** tab owns its own time range — the global topbar time picker is paused while you are here, so auto-refresh won't shift the window mid-investigation. Pick a rolling preset (**Last 15 min** through **Last 24 hours**, default **Last 30 min**) or choose **Custom…** to pin an absolute start/end with two date-time inputs.

Log queries use **second-precision** time windows. Logs are record-style data anchored at second granularity, so the window is not rounded to the minute — the most recent (and usually most interesting) lines are never chopped off. The window is capped at **7 days**; longer custom ranges are clamped.

### Reading the stream

A **density histogram** sits above the stream: time on the x-axis, log count on the y-axis, each bar stacked by level (error / warn / info / debug / other) with the same colour as the legend. Hover a bar to see that bucket's time range and per-level counts. The histogram is built from the **currently loaded page**, so it shows the shape of what is on screen, not the whole window.

The **Levels** strip carries a count per level next to each chip. Those counts come from a window-scoped sample (a few hundred of the most recent rows in the window, larger than one page), so they reflect the window's level distribution rather than only the visible page. The strip notes the sample size it used.

Each row shows the timestamp, the level, the service (with any group prefix decoded), an **↗ trace** link when the line is trace-correlated, a format chip (`JSON` / `YAML` / `TEXT`), and a one-line preview of the content. Rows are colour-keyed by level.

Horizon renders the payload according to its content. OAP labels payloads as JSON or plain text; on top of that, Horizon sniffs for JSON and YAML structure so an unlabelled-but-structured body still gets the right treatment. JSON is compacted to a single line in the preview and pretty-printed in the detail view; YAML keeps its keys; plain text is whitespace-collapsed.

Click a row to open the full payload in a popout: the complete content, format-aware pretty-printing, a **Copy** button, the service / instance / endpoint / trace context, and a table of all tags on the line. If the line is trace-correlated, an **↗ trace** button there (and the **↗ trace** link on the row) opens the related [trace's](traces.md) waterfall in an overlay without leaving the log stream — the row's timestamp is passed along so the trace is found even when it sits in a colder storage tier. Press **Escape** or click the backdrop to close.

The pager at the foot shows the current page and the row count on it; **Prev** / **Next** walk the pages, and the page size (**20**, **50**, or **100**) is set on the conditions bar.

### Troubleshooting stored logs

- **No rows returned.** Confirm the service actually ships logs to OAP, that the storage backend has the logs module enabled, and that the time range covers when the logs were produced. Narrow filters (a tag, a level, an endpoint) can also empty the result — clear them and widen the window.

- **A filter empties the stream.** Tag and level filters are exact-match on indexed dimensions. A `level` value or tag value that doesn't exist in the stored data returns nothing; check the value against what the **Levels** counts and the tag autocomplete actually offer.

## Pod logs

The **Pod Logs** tab tails a Kubernetes pod's container logs live. There is no stored history to page through — each refresh pulls the trailing window straight from the Kubernetes API through OAP, shows it, and discards it. Nothing is persisted.

### Starting a tail

1. Pick a service in the header, then pick a **Pod** (a service instance) — the page is pinned to one pod at a time.
2. Pick a **Container**. Horizon lists the pod's containers and auto-selects the first; switch if the pod runs more than one.
3. Choose the look-back **Window** (**Last 30s**, **1m**, **5m**, **15m**, or **30m**) — how far back each poll reaches.
4. Choose the poll **Interval** (**2s**, **5s**, **10s**, or **30s**) — how often the window is re-fetched while live.
5. Press **Start**. The trailing window streams into a read-only viewer and re-polls on the interval until you press **Pause**. The header shows a live indicator, the line count, and how long ago the view last updated.

Changing the container, window, interval, or filters while tailing re-runs the query with the new settings. The viewer is read-only and keeps the newest line in view as fresh logs arrive.

### Include and exclude filters

Two filter rows narrow what the tail shows. **Include** keeps only lines that match; **Exclude** drops lines that match. Type an expression and press **Enter** to add it as a chip; the **×** on a chip removes it. Both are evaluated by OAP as **full-line regular expressions** (for example `.*error.*`), so they match against the whole log line, not a substring. Multiple expressions in a row stack as additional conditions.

### Time precision

Pod-log windows are **second-precision** — this is a live tail, anchored at the current second. OAP caps a single tail window at **30 minutes**; the longest selectable window is **Last 30m**.

### Troubleshooting pod logs

On-demand pod logs are **disabled by default on OAP** because container logs can leak secrets. When the feature is off, or when the pod can't be resolved, OAP returns a reason instead of data and Horizon shows it in a banner rather than an empty pane. Two common cases:

- **"Logs unavailable" with a reason.** If the reason indicates the feature is off, enable on-demand pod logs on the OAP side. If it indicates the pod wasn't found, the instance you picked points at a pod that no longer exists (a finished rollout or a scaled-down replica) — pick a currently-running pod.

- **The tail stops on its own.** A pod that vanishes mid-tail (a rollout or scale-down) makes the next poll fail; Horizon stops the loop and surfaces the reason rather than spinning on errors. Re-pick a live pod and **Start** again.

## Permissions

Both tabs — stored log queries, tag autocomplete, the container list, and the on-demand tail — require the `logs:read` permission. See [Roles and Permissions](../access-control/rbac.md).
