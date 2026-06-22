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
# Alipay Mini Program

The **ALIPAY_MINI_PROGRAM** layer holds front-end real-user monitoring data reported from Alipay (支付宝) mini-programs. The mini-program monitoring agent feeds OAP launch, render, request, and error metrics from inside the Alipay container, and those land here.

In Horizon's sidebar this layer is grouped under **Mobile**. Its services are listed as **Mini-programs**, instances as **Versions** (each version of a published mini-program), and endpoints as **Pages**. The ALIPAY_MINI_PROGRAM layer enables the Service, Instance (Version), and Endpoint (Page) dashboards along with the Traces and Logs sub-tabs. It does **not** ship a topology / service-map view — mini-program RUM data has no call graph to draw.

This page is the **operator reference** for the bundled ALIPAY_MINI_PROGRAM dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled ALIPAY_MINI_PROGRAM template; if an operator has published a customized template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

Before opening a mini-program, the layer landing page lists every Mini-program with four sortable columns, sorted by traffic (**Request RPM**) by default:

- **Request RPM** — requests per minute (`meter_alipay_mp_request_cpm`).

- **Launch** — average app-launch duration in ms (`meter_alipay_mp_app_launch_duration`).

- **First Render** — average first-render duration in ms (`meter_alipay_mp_first_render_duration`).

- **Errors** — error count over the window (`meter_alipay_mp_error_count`).

## Service dashboard

The primary drill-down for one selected mini-program.

- **App Launch Duration** — the approximate cold-launch duration measured from the Alipay container, in ms (`meter_alipay_mp_app_launch_duration`).

- **First Render Duration** — time to first render, in ms (`meter_alipay_mp_first_render_duration`).

- **Error Count** — number of reported front-end errors (`meter_alipay_mp_error_count`).

- **Request Load** — requests per minute for the mini-program (`meter_alipay_mp_request_cpm`).

- **Request Duration Percentile** — p50 / p75 / p90 / p95 / p99 of request duration, the tail of the request-time distribution, in ms (`meter_alipay_mp_request_duration_percentile`).

## Instance dashboard

For one selected **Version** of the mini-program.

- **Launch Duration** — app-launch duration for this version, in ms (`meter_alipay_mp_instance_app_launch_duration`).

- **First Render Duration** — first-render duration for this version, in ms (`meter_alipay_mp_instance_first_render_duration`).

- **Request Load** — requests per minute for this version (`meter_alipay_mp_instance_request_cpm`).

- **Request Duration Percentile** — p50 / p75 / p90 / p95 / p99 of request duration for this version, in ms (`meter_alipay_mp_instance_request_duration_percentile`).

## Endpoint dashboard

For one selected **Page**.

- **Launch Duration on Page** — app-launch duration attributed to this page, in ms (`meter_alipay_mp_endpoint_app_launch_duration`).

- **First Render Duration** — first-render duration for this page, in ms (`meter_alipay_mp_endpoint_first_render_duration`).

- **Request Load** — requests per minute for this page (`meter_alipay_mp_endpoint_request_cpm`).

- **Request Duration Percentile** — p50 / p75 / p90 / p95 / p99 of request duration for this page, in ms (`meter_alipay_mp_endpoint_request_duration_percentile`).

## Requirements

The ALIPAY_MINI_PROGRAM dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs the Alipay mini-program meter families, reported by the Alipay mini-program monitoring agent:

- **Mini-program (service) metrics** — the `meter_alipay_mp_*` family at service scope: request load (`meter_alipay_mp_request_cpm`), launch and first-render duration (`meter_alipay_mp_app_launch_duration`, `meter_alipay_mp_first_render_duration`), error count (`meter_alipay_mp_error_count`), and the request-duration percentiles (`meter_alipay_mp_request_duration_percentile`).

- **Version (instance) metrics** — the `meter_alipay_mp_instance_*` family for the per-version widgets (launch, first render, request load, request percentile).

- **Page (endpoint) metrics** — the `meter_alipay_mp_endpoint_*` family for the per-page widgets (launch, first render, request load, request percentile).

Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so a version- or page-scope metric is empty until that level of data is reported. For how to enable the upstream collector, see the [Alipay Mini-Program monitoring](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-alipay-mini-program-monitoring/) setup docs.
