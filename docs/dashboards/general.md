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
# General Service

The **GENERAL** layer is where SkyWalking's language agents report. Any service instrumented by a SkyWalking native agent — Java, .NET (CLR), Go, Python, Ruby, Node.js, and the Spring Boot / Spring Sleuth meter integrations — lands here, so it is the most-used layer and the reference dashboard every other layer's dashboard is modelled on.

In Horizon's sidebar this layer is named **General Service**. Its services are listed as **Services**, instances as **Instances** (each badged with the agent **language**), and endpoints as **API** — the endpoint-to-endpoint view is called **API dependency**. The GENERAL layer enables the full set of sub-tabs: Service, Instance, Endpoint, API dependency, Topology, Traces, Logs, and the profiling tabs (trace, eBPF, async, pprof).

This page is the **operator reference** for the bundled GENERAL dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled GENERAL template; if an operator has published a customized GENERAL template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

Before opening a service, the layer landing page lists every GENERAL service with three sortable columns, sorted by traffic (**RPM**) by default:

- **RPM** — calls per minute (`service_cpm`).
- **Apdex** — user-satisfaction score on a 0 – 1 scale (`service_apdex/10000`).
- **Error Rate** — percent of failed calls (`100 - service_sla/100`).

## Service dashboard

The primary drill-down for one selected service.

- **Top 20 APIs** — the busiest endpoints under this service, with tabs to re-rank by **Traffic** (`endpoint_cpm`, rpm), **Slow** (`endpoint_resp_time`, ms), and **Successful Rate** (`endpoint_sla`, %, worst-first). Click a row to jump into that endpoint.
- **Traffic** — calls per minute for the service (`service_cpm`).
- **Error Rate** — percent of failed calls (`100 - service_sla/100`).
- **Apdex** — user-satisfaction score on a 0 – 1 scale (`service_apdex/10000`).
- **Response Time Percentile** — p50 / p75 / p90 / p95 / p99 latency, the tail of the response-time distribution (`service_percentile`).
- **Avg Response Time** — mean latency in ms (`service_resp_time`).
- **MQ Consume rate + latency** — message-queue consume count and latency on a dual axis: count on the left, latency on the right (`service_mq_consume_count`, `service_mq_consume_latency`).
- **Top 10 instances by load** — this service's instances ranked by traffic (`service_instance_cpm`, rpm).
- **Top 10 slowest instances** — instances ranked by average response time (`service_instance_resp_time`, ms).
- **Top 10 instances by success rate** — instances ranked worst-first by success rate (`service_instance_sla`, %).
- **Slow Database Statements** — the 20 slowest sampled database statements captured against this service (`top_n_service_database_statement`, ms). Each row carries the statement text and, when the sample has one, a jump-to-trace link. Shows `no data` when OAP captured no statements in the window.

## Instance dashboard

For one selected service instance. The first three widgets always render; the rest are **runtime-specific** and appear only when the instance actually reports those metrics — so a Java instance shows the JVM family, a Go instance the Golang family, and so on, without manual configuration.

**Always shown**

- **Service Instance Load** — calls per minute against the instance (`service_instance_cpm`).
- **Service Instance Latency** — average response time in ms (`service_instance_resp_time`).
- **Service Instance Success Rate** — percent of successful calls (`service_instance_sla/100`).

**JVM (Java instances)**

- **JVM CPU** — JVM CPU as reported by the agent (`instance_jvm_cpu`).
- **JVM Memory** — heap and non-heap used / max in MB (`instance_jvm_memory_heap`, `instance_jvm_memory_heap_max`, `instance_jvm_memory_noheap`, `instance_jvm_memory_noheap_max`).
- **JVM Memory Detail** — per-pool used memory in MB: code cache, newgen, oldgen, survivor, permgen, metaspace, plus the newer JVM pools (zheap, compressed class space, and the segmented codeheaps). Pools a JVM doesn't expose stay at 0.
- **JVM Thread Count** — live / daemon / peak threads.
- **JVM Thread State Count** — threads by state: runnable / blocked / waiting / timed-waiting.
- **JVM GC Time** — young / old / normal GC time in ms.
- **JVM GC Count** — young / old / normal GC counts.
- **JVM Class Count** — loaded / total-loaded / total-unloaded classes.

**CLR (.NET instances)**

- **CLR CPU** — process CPU percentage (`instance_clr_cpu`).
- **CLR Thread** — worker-available, completion-port-available, and completion-port-max threads.
- **CLR Heap Memory** — managed heap in MB.
- **CLR GC** — gen 0 / gen 1 / gen 2 collection counts.

**Spring (Spring Boot Actuator / Spring Sleuth meters)**

