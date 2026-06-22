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
# Istio Managed Services

The **MESH** layer is where SkyWalking observes services running inside an Istio service mesh. Telemetry comes from the Envoy sidecars via Envoy's Access Log Service (ALS), so a service does not need a language agent to appear here — Envoy reports the traffic, latency, and Envoy-runtime metrics on its behalf. This makes MESH the natural home for any workload managed by Istio, instrumented or not.

In Horizon's sidebar this layer is named **Istio Managed Services**. Its services are listed as **Services**, instances as **Sidecars** (one per Envoy proxy), and endpoints as **Endpoints**. Service names follow the Istio `service.namespace` convention, so the namespace is surfaced as a grouping value alongside the service name. The MESH layer enables the Service, Instance (Sidecar), Endpoint, Topology, Traces, and Logs sub-tabs, plus eBPF profiling, network profiling, and pod logs. There is no endpoint-to-endpoint dependency map for this layer.

This page is the **operator reference** for the bundled MESH dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled MESH template; if an operator has published a customized MESH template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

Before opening a service, the layer landing page lists every MESH service with four sortable columns, sorted by traffic (**Traffic**) by default:

- **Traffic** — calls per minute observed by the sidecars (`service_cpm`).

- **Apdex** — user-satisfaction score on a 0 – 1 scale (`service_apdex/10000`).

- **Latency** — average response time in ms (`service_resp_time`).

- **Error Rate** — percent of failed calls (`100 - service_sla/100`).

## Service dashboard

The primary drill-down for one selected service.

- **Top 20 APIs** — the busiest endpoints under this service, with tabs to re-rank by **Traffic** (`endpoint_cpm`, rpm), **Slow** (`endpoint_resp_time`, ms), and **Successful Rate** (`endpoint_sla`, %, worst-first). Click a row to jump into that endpoint.

- **Traffic** — mesh-wide requests per minute observed by the Envoy sidecars (`service_cpm`).

- **Error Rate** — percent of failed calls (`100 - service_sla/100`).

- **Apdex** — user-satisfaction score on a 0 – 1 scale (`service_apdex/10000`).

- **Avg Response Time** — mean latency in ms (`service_resp_time`).

- **Response Time Percentile** — p50 / p75 / p90 / p95 / p99 latency, the tail of the response-time distribution (`service_percentile`).

- **Service Throughput** — bytes per minute through the sidecar, received and sent on the same chart (`service_throughput_received`, `service_throughput_sent`).

- **Sidecar Internal Latency** — Envoy-internal request and response latency in nanoseconds. Useful when you suspect the sidecar itself is adding overhead (`service_sidecar_internal_req_latency_nanos`, `service_sidecar_internal_resp_latency_nanos`).

- **Top 10 sidecars** — this service's sidecar instances ranked across three tabs: **Traffic** (`service_instance_cpm`, rpm), **Slow** (`service_instance_resp_time`, ms), and **Successful Rate** (`service_instance_sla`, %, worst-first).

## Instance dashboard

For one selected sidecar instance. The first five widgets always render; the Envoy-runtime widgets that follow appear only when the sidecar actually reports those metrics, so a non-Envoy or partially-instrumented sidecar simply shows fewer panels.

**Always shown**

- **Sidecar Load** — calls per minute against the selected sidecar instance (`service_instance_cpm`).

- **Sidecar Latency** — average response time in ms (`service_instance_resp_time`).

- **Sidecar Success Rate** — percent of successful calls (`service_instance_sla/100`).

- **Sidecar Throughput** — bytes through the sidecar, received and sent (`service_instance_throughput_received`, `service_instance_throughput_sent`).

- **Sidecar Internal Latency** — Envoy-internal request and response latency in nanoseconds (`service_instance_sidecar_internal_req_latency_nanos`, `service_instance_sidecar_internal_resp_latency_nanos`).

**Envoy runtime (shown when the sidecar reports it)**

- **Envoy Upstream Request Active** — in-flight upstream requests per cluster (`envoy_cluster_up_rq_active`).

- **Envoy Upstream Request Increase** — upstream requests added per minute (`envoy_cluster_up_rq_incr`).

- **Envoy Upstream Pending Active** — pending upstream requests, a sign of connection-pool back-pressure (`envoy_cluster_up_rq_pending_active`).

- **Envoy Upstream Connection Active** — active upstream connections per cluster (`envoy_cluster_up_cx_active`).

