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
# APISIX

The **APISIX** layer monitors [Apache APISIX](https://apisix.apache.org/) API gateways. APISIX exposes its built-in Prometheus metrics, OpenTelemetry collects and forwards them to OAP, and OAP aggregates them into the `meter_apisix_*` families this dashboard renders. The layer key is **APISIX**, and in Horizon's sidebar it is grouped under **Gateways**.

In the sidebar this layer's services are listed as **APISIX services**, its instances as **Nodes** (the individual APISIX data-plane nodes), and its endpoints as **Routes** (the matched APISIX routes). The APISIX layer enables three scopes — Service, Instance (Node), and Endpoint (Route). It does not ship a topology, traces, or logs tab, so this dashboard is purely the metric drill-down across those three scopes.

This page is the **operator reference** for the bundled APISIX dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled APISIX template; if an operator has published a customized APISIX template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

Before opening a service, the layer landing page lists every APISIX service, sorted by request rate (**RPS**) by default, with four columns:

- **RPS** — total HTTP requests per second across the service's nodes (`meter_apisix_sv_http_requests`).

- **200/s** — `200`-status responses per second (`meter_apisix_sv_http_status_matched{code='200'}`).

- **404/s** — `404`-status responses per second (`meter_apisix_sv_http_status_matched{code='404'}`).

- **503/s** — `503`-status responses per second (`meter_apisix_sv_http_status_matched{code='503'}`).

The three status columns give an at-a-glance health read across the fleet — a service with a climbing `503/s` next to its `200/s` is shedding load.

## Service dashboard

The primary drill-down for one selected APISIX service. All eight widgets aggregate across the service's nodes.

- **HTTP Request Trend** — total requests per second for the service (`meter_apisix_sv_http_requests`).

- **HTTP Status Trend** — requests per second broken down by HTTP status code (`meter_apisix_sv_http_status_matched`, one line per `code`).

- **HTTP Latency** — request latency in ms, split by latency type and percentile (`meter_apisix_sv_http_latency_matched`).

- **HTTP Bandwidth** — ingress / egress bandwidth in KB, by type (`meter_apisix_sv_bandwidth_matched`, divided to KB).

- **HTTP Connections** — active connections by state — active, reading, writing, waiting (`meter_apisix_sv_http_connections`, one line per `state`).

- **Non-matched Status Trend** — requests per second by status code for traffic that hit no matching APISIX route (`meter_apisix_sv_http_status_unmatched`). Unmatched traffic is usually a misconfigured client or a probe; a rising line here is worth investigating.

- **Non-matched Latency** — latency in ms for the same no-matching-route traffic (`meter_apisix_sv_http_latency_unmatched`).

- **Non-matched Bandwidth** — bandwidth in KB for the same no-matching-route traffic (`meter_apisix_sv_bandwidth_unmatched`, divided to KB).

## Instance dashboard

For one selected node. These widgets are reported per node, so they show how one APISIX data-plane process is behaving.

- **HTTP Request Trend** — requests per second for the node (`meter_apisix_instance_http_requests`).

- **HTTP Status Trend** — requests per second by status code for the node (`meter_apisix_instance_http_status_matched`).

- **HTTP Latency** — request latency in ms for the node (`meter_apisix_instance_http_latency_matched`).

- **HTTP Bandwidth** — bandwidth in KB for the node (`meter_apisix_instance_bandwidth_matched`, divided to KB).

- **HTTP Connections** — connections by state for the node (`meter_apisix_instance_http_connections`).

- **Shared Dict** — the node's shared-memory dictionary capacity vs. free space in MB (`meter_apisix_instance_shared_dict_capacity_bytes` and `meter_apisix_instance_shared_dict_free_space_bytes`, divided to MB, labelled **capacity** / **free**). When free space approaches zero the node can no longer cache new entries.

- **etcd** — the node's view of the control-plane etcd: the latest known etcd index and whether etcd is reachable (`meter_apisix_instance_etcd_indexes` and `latest(meter_apisix_instance_etcd_reachable)`, labelled **indexes** / **reachable**). A node that can't reach etcd is no longer receiving config updates.

- **Non-matched Traffic** — a combined view of no-matching-route activity for the node: status, latency in ms, and bandwidth in KB on one chart (`meter_apisix_instance_http_status_unmatched`, `meter_apisix_instance_http_latency_unmatched`, and `meter_apisix_instance_bandwidth_unmatched` divided to KB).

## Endpoint dashboard

For one selected route. APISIX reports a tighter metric set at route scope — status, latency, and bandwidth.

- **HTTP Status Trend** — requests per second by status code for the route (`meter_apisix_endpoint_http_status`, one line per `code`).

- **HTTP Latency** — request latency in ms for the route, by type and percentile (`meter_apisix_endpoint_http_latency`).

- **HTTP Bandwidth** — bandwidth in KB for the route, by type (`meter_apisix_endpoint_bandwidth`, divided to KB).

## Requirements

The APISIX dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs APISIX metrics flowing in through the OpenTelemetry receiver:

- **Service metrics** — the `meter_apisix_sv_*` family (requests, status, latency, bandwidth, connections, and the unmatched-route counterparts), aggregated by OAP across a service's nodes.

- **Instance (node) metrics** — the `meter_apisix_instance_*` family, including the node-only `meter_apisix_instance_shared_dict_*` and `meter_apisix_instance_etcd_*` health metrics.

- **Endpoint (route) metrics** — the `meter_apisix_endpoint_*` family for the per-route status, latency, and bandwidth widgets.

These come from APISIX's Prometheus plugin scraped by an OpenTelemetry Collector and forwarded to OAP, which converts them into the `meter_apisix_*` metrics through its meter-analysis rules. Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so a route-scope or node-scope metric is empty until that level of data is reported. For the end-to-end collector and OAP setup, see the [APISIX monitoring](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-apisix-monitoring/) backend guide.