- **Spring HTTP Request Count** and **Spring HTTP Request Duration** — `http.server.requests` count and latency.
- **Spring Instance CPU Usage** / **Spring OS CPU Usage** / **Spring OS System Load** — process CPU, OS CPU, and 1-minute load average.
- **Spring OS Process Files** — open vs max file descriptors.
- **Spring JVM GC Pause Duration**, **Spring JVM Memory** (used / max), **Spring JVM Threads** (live / daemon / peak), **Spring JVM Classes** (loaded / unloaded).
- **Spring Database Connection Pool** (HikariCP / datasource), **Spring Thread Pool**, **Spring JDBC Connections** (active / idle / max), **Spring Tomcat Sessions** (active / max / rejected).

**Golang (Go instances)**

- **Golang Goroutines / OS Threads**, **Golang GC Pause Time**, **Golang GC Count**, **Golang Heap Alloc**, **Golang Goroutine Schedule Time**, **Golang GC Free**, **Golang Alloc Size**, **Golang Free Size**, **Golang Heap Objects**, **Golang Heap**, **Golang Metadata Mspan**, **Golang Metadata Mcache**, **Golang GC Goal Size**, and **Golang CGO Calls** — the Go runtime's goroutine, scheduler, GC, and heap detail.

**Python (PVM instances)**

- **Python CPU Utilization** and **Python Memory Utilization** — host vs process.
- **Python Thread Count**, **Python GC Count** (gen 0 / 1 / 2), and **Python GC Time**.

**Ruby instances**

- **Ruby CPU Usage**, **Ruby Memory (RSS)**, **Ruby Memory Usage**, **Ruby Thread Status** (active / running), **Ruby GC Count** (total / minor / major), **Ruby GC Time**, **Ruby Heap Usage**, and **Ruby Heap Slots** (live / available).

## Endpoint dashboard

For one selected endpoint (an **API**).

- **Traffic** — calls per minute for the endpoint (`endpoint_cpm`).
- **Response Time** — average latency in ms (`endpoint_resp_time`).
- **Success Rate** — percent of successful calls (`endpoint_sla/100`).
- **Response Time Percentile** — p50 / p75 / p90 / p95 / p99 latency for the endpoint (`endpoint_percentile`).
- **MQ Avg Consuming Latency** — consume latency in ms, shown only for endpoints that serve message-queue traffic (`endpoint_mq_consume_latency`).

## Topology and maps

The GENERAL layer ships a full set of maps.

**Topology (service map)** — every service node is decorated with **RPM** (`service_cpm`), an **SLA** health ring (`service_sla/100`, colored green / amber / red — higher is better, so the ring turns red as success rate drops), and **Latency** (`service_resp_time`). Each call edge carries server-side and client-side **RPM**, **Avg response time**, **p95**, and **SLA** (`service_relation_server_*` and `service_relation_client_*`), shown aligned in the edge panel.

**Instance map** — from a call between two services on the service map, drill into the instance-to-instance calls between them. The same node / edge metric set is evaluated at instance scope (`service_instance_*` and `service_instance_relation_server/client_*`).

**API dependency (endpoint map)** — the endpoint-to-endpoint dependency view. Each endpoint node shows **RPM** (`endpoint_cpm`), an **SLA** ring (`endpoint_sla/100`), and **Latency** (`endpoint_resp_time`); each edge shows **RPM**, **Avg response time**, **p95**, and **SLA** (`endpoint_relation_*`). Endpoint relations are server-side only.

For how these maps are read and navigated, see the [3D Infrastructure Map](../operate/infra-3d-map.md) for the cross-layer view, and the topology section of [Layer Dashboard Templates](../customization/layer-templates.md) for how the node and edge metrics are configured.

## Requirements

The GENERAL dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs:

- **Service / instance / endpoint metrics** — the `service_*`, `service_instance_*`, and `endpoint_*` families (traffic, response time, SLA, apdex, percentiles), produced by OAP from agent-reported traces or meters.
- **Relation metrics** — `service_relation_*`, `service_instance_relation_*`, and `endpoint_relation_*` for the service map, instance map, and API-dependency views.
- **Runtime metrics**, for the runtime-specific instance widgets to appear: JVM (`instance_jvm_*`), CLR (`instance_clr_*`), the Spring meter family (`meter_*`), and the Golang / Python / Ruby agent meter families. An instance only shows the families its agent emits.
- **Sampled records** — `top_n_service_database_statement` for the Slow Database Statements list, captured by OAP when slow-statement sampling is enabled.

Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so an instance- or endpoint-scope metric is empty until that level of data is reported. When a whole family is missing (for example a non-JVM runtime), its widgets are hidden rather than shown empty.
