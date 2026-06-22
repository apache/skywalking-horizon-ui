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
# Browser

The **BROWSER** layer is where SkyWalking's browser agent (the client-side JavaScript SDK) reports. It is real-user monitoring: page views, front-end errors, page-load timing, and Core Web Vitals collected from the visitor's browser rather than from a server-side agent.

In Horizon's sidebar this layer is named **Browser**. Its top-level entities are web applications, listed as **Apps**; each app reports under one or more **Versions** (the instance slot), and each app serves a set of **Pages** (the endpoint slot). So where the GENERAL layer reads "Service / Instance / Endpoint", BROWSER reads "App / Version / Page". The layer enables the App, Version, and Page dashboards, plus the Traces tab and a **Browser Logs** tab — the per-page front-end error stream, which can de-obfuscate a minified JavaScript stack against a source map you upload. BROWSER has no service topology; there is no map view.

This page is the **operator reference** for the bundled BROWSER dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled BROWSER template; if an operator has published a customized BROWSER template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## App list

Before opening an app, the layer landing page lists every BROWSER app with three columns, sorted by traffic (**Page Views**) by default:

- **Page Views** — page views per minute (`browser_app_pv`).

- **Error Rate** — percent of page views that recorded an error (`browser_app_error_rate/100`).

- **Errors** — total front-end errors in the window (`browser_app_error_sum`).

## App dashboard

The primary drill-down for one selected app.

- **App Load (PV)** — page views per minute for the app (`browser_app_pv`).

- **App Error Rate** — percent of page views that recorded an error (`browser_app_error_rate/100`).

- **App Error Count** — total front-end errors per minute (`browser_app_error_sum`).

- **Top Hot Pages** — the app's busiest pages, with tabs to re-rank by **PV** (`browser_app_page_pv`, /min), **Errors** (`browser_app_page_error_sum`), and **Error Rate** (`browser_app_page_error_rate`, %), worst-first. Click a row to jump into that page.

- **Top Versions** — the app's versions broken down the same three ways: **PV** (`browser_app_single_version_pv`, /min), **Errors** (`browser_app_single_version_error_sum`), and **Error Rate** (`browser_app_single_version_error_rate`, %).

## Version dashboard

For one selected app **Version** — the per-release view of the same load and error signals.

- **Version PV** — page views per minute for this version (`browser_app_single_version_pv`).

- **Version Error Rate** — percent of this version's page views that recorded an error (`browser_app_single_version_error_rate/100`).

- **Version Error Count** — total front-end errors per minute for this version (`browser_app_single_version_error_sum`).

## Page dashboard

For one selected **Page** — the deepest scope, where browser timing and Web Vitals live. This is the page-performance view: most of these metrics exist only at page scope.

- **First Meaningful Paint Percentile** — p50 / p75 / p90 / p95 / p99 of FMP latency for the page, in ms (`browser_app_page_fmp_percentile`). Below 1s at p75 is a common target.

- **Page Load Percentile** — p50 / p75 / p90 / p95 / p99 of full page-load time, in ms (`browser_app_page_load_page_percentile`).

- **Time-to-Live Percentile** — p50 / p75 / p90 / p95 / p99 of the page's time-to-live, in ms (`browser_app_page_ttl_percentile`).

- **First Pack Latency Percentile** — p50 / p75 / p90 / p95 / p99 of first-pack latency, in ms (`browser_app_page_first_pack_percentile`).

- **Page Performance Breakdown** — average time spent in each phase of the page load, in ms, on one chart: DNS, redirect, TCP, TTFB, transfer, DOM analysis, DOM ready, FPT, load, and resource (`browser_app_page_dns_avg`, `browser_app_page_redirect_avg`, `browser_app_page_tcp_avg`, `browser_app_page_ttfb_avg`, `browser_app_page_trans_avg`, `browser_app_page_dom_analysis_avg`, `browser_app_page_dom_ready_avg`, `browser_app_page_fpt_avg`, `browser_app_page_load_page_avg`, `browser_app_page_res_avg`).

- **Page Errors by Type** — front-end error counters per minute split by source: resource, JS, AJAX, and unknown (`browser_app_page_resource_error_sum`, `browser_app_page_js_error_sum`, `browser_app_page_ajax_error_sum`, `browser_app_page_unknown_error_sum`).

- **Web Vitals** — Core Web Vitals as averages per minute: FMP (ms), LCP (ms), and CLS (`browser_app_web_vitals_fmp_avg`, `browser_app_web_vitals_lcp_avg`, `browser_app_web_vitals_cls_avg / 1000` — CLS is scaled down to its typical 0 – 1 score range).

- **Interaction to Next Paint Percentile** — p50 / p75 / p90 / p95 / p99 of INP, in ms (`browser_app_web_interaction_inp_percentile`). INP is the responsiveness metric that replaces FID.

## Requirements

The BROWSER dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, your front-end must run the SkyWalking browser agent (the client-side JavaScript SDK) reporting to OAP, which produces:

- **App metrics** — the `browser_app_*` family (page views, error rate, error sum), produced by OAP from browser-agent reports, for the App list and App dashboard.

- **Version metrics** — `browser_app_single_version_*` (PV, error rate, error sum) for the Top Versions widget and the Version dashboard.

- **Page metrics** — `browser_app_page_*` (PV, errors, the timing percentiles, and the per-phase performance averages) and the `browser_app_web_vitals_*` / `browser_app_web_interaction_*` families for the Page dashboard.

Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so a version- or page-scope metric is empty until that level of data is reported. BROWSER carries no relation metrics, so it has no topology or map view.
