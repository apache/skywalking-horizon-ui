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
# AWS API Gateway

The **AWS_GATEWAY** layer monitors Amazon API Gateway. OAP pulls per-gateway and per-route metrics from AWS CloudWatch — request counts, latency, error rates, cache behavior, and data volume — and presents each gateway as a service in SkyWalking.

In Horizon's sidebar this layer is named **AWS API Gateway**. Its services are listed as **AWS Gateways** and its endpoints as **Routes** (each route is a method-plus-resource path on a gateway). The layer enables only the Service and Endpoint sub-tabs — there is no instance scope, no topology, and no traces or logs tab, because CloudWatch reports gateway- and route-level aggregates rather than per-instance, per-request, or relationship data.

This page is the **operator reference** for the bundled AWS_GATEWAY dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled AWS_GATEWAY template; if an operator has published a customized AWS_GATEWAY template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

Before opening a gateway, the layer landing page lists every AWS Gateway with four sortable columns, sorted by request volume (**Requests**) by default:

- **Requests** — total request count over the window (`aws_gateway_service_count`).

- **Latency** — average request latency in ms (`aws_gateway_service_latency`).

- **4xx** — count of client-error (4xx) responses (`aws_gateway_service_4xx`).

- **5xx** — count of server-error (5xx) responses (`aws_gateway_service_5xx`).

## Service dashboard

The primary drill-down for one selected gateway.

- **Request Count** — total requests handled by the gateway (`aws_gateway_service_count`).

- **4xx Count** — client-error responses (`aws_gateway_service_4xx`).

- **5xx Count** — server-error responses (`aws_gateway_service_5xx`).

- **Request Avg Latency** — average end-to-end request latency in ms (`aws_gateway_service_latency`).

- **Integration Avg Latency** — average latency between the gateway and its backend integration in ms, isolating backend time from gateway overhead (`aws_gateway_service_integration_latency`).

- **Data Processed (HTTP API only)** — bytes processed by the gateway, shown in KB (`aws_gateway_service_data_processed/1024`). Populated only for HTTP API gateways.

- **Cache Hit Rate (REST API only)** — percent of requests served from the gateway cache (`aws_gateway_service_cache_hit_rate`). Populated only for REST API gateways with caching enabled.

- **Cache Miss Rate (REST API only)** — percent of requests that missed the gateway cache (`aws_gateway_service_cache_miss_rate`). Populated only for REST API gateways with caching enabled.

## Endpoint dashboard

For one selected route (an **endpoint** under a gateway).

- **Request Count** — total requests to the route (`aws_gateway_endpoint_count`).

- **4xx Count** — client-error responses on the route (`aws_gateway_endpoint_4xx`).

- **5xx Count** — server-error responses on the route (`aws_gateway_endpoint_5xx`).

- **Request Avg Latency** — average request latency in ms (`aws_gateway_endpoint_latency`).

- **Integration Avg Latency** — average gateway-to-backend integration latency in ms (`aws_gateway_endpoint_integration_latency`).

- **Data Processed** — bytes processed for the route, shown in KB (`aws_gateway_endpoint_DataProcessed/1024`).

- **Cache Hit Rate** — percent of requests served from cache (`aws_gateway_endpoint_cache_hit_rate`).

- **Cache Miss Rate** — percent of requests that missed the cache (`aws_gateway_endpoint_cache_miss_rate`).

## Requirements

The AWS_GATEWAY dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs the AWS API Gateway receiver enabled and pulling CloudWatch metrics, which produces:

- **Gateway (service-scope) metrics** — the `aws_gateway_service_*` family: request count, latency, integration latency, 4xx / 5xx counts, data processed, and cache hit / miss rates.

- **Route (endpoint-scope) metrics** — the `aws_gateway_endpoint_*` family: the same measures at route granularity.

Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so a route-scope metric is empty until route-level data is reported. Cache-rate and data-processed widgets stay empty for gateways whose API type (REST vs HTTP API) or configuration does not emit that CloudWatch metric.

For setting up the receiver, see the [AWS API Gateway monitoring](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-aws-api-gateway-monitoring/) setup guide in the SkyWalking backend docs.
