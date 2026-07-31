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

# Log Inspect

**Log Inspect** (`/operate/log-inspect`) is the cross-layer log query tool in the sidebar. The per-layer [Logs](logs.md) tab starts from a layer and the service picked in its header; this page starts from nothing. Open it, name any service — or no service at all — and query across everything the log store holds. It unifies three log sources on one page: the stored log stream, browser JavaScript errors, and on-demand Kubernetes pod tails.

Like the other triage pages, it owns its own time range — the global topbar time picker does not apply — and (for the stored sources) nothing is fetched until you press **Run query**. Conditions are staged; switching source clears the previous result so streams never mix.

## Sources

The **Source** toggle at the top picks what kind of logs you are after:

- **Raw** — the logs SkyWalking has collected and stored: the same store as the per-layer Logs tab, queried across every layer.
- **Browser** — the JavaScript errors reported by the browser agent, with inline source-map management and per-row stack de-obfuscation.
- **Kubernetes Pod logs** — a live tail of one pod's container output, pulled through OAP on demand and never persisted.

## Target — pick it, type it, or leave it blank

For the **Raw** and **Browser** sources the **Target** is optional: blank queries every service in the window. Two modes scope it:

- **Pick** — choose a **Layer**, then a **Service** from its catalog, then optionally an **Instance** and/or **Endpoint**. On the Browser source these last two are labelled **Version** and **Page**, because that is what a browser app's instances and endpoints are.
- **Type** — enter a **Service name** directly, with a **Real** checkbox (off for a virtual/peer service), plus optional instance/endpoint (version/page) names. Typing needs no layer.

The **→ edit as text** link converts the current Pick selection into the Type form. Raw and Browser share one target, so switching between them keeps your pick; only crossing into or out of the pods source resets it.

## Raw — stored logs across layers

Conditions for the stored stream:

| Condition | What it does |
|---|---|
| Tags | Comma-separated `key=value` pairs, AND-joined, with autocomplete: type to see known keys, type `=` for that key's known values, **Enter** commits the pair and primes a comma for the next. Filter by level with a `level=…` tag. |
| Trace ID | Show only the lines correlated with one trace. |
| Time | A rolling preset (15m, 30m, 1h, 3h, 6h, 12h, 24h) or **Custom…** with an absolute start/end pair. Second-precision, like the per-layer tab. |
| Limit | Result cap: 20, 50 (default), 100, or 200. The server additionally caps a single batch at its configured page-size limit (100 by default), so 200 only takes effect when that limit has been raised — see the query-limits section of the [horizon.yaml reference](../setup/horizon-yaml.md). |

**Run query** fetches one batch of the newest matching lines. Rows render exactly as on the per-layer tab — timestamp, level, service, an **↗ trace** link when trace-correlated, a format chip, and a one-line preview — and clicking a row opens the same full-payload popout: format-aware pretty-printing, **Copy**, the service/instance/endpoint/trace context, and the tag table. The **↗ trace** links open the related trace's waterfall in an overlay without leaving the page. **Escape** or the backdrop closes the popout, and a re-run that no longer contains the open row closes it too.

Unlike the per-layer Logs tab there is no density histogram, no Levels strip, and no pager — this page returns a single batch capped by **Limit**. It trades the browsing chrome for reach: any service, any layer, or all of them at once.

## Browser — JS errors with source-map resolve

The Browser source queries the errors browser agents report, across every browser app at once if you leave the target blank. Its conditions are **Category** (All, or one of `AJAX`, `RESOURCE`, `VUE`, `PROMISE`, `JS`, `UNKNOWN`) plus the shared **Time** and **Limit**.

Below the conditions sits the **source-map manager** — the same map store the per-layer [Browser Logs](browser-source-maps.md) tab uses, managed inline so you never have to leave the page to make a stack readable. It lists the maps currently available (statically mounted ones and temporary uploads), shows the memory-usage bar, and offers **Upload .map** and per-upload remove. Uploaded maps live in server memory only; mounted maps cannot be removed here. If de-obfuscation is disabled on the server, the manager says so instead.

Results render as a dense error list: time, category (color-keyed), page, app version, and the message. Click a row to open the browser-error popout — the error's metadata and raw stack on one side, and the de-obfuscation control on the other: pick a hosted map (the first one is pre-selected), press **Resolve**, and read the original file/line/symbol frames with source snippets. Which map matches which build is your call — see [Browser Logs & Source Maps](browser-source-maps.md) for the matching rules and the resolvable categories.

## Kubernetes Pod logs — live tails without entering a layer

The pods source is the cross-layer twin of the per-layer Pod Logs tab: it tails one pod's container output straight from the cluster through OAP. Nothing is persisted — each poll pulls the trailing window and discards it — so the pod must be currently running.

Unlike the other two sources, the target here is **required**: a specific pod and container.

1. Pick a **Layer** and a **Service** (with exactly one Kubernetes-aware layer in your menu, the layer is pre-selected) — or switch the service field to **Type** and enter the service name directly, no layer needed.
2. Pick the **Pod** — the service instance. A single-pod service is auto-selected.
3. Pick the **Container** — the pod's containers are listed and the first is auto-selected.
4. Choose the trailing **Window** (Last 30s to Last 30m) and the poll **Interval** (2s–30s).
5. Press **Start** to tail live, **Pause** to stop, or **Refresh** for a one-shot fetch (which also pauses a running tail).

**Include** / **Exclude** chip fields narrow the lines: type a full-line regular expression (for example `.*error.*`) and press **Enter** to add it; the **×** removes a chip. Includes keep matching lines, excludes drop them, and changing them mid-tail re-runs with the new filters. Re-targeting the pod, container, or service stops the tail so a stale loop never bleeds across pods.

On-demand pod logs are disabled by default on OAP; when the feature is off or the pod no longer exists, the reason appears in a banner — see the pod-logs troubleshooting on the [Logs](logs.md) page, which applies here unchanged.

## Resolved query

For the Raw and Browser sources, a **Resolved query** toggle appears after each run: it names the source and expands to the exact condition that was sent — resolved service ids, computed window, filled-in defaults. When a query returns something unexpected, read it first. Pod tails are live fetches rather than stored-store queries, so they have no resolved-query panel.

## Permissions

The page and the raw/browser queries require the `inspect:read` permission. The tag autocomplete, the container list, and the pod tail additionally use `logs:read`; the source-map list and stack resolve use `browser-errors:read` (uploading or removing maps needs `source-map:write`); and the Pick-mode layer/service dropdowns use `metrics:read`. The bundled roles that grant `inspect:read` include the read verbs. See [Roles and Permissions](../access-control/rbac.md).

## Related

- [Logs](logs.md) — the per-layer stored-log stream and Pod Logs tab, with the full condition and troubleshooting reference.
- [Browser Logs & Source Maps](browser-source-maps.md) — source-map matching rules, static provisioning, and which error categories resolve.
- [Trace Inspect](trace-inspect.md) — the cross-layer sibling for traces.
- [Metrics Inspect](inspect.md) — the cross-layer view of OAP's metric catalog.
