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
# WeChat Mini Program

The **WECHAT_MINI_PROGRAM** layer holds WeChat (微信) Mini Programs monitored by the SkyWalking mini-program agent. The agent runs inside the mini-program runtime and reports client-side performance — app launch, first render, package load, page routing, script execution, and outbound request timing — so each mini-program lands here rather than in a server-side layer.

In Horizon's sidebar this layer is named **WeChat Mini Program** (under the **Mobile** group). Its services are listed as **Mini-programs**, instances as **Versions** (one per released mini-program version), and endpoints as **Pages** (one per mini-program page). The layer enables the Service, Version, Page, Traces, and Logs sub-tabs. It has no service map, instance map, or page-dependency view — mini-program telemetry is client-side timing, with no inter-service call topology to draw.

This page is the **operator reference** for the bundled WECHAT_MINI_PROGRAM dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled WECHAT_MINI_PROGRAM template; if an operator has published a customized template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Mini-program list

Before opening a mini-program, the layer landing page lists every WECHAT_MINI_PROGRAM service with four sortable columns, sorted by request traffic (**Request RPM**) by default:

- **Request RPM** — outbound requests per minute (`meter_wechat_mp_request_cpm`).

- **Launch** — average app-launch duration in ms (`meter_wechat_mp_app_launch_duration`).

- **First Render** — average first-render duration in ms (`meter_wechat_mp_first_render_duration`).

- **Errors** — count of reported errors (`meter_wechat_mp_error_count`).

## Service dashboard

The primary drill-down for one selected mini-program.

- **App Launch Duration** — time to launch the mini-program, in ms (`meter_wechat_mp_app_launch_duration`).

- **First Render Duration** — time to the first render, in ms (`meter_wechat_mp_first_render_duration`).

- **Package Load Duration** — time to download and parse the mini-program package bundle, in ms (`meter_wechat_mp_package_load_duration`).

- **Error Count** — number of errors reported by the mini-program (`meter_wechat_mp_error_count`).

- **Route Duration** — time spent in page-route transitions, in ms (`meter_wechat_mp_route_duration`).

- **Script Duration** — script-execution time, in ms (`meter_wechat_mp_script_duration`).

- **Request Load** — outbound requests per minute (`meter_wechat_mp_request_cpm`).

- **Request Duration Percentile** — p50 / p75 / p90 / p95 / p99 of outbound request duration, in ms — the tail of the request-timing distribution (`meter_wechat_mp_request_duration_percentile`).

## Version dashboard

For one selected released **Version** of the mini-program. The same timing families as the service dashboard, evaluated at version (instance) scope so you can compare one release against another.

- **Launch Duration** — app-launch duration for this version, in ms (`meter_wechat_mp_instance_app_launch_duration`).

- **First Render Duration** — first-render duration for this version, in ms (`meter_wechat_mp_instance_first_render_duration`).

- **Package Load Duration** — package download-and-parse time for this version, in ms (`meter_wechat_mp_instance_package_load_duration`).

- **Request Load** — outbound requests per minute for this version (`meter_wechat_mp_instance_request_cpm`).

- **Route Duration** — page-route transition time for this version, in ms (`meter_wechat_mp_instance_route_duration`).

- **Script Duration** — script-execution time for this version, in ms (`meter_wechat_mp_instance_script_duration`).

- **Request Duration Percentile** — p50 / p75 / p90 / p95 / p99 of outbound request duration for this version, in ms (`meter_wechat_mp_instance_request_duration_percentile`).

## Page dashboard

For one selected **Page** (endpoint) of the mini-program.

- **Launch Duration on Page** — app-launch duration attributed to this page, in ms (`meter_wechat_mp_endpoint_app_launch_duration`).

- **First Render Duration** — first-render duration for this page, in ms (`meter_wechat_mp_endpoint_first_render_duration`).

- **Request Load** — outbound requests per minute originating from this page (`meter_wechat_mp_endpoint_request_cpm`).

- **Request Duration Percentile** — p50 / p75 / p90 / p95 / p99 of outbound request duration for this page, in ms (`meter_wechat_mp_endpoint_request_duration_percentile`).

## Requirements

The WECHAT_MINI_PROGRAM dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs:

- **Mini-program (service) metrics** — the `meter_wechat_mp_*` family at service scope: app launch, first render, package load, route, script, error count, request load, and request-duration percentile.

- **Version (instance) metrics** — the `meter_wechat_mp_instance_*` family, the same timings reported per released version.

- **Page (endpoint) metrics** — the `meter_wechat_mp_endpoint_*` family, the launch / first-render / request-load / request-percentile timings reported per page.

These metrics come from the WeChat Mini Program agent reporting client-side timing to OAP, where the mini-program meter rules aggregate them. Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so the Version and Page dashboards stay empty until that level of data is reported. See the [WeChat Mini Program monitoring setup](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-wechat-mini-program-monitoring/) for enabling the receiver and meter rules on OAP.
