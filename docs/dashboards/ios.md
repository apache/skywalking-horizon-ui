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
# iOS

The **IOS** layer is where SkyWalking's iOS client-side monitoring reports. An iOS app instrumented with the SkyWalking iOS SDK surfaces Apple **MetricKit** diagnostics — app launch time, hang time, abnormal exits, OOM kills, peak memory, scroll responsiveness, and network transfer — alongside the latency and success rate of the HTTP calls the app makes out to your backends. It sits in the **Mobile** group of layers.

In Horizon's sidebar this layer is named **iOS**. Its services are listed as **Apps**, instances as **App Sessions**, and endpoints as **Outbound APIs** — these are the names you see on the picker and column headers. The IOS layer enables the Service, Instance, and Endpoint sub-tabs plus Logs. It has no Topology, Traces, or endpoint-dependency view — iOS reports client-side device telemetry and outbound calls, not a server-side call graph.

This page is the **operator reference** for the bundled IOS dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled IOS template; if an operator has published a customized IOS template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## App list

Before opening an app, the layer landing page lists every IOS app with four sortable columns, sorted by **Launch (P95)** by default:

- **Launch (P95)** — 95th-percentile app launch time in ms (`meter_ios_app_launch_time_percentile{p='95'}`), the tail of how long the app takes to become usable.

- **Hang Time** — total time the main thread spent hung in the window, in ms (`meter_ios_hang_time_sum`).

- **Crashes** — abnormal exits, foreground and background summed (`meter_ios_foreground_abnormal_exit_count + meter_ios_background_abnormal_exit_count`).

- **Outbound RPM** — calls per minute the app makes to backends (`service_cpm`).

## App (service) dashboard

The primary drill-down for one selected app.

- **App Launch Time Percentile** — p50 / p75 / p90 / p95 / p99 launch time in ms, the distribution of how long the app takes to start (`meter_ios_app_launch_time_percentile`).

- **Hang Time Percentile** — p50 / p75 / p90 / p95 / p99 main-thread hang time in ms (`meter_ios_hang_time_percentile`).

- **Hang Time (sum)** — total hang time over the window, in ms (`meter_ios_hang_time_sum`).

- **Abnormal Exits (Crashes)** — abnormal exits split into **foreground** and **background** series; MetricKit reports the two separately (`meter_ios_foreground_abnormal_exit_count`, `meter_ios_background_abnormal_exit_count`).

- **OOM Kill Count** — background out-of-memory kills, the iOS system reaping the app under memory pressure (`meter_ios_background_oom_kill_count`).

- **Peak Memory** — peak resident memory in bytes (`meter_ios_peak_memory`).

- **Scroll Hitch Ratio** — the fraction of scroll frames classified as hitched; higher means a laggier scrolling UI (`meter_ios_scroll_hitch_ratio`).

- **Network Transfer** — bytes transferred over **wifi** vs **cellular**, download and upload, as four series (`meter_ios_wifi_download`, `meter_ios_wifi_upload`, `meter_ios_cellular_download`, `meter_ios_cellular_upload`).

- **Outbound HTTP** — the calls this app makes to backends, on a dual axis: **RPM** and **Avg latency (ms)** on the left axis, **Success Rate (%)** on the right (`service_cpm`, `service_resp_time`, `service_sla/100`).

## App Session (instance) dashboard

For one selected app session — the same MetricKit and outbound-HTTP families evaluated at session scope.

- **Launch Time Percentile** — p50 / p75 / p90 / p95 / p99 launch time in ms for the session (`meter_ios_instance_app_launch_time_percentile`).

- **Hang Time Percentile** — p50 / p75 / p90 / p95 / p99 hang time in ms for the session (`meter_ios_instance_hang_time_percentile`).

- **Abnormal Exits** — **foreground** vs **background** abnormal exits for the session (`meter_ios_instance_foreground_abnormal_exit_count`, `meter_ios_instance_background_abnormal_exit_count`).

- **OOM Kill Count** — background OOM kills for the session (`meter_ios_instance_background_oom_kill_count`).

- **Peak Memory** — peak resident memory in bytes for the session (`meter_ios_instance_peak_memory`).

- **Outbound HTTP** — the session's outbound calls on a dual axis: **RPM** and **Avg latency (ms)** on the left axis, **Success Rate (%)** on the right (`service_instance_cpm`, `service_instance_resp_time`, `service_instance_sla/100`).

## Outbound API (endpoint) dashboard

For one selected **Outbound API** — a backend endpoint the app calls.

- **Outbound Load** — calls per minute to the endpoint (`endpoint_cpm`).

- **Outbound Avg Latency** — average call latency in ms (`endpoint_resp_time`).

- **Outbound Success Rate** — percent of successful calls (`endpoint_sla/100`).

- **Outbound Latency Percentile** — p50 / p75 / p90 / p95 / p99 latency for the endpoint (`endpoint_percentile`).

## Requirements

The IOS dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs:

- **iOS MetricKit metrics** — the `meter_ios_*` family at service scope and the `meter_ios_instance_*` family at session scope: launch-time and hang-time percentiles, hang-time sum, foreground / background abnormal exits, background OOM kills, peak memory, scroll hitch ratio, and wifi / cellular network transfer. These are produced by OAP from the SkyWalking iOS SDK's MetricKit reports.

- **Outbound HTTP metrics** — the `service_*`, `service_instance_*`, and `endpoint_*` families (traffic, response time, SLA, percentiles), produced by OAP from the calls the app makes to instrumented backends.

Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so a session- or endpoint-scope metric is empty until that level of data is reported. When a family is missing, its widgets read `no data` rather than being shown with fabricated values.
