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
# Nginx

The **NGINX** layer monitors [Nginx](https://nginx.org/) servers and reverse proxies. Nginx, with the SkyWalking Lua module, reports request, latency, bandwidth, connection, status, and error-log telemetry, which OAP aggregates into the `meter_nginx_*` families this dashboard renders. The layer key is **NGINX**, and in Horizon's sidebar it is grouped under **Gateways**.

In the sidebar this layer's services are listed as **Nginx services**, its instances as **Nodes** (the individual Nginx server nodes), and its endpoints as **Routes** (the matched Nginx routes). The NGINX layer enables three metric scopes — Service, Instance (Node), and Endpoint (Route) — plus a **Logs** tab. It does not ship a topology or a traces tab, so apart from logs this dashboard is the metric drill-down across those three scopes.

This page is the **operator reference** for the bundled NGINX dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled NGINX template; if an operator has published a customized NGINX template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

Before opening a service, the layer landing page lists every NGINX service, sorted by request rate (**RPS**) by default, with three columns:

- **RPS** — total HTTP requests per second across the service's nodes (`aggregate_labels(meter_nginx_service_http_requests, sum)`).

- **5xx %** — percent of requests that returned a `5xx` status, as a share of all requests over the window (`aggregate_labels(meter_nginx_service_http_5xx_requests_increment, sum)/aggregate_labels(meter_nginx_service_http_requests_increment, sum)*100`).

- **4xx %** — percent of requests that returned a `4xx` status, as a share of all requests over the window (`aggregate_labels(meter_nginx_service_http_4xx_requests_increment, sum)/aggregate_labels(meter_nginx_service_http_requests_increment, sum)*100`).

The two error columns give an at-a-glance health read across the fleet — a service with a climbing `5xx %` is failing requests at the proxy, a climbing `4xx %` is rejecting client requests.

## Service dashboard

The primary drill-down for one selected Nginx service. All eight widgets aggregate across the service's nodes.

- **HTTP Request Trend** — total requests per second for the service (`aggregate_labels(meter_nginx_service_http_requests, sum)`).

- **HTTP Latency** — request latency in ms, averaged across the reported percentiles (`aggregate_labels(meter_nginx_service_http_latency, avg(p))`).

- **HTTP Bandwidth** — bandwidth in KB/s, summed across the bandwidth types (`aggregate_labels(meter_nginx_service_http_bandwidth, sum(type))`, divided to KB/s).

- **HTTP Connections** — connections summed by state (`aggregate_labels(meter_nginx_service_http_connections, sum(state))`, one line per `state`).

- **HTTP Status Trend** — requests summed by HTTP status (`aggregate_labels(meter_nginx_service_http_status, sum(status))`, one line per `status`).

- **4xx % / min** — percent of requests returning a `4xx` status per minute (`aggregate_labels(meter_nginx_service_http_4xx_requests_increment, sum)/aggregate_labels(meter_nginx_service_http_requests_increment, sum)*100`).

- **5xx % / min** — percent of requests returning a `5xx` status per minute (`aggregate_labels(meter_nginx_service_http_5xx_requests_increment, sum)/aggregate_labels(meter_nginx_service_http_requests_increment, sum)*100`).

- **Error Log Count** — count of error-log entries summed by log level (`aggregate_labels(meter_nginx_service_error_log_count, sum(level))`, one line per `level`).

## Instance dashboard

For one selected node. These widgets are reported per node, so they show how one Nginx server process is behaving.

- **HTTP Request Trend** — requests per second for the node (`meter_nginx_instance_http_requests`).

- **HTTP Latency** — request latency in ms for the node (`meter_nginx_instance_http_latency`).

- **HTTP Bandwidth** — bandwidth in KB/s for the node (`meter_nginx_instance_http_bandwidth`, divided to KB/s).

- **HTTP Connections** — connections by state for the node (`meter_nginx_instance_http_connections`).

- **HTTP Status Trend** — requests by HTTP status for the node (`meter_nginx_instance_http_status`).

- **4xx % / min** — percent of requests returning a `4xx` status per minute for the node (`(meter_nginx_instance_http_4xx_requests_increment/meter_nginx_instance_http_requests_increment)*100`).

- **5xx % / min** — percent of requests returning a `5xx` status per minute for the node (`(meter_nginx_instance_http_5xx_requests_increment/meter_nginx_instance_http_requests_increment)*100`).

- **Error Log Count** — count of error-log entries for the node (`meter_nginx_instance_error_log_count`).

## Endpoint dashboard

For one selected route. Nginx reports a tighter metric set at route scope — requests, latency, bandwidth, status, and the per-route error rates.

- **HTTP Request Trend** — requests per second for the route (`meter_nginx_endpoint_http_requests`).

- **HTTP Latency** — request latency in ms for the route (`meter_nginx_endpoint_http_latency`).

- **HTTP Bandwidth** — bandwidth in KB for the route (`meter_nginx_endpoint_http_bandwidth`, divided to KB).

- **HTTP Status Trend** — requests by HTTP status for the route (`meter_nginx_endpoint_http_status`).

- **4xx % / min** — percent of requests returning a `4xx` status per minute for the route (`(meter_nginx_endpoint_http_4xx_requests_increment/meter_nginx_endpoint_http_requests_increment)*100`).

- **5xx % / min** — percent of requests returning a `5xx` status per minute for the route (`(meter_nginx_endpoint_http_5xx_requests_increment/meter_nginx_endpoint_http_requests_increment)*100`).

## Logs

The NGINX layer enables the **Logs** tab. Nginx access and error logs forwarded to OAP are searchable here, scoped to the selected Nginx service, with the standard log filters and time range. This is the same logs experience as other log-enabled layers — see the layer logs view for how to filter, page, and inspect entries.

## Requirements

The NGINX dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs Nginx telemetry flowing in:

- **Service metrics** — the `meter_nginx_service_*` family (requests, latency, bandwidth, connections, status, the 4xx / 5xx increment counters, and error-log count), aggregated by OAP across a service's nodes.

- **Instance (node) metrics** — the `meter_nginx_instance_*` family for the per-node request, latency, bandwidth, connection, status, error-rate, and error-log widgets.

- **Endpoint (route) metrics** — the `meter_nginx_endpoint_*` family for the per-route request, latency, bandwidth, status, and error-rate widgets.

- **Logs** — Nginx access / error logs shipped to OAP, for the Logs tab.

These come from the SkyWalking Nginx Lua module emitting Nginx telemetry to OAP, which converts it into the `meter_nginx_*` metrics through its meter-analysis rules. Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so a route-scope or node-scope metric is empty until that level of data is reported. For the end-to-end setup, see the [Nginx monitoring](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-nginx-monitoring/) backend guide.
