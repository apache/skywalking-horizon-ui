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
# Kong

The **KONG** layer monitors [Kong](https://konghq.com/) API gateways. Kong exposes its built-in Prometheus metrics, OpenTelemetry collects and forwards them to OAP, and OAP aggregates them into the `meter_kong_*` families this dashboard renders. The layer key is **KONG**, and in Horizon's sidebar it is grouped under **Gateways**.

In the sidebar this layer's services are listed as **Kong services**, its instances as **Nodes** (the individual Kong data-plane nodes), and its endpoints as **Routes** (the matched Kong routes). The KONG layer enables three scopes — Service, Instance (Node), and Endpoint (Route). It does not ship a topology, traces, or logs tab, so this dashboard is purely the metric drill-down across those three scopes.

This page is the **operator reference** for the bundled KONG dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled KONG template; if an operator has published a customized KONG template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

Before opening a service, the layer landing page lists every Kong service, sorted by request rate (**RPS**) by default, with four columns:

- **RPS** — total HTTP requests per second across the service's nodes (`aggregate_labels(meter_kong_service_http_requests,sum)`).

- **200/s** — `200`-status responses per second (`aggregate_labels(meter_kong_service_http_status{code='200'}, sum)`).

- **404/s** — `404`-status responses per second (`aggregate_labels(meter_kong_service_http_status{code='404'}, sum)`).

- **500/s** — `500`-status responses per second (`aggregate_labels(meter_kong_service_http_status{code='500'}, sum)`).

The three status columns give an at-a-glance health read across the fleet — a service whose `500/s` is climbing next to its `200/s` is failing requests upstream.

## Service dashboard

The primary drill-down for one selected Kong service. Every widget aggregates across the service's nodes.

- **HTTP Request Trend** — total requests per second for the service (`aggregate_labels(meter_kong_service_http_requests,sum)`).

- **HTTP Status Trend** — requests per second broken down by HTTP status code (`aggregate_labels(meter_kong_service_http_status,sum(code))`, one line per `code`).

- **HTTP Bandwidth** — ingress / egress bandwidth in KB/s, by direction (`aggregate_labels(meter_kong_service_http_bandwidth,sum(direction))`, divided to KB).

- **Kong Latency** — the time spent inside Kong itself (plugins and routing), in ms, averaged across percentiles (`aggregate_labels(meter_kong_service_kong_latency,avg(p))`).

- **Request Latency** — total request latency in ms — the time as seen by the client, averaged across percentiles (`aggregate_labels(meter_kong_service_request_latency,avg(p))`).

- **Upstream Latency** — the time spent waiting on the upstream service Kong proxies to, in ms, averaged across percentiles (`aggregate_labels(meter_kong_service_upstream_latency,avg(p))`). Comparing Kong Latency, Request Latency, and Upstream Latency tells you whether added latency is coming from the gateway or from the backend behind it.

- **Nginx Connections** — Kong's underlying Nginx connections by state (`aggregate_labels(meter_kong_service_nginx_connections_total,sum(state))`, one line per `state`).

- **Nginx Timers** — Nginx timers by state — running vs pending (`aggregate_labels(meter_kong_service_nginx_timers,sum(state))`, one line per `state`).

- **Datastore Reachable** — a per-instance table of whether each node can reach Kong's datastore (`latest(aggregate_labels(meter_kong_service_datastore_reachable,sum(service_instance_id)))`), with **Instance** and **Reachable** columns. A node that can't reach the datastore is no longer receiving config updates.

- **Nginx Metric Errors** — the latest count of errors Kong hit while exporting its own Nginx metrics (`latest(aggregate_labels(meter_kong_service_nginx_metric_errors_total,sum))`), shown as a single number — a non-zero value means metric collection on that service is degraded.

## Instance dashboard

For one selected node. These widgets are reported per node, so they show how one Kong data-plane process is behaving.

- **HTTP Request Trend** — requests per second for the node (`meter_kong_instance_http_requests`).

- **HTTP Status Trend** — requests per second by status code for the node (`meter_kong_instance_http_status`).

- **HTTP Bandwidth** — bandwidth in KB/s for the node (`meter_kong_instance_http_bandwidth`, divided to KB).

- **Kong Latency** — time spent inside Kong for the node, in ms (`meter_kong_instance_kong_latency`).

- **Request Latency** — total request latency for the node, in ms (`meter_kong_instance_request_latency`).

- **Upstream Latency** — upstream wait time for the node, in ms (`meter_kong_instance_upstream_latency`).

- **Datastore Reachable** — the latest datastore-reachability reading for the node, shown as a single number (`latest(meter_kong_instance_datastore_reachable)`).

- **Nginx Connections** — Nginx connections by state for the node (`meter_kong_instance_nginx_connections_total`).

- **Nginx Timers** — Nginx timers by state for the node (`meter_kong_instance_nginx_timers`).

- **Shared Memory Usage** — how full the node's Nginx shared-memory dictionaries are, as a percentage of total (`meter_kong_instance_shared_dict_bytes` over `meter_kong_instance_shared_dict_total_bytes`). When this approaches 100% the node can no longer cache new entries.

- **Worker Lua VM Usage** — memory used by the worker processes' Lua VMs, in MB (`meter_kong_instance_memory_workers_lua_vms_bytes`, divided to MB).

## Endpoint dashboard

For one selected route. Kong reports a tighter metric set at route scope — status, bandwidth, and the three latency views.

- **HTTP Status Trend** — requests per second by status code for the route (`meter_kong_endpoint_http_status`).

- **Total Bandwidth** — ingress / egress bandwidth in KB/s for the route (`meter_kong_endpoint_http_bandwidth`, divided to KB).

- **Kong Latency** — time spent inside Kong for the route, in ms (`meter_kong_endpoint_kong_latency`).

- **Request Latency** — total request latency for the route, in ms (`meter_kong_endpoint_request_latency`).

- **Upstream Latency** — upstream wait time for the route, in ms (`meter_kong_endpoint_upstream_latency`).

## Requirements

The KONG dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs Kong metrics flowing in through the OpenTelemetry receiver:

- **Service metrics** — the `meter_kong_service_*` family (requests, status, bandwidth, the Kong / request / upstream latency trio, Nginx connections and timers, datastore reachability, and the Nginx metric-error counter), aggregated by OAP across a service's nodes.

- **Instance (node) metrics** — the `meter_kong_instance_*` family, including the node-only `meter_kong_instance_shared_dict_*` and `meter_kong_instance_memory_workers_lua_vms_bytes` health metrics.

- **Endpoint (route) metrics** — the `meter_kong_endpoint_*` family for the per-route status, bandwidth, and latency widgets.

These come from Kong's Prometheus plugin scraped by an OpenTelemetry Collector and forwarded to OAP, which converts them into the `meter_kong_*` metrics through its meter-analysis rules. Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so a route-scope or node-scope metric is empty until that level of data is reported. For the end-to-end collector and OAP setup, see the [Kong monitoring](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-kong-monitoring/) backend guide.