- **Envoy Upstream Connection Increase** — upstream connections added per minute (`envoy_cluster_up_cx_incr`).

- **Envoy Cluster Healthy Membership** — healthy upstream members per cluster; a non-trivial drop signals upstream churn (`envoy_cluster_membership_healthy`).

- **Envoy Total Connections** — total vs parent connections in use (`envoy_total_connections_used`, `envoy_parent_connections_used`).

- **Envoy Heap Memory** — Envoy memory in MB: heap used / max, allocated used / max, and physical size / max (`envoy_heap_memory_used`, `envoy_heap_memory_max_used`, `envoy_memory_allocated`, `envoy_memory_allocated_max`, `envoy_memory_physical_size`, `envoy_memory_physical_size_max`).

- **Envoy Worker Threads** — live vs max worker threads (`envoy_worker_threads`, `envoy_worker_threads_max`).

- **Envoy Bug Failures** — Envoy's own assertion / bug counter; expected to be zero in healthy clusters (`envoy_bug_failures`).

## Endpoint dashboard

For one selected endpoint.

- **Endpoint Traffic** — calls per minute for the endpoint (`endpoint_cpm`).

- **Endpoint Avg Response Time** — average latency in ms (`endpoint_resp_time`).

- **Endpoint Success Rate** — percent of successful calls (`endpoint_sla/100`).

- **Endpoint Response Time Percentile** — p50 / p75 / p90 / p95 / p99 latency for the endpoint (`endpoint_percentile`).

- **Sidecar Internal Latency (endpoint scope)** — Envoy-internal request and response latency on this endpoint, in nanoseconds (`endpoint_sidecar_internal_req_latency_nanos`, `endpoint_sidecar_internal_resp_latency_nanos`).

## Topology and maps

The MESH layer ships the service map and the instance (sidecar) map. There is no endpoint-dependency map for this layer.

**Topology (service map)** — every service node is decorated with **RPM** (`service_cpm`), an **SLA** health ring (`service_sla/100`, colored green / amber / red — higher is better, so the ring turns red as success rate drops), and **Latency** (`service_resp_time`). Each call edge carries server-side and client-side **RPM**, **Avg response time**, **p95**, and **SLA** (`service_relation_server_*` and `service_relation_client_*`), shown aligned in the edge panel.

**Instance map (sidecars)** — from a call between two services on the service map, drill into the sidecar-to-sidecar calls between them. The same node / edge metric set is evaluated at instance scope: node **RPM** (`service_instance_cpm`), **SLA** ring (`service_instance_sla/100`), and **Latency** (`service_instance_resp_time`); each edge shows server-side and client-side **RPM**, **Avg response time**, **p95**, and **SLA** (`service_instance_relation_server/client_*`).

For how these maps are read and navigated, see the [3D Infrastructure Map](../operate/infra-3d-map.md) for the cross-layer view, and the topology section of [Layer Dashboard Templates](../customization/layer-templates.md) for how the node and edge metrics are configured.

## Traces

MESH traces are served from **Zipkin**. Open the Traces tab to query the sidecar-reported spans; the workflow and filters are the same as any other layer's trace view — see [Traces](../operate/traces.md).

## Requirements

The MESH dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs:

- **Envoy ALS enabled** — the sidecars must stream access logs to OAP via the Access Log Service so it can derive the service / instance / endpoint traffic, latency, and SLA metrics. See the [Envoy ALS setup](https://skywalking.apache.org/docs/main/next/en/setup/envoy/als_setting/) guide.

- **Service / instance / endpoint metrics** — the `service_*`, `service_instance_*`, and `endpoint_*` families (traffic, response time, SLA, apdex, percentiles), including the mesh-specific `*_throughput_*` and `*_sidecar_internal_*_latency_nanos` metrics produced from the ALS stream.

- **Relation metrics** — `service_relation_*` and `service_instance_relation_*` for the service map and the sidecar map.

- **Envoy-runtime metrics** — the `envoy_cluster_*`, `envoy_*_connections_used`, `envoy_*_memory_*`, `envoy_worker_threads*`, and `envoy_bug_failures` families, for the Envoy-runtime instance widgets to appear. A sidecar only shows the families its Envoy build emits.

Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so an instance- or endpoint-scope metric is empty until that level of data is reported. When a whole family is missing (for example a sidecar that does not export Envoy-runtime metrics), its widgets are hidden rather than shown empty.
