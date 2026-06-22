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
# Cilium Service

The **CILIUM_SERVICE** layer monitors Kubernetes services observed through Cilium's eBPF data plane. SkyWalking collects L4 (TCP) packet activity and L7 protocol telemetry (HTTP, DNS, Kafka) that Cilium reports for each service, giving you network-level and protocol-level visibility into the mesh without instrumenting the application. It belongs to the **Kubernetes** layer group.

In Horizon's sidebar this layer is named **Cilium Service**. Its services are listed as **Services**, instances as **Pods**, and endpoints as **Endpoints** — service names are grouped and displayed by their Kubernetes namespace. The CILIUM_SERVICE layer enables the Service, Pod, Endpoint, and Topology sub-tabs. It does not enable Traces or Logs.

This page is the **operator reference** for the bundled CILIUM_SERVICE dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled CILIUM_SERVICE template; if an operator has published a customized CILIUM_SERVICE template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

Before opening a service, the layer landing page lists every CILIUM_SERVICE service with four sortable columns, sorted by traffic (**RPM**) by default:

- **RPM** — protocol calls per minute (`cilium_service_protocol_cpm`).

- **Latency** — average protocol call duration in ms (`cilium_service_protocol_call_duration/cilium_service_protocol_cpm/1000000`).

- **Success Rate** — percent of successful protocol calls (`cilium_service_protocol_call_success_count/cilium_service_protocol_cpm*100`).

- **TCP Drop** — dropped read + write packets per minute at L4 (`cilium_service_l4_read_pkg_drop_cpm + cilium_service_l4_write_pkg_drop_cpm`).

## Service dashboard

The primary drill-down for one selected service. It splits into an L4 (TCP) row and per-protocol (HTTP, DNS, Kafka) groups.

**L4 (TCP)**

- **L4 Read Packages/min** — inbound packets per minute (`cilium_service_l4_read_pkg_cpm`).

- **L4 Write Packages/min** — outbound packets per minute (`cilium_service_l4_write_pkg_cpm`).

- **TCP Drop / min** — dropped read and write packets per minute, plotted as two series (`cilium_service_l4_read_pkg_drop_cpm`, `cilium_service_l4_write_pkg_drop_cpm`).

- **TCP Drop by Reason** — dropped-packet count broken out by Cilium's drop-reason label (`cilium_service_l4_drop_reason_count`).

**HTTP**

- **HTTP Load** — HTTP calls per minute alongside the successful-call count (`cilium_service_protocol_http_call_cpm`, `cilium_service_protocol_http_call_success_count`).

- **HTTP Duration** — average HTTP call duration in ms (`cilium_service_protocol_http_call_duration/cilium_service_protocol_http_call_cpm/1000000`).

- **HTTP Non-2xx Status** — HTTP responses per minute by status class: 1xx / 3xx / 4xx / 5xx (`cilium_service_protocol_http_status_1xx_cpm`, `cilium_service_protocol_http_status_3xx_cpm`, `cilium_service_protocol_http_status_4xx_cpm`, `cilium_service_protocol_http_status_5xx_cpm`).

**DNS**

- **DNS Load** — DNS calls per minute alongside the successful-call count (`cilium_service_protocol_dns_call_cpm`, `cilium_service_protocol_dns_call_success_count`).

- **DNS Duration** — average DNS call duration in ms (`cilium_service_protocol_dns_call_duration/cilium_service_protocol_dns_call_cpm/1000000`).

- **DNS Errors / min** — DNS error count per minute (`cilium_service_protocol_dns_error_count`).

**Kafka**

- **Kafka Load** — Kafka calls per minute alongside the successful-call count (`cilium_service_protocol_kafka_call_cpm`, `cilium_service_protocol_kafka_call_success_count`).

- **Kafka Duration** — average Kafka call duration in ms (`cilium_service_protocol_kafka_call_duration/cilium_service_protocol_kafka_call_cpm/1000000`).

- **Kafka Errors / min** — Kafka error count per minute (`cilium_service_protocol_kafka_call_error_count`).

## Pod dashboard

For one selected pod (a service **instance**). The widgets mirror the service view at instance scope, covering L4 plus the HTTP, DNS, and Kafka protocols.

- **L4 Read Packages/min** — inbound packets per minute for the pod (`cilium_service_instance_l4_read_pkg_cpm`).

- **L4 Write Packages/min** — outbound packets per minute for the pod (`cilium_service_instance_l4_write_pkg_cpm`).

- **HTTP Load** — HTTP calls per minute alongside the successful-call count (`cilium_service_instance_protocol_http_call_cpm`, `cilium_service_instance_protocol_http_call_success_count`).

- **HTTP Non-2xx Status** — HTTP responses per minute by status class: 1xx / 3xx / 4xx / 5xx (`cilium_service_instance_protocol_http_status_1xx_cpm`, `cilium_service_instance_protocol_http_status_3xx_cpm`, `cilium_service_instance_protocol_http_status_4xx_cpm`, `cilium_service_instance_protocol_http_status_5xx_cpm`).

- **DNS Load** — DNS calls per minute alongside the successful-call count (`cilium_service_instance_protocol_dns_call_cpm`, `cilium_service_instance_protocol_dns_call_success_count`).

- **DNS Errors** — DNS error count (`cilium_service_instance_protocol_dns_error_count`).

- **Kafka Load** — Kafka calls per minute alongside the successful-call count (`cilium_service_instance_protocol_kafka_call_cpm`, `cilium_service_instance_protocol_kafka_call_success_count`).

## Endpoint dashboard

For one selected endpoint. Cilium endpoints carry L7 protocol traffic, so this scope is HTTP- and DNS-focused.

- **HTTP Load** — HTTP calls per minute alongside the successful-call count (`cilium_endpoint_protocol_http_call_cpm`, `cilium_endpoint_protocol_http_call_success_count`).

- **HTTP Duration** — average HTTP call duration in ms (`cilium_endpoint_protocol_http_call_duration/cilium_endpoint_protocol_http_call_cpm/1000000`).

- **HTTP Non-2xx Status** — HTTP responses per minute by status class: 1xx / 3xx / 4xx / 5xx (`cilium_endpoint_protocol_http_status_1xx_cpm`, `cilium_endpoint_protocol_http_status_3xx_cpm`, `cilium_endpoint_protocol_http_status_4xx_cpm`, `cilium_endpoint_protocol_http_status_5xx_cpm`).

- **DNS Load** — DNS calls per minute alongside the successful-call count (`cilium_endpoint_protocol_dns_call_cpm`, `cilium_endpoint_protocol_dns_call_success_count`).

- **DNS Duration** — average DNS call duration in ms (`cilium_endpoint_protocol_dns_call_duration/cilium_endpoint_protocol_dns_call_cpm/1000000`).

- **DNS Errors** — DNS error count (`cilium_endpoint_protocol_dns_error_count`).

## Topology and maps

The CILIUM_SERVICE layer ships a service topology with an instance-level drill-down.

**Topology (service map)** — each service node is decorated with **RPM** (`cilium_service_protocol_cpm`), a **Success %** health ring (`cilium_service_protocol_call_success_count/cilium_service_protocol_cpm*100`, colored green / amber / red — higher is better, so the ring turns red as the success rate drops), and **Latency** (`cilium_service_protocol_call_duration/cilium_service_protocol_cpm/1000000`). Each call edge carries server-side **HTTP RPM** (`cilium_service_relation_server_protocol_http_call_cpm`) and **Avg Latency** (`cilium_service_relation_server_protocol_http_call_duration/cilium_service_relation_server_protocol_http_call_cpm/1000000`).

**Instance map** — from a call between two services on the service map, drill into the pod-to-pod calls between them. Each instance node shows **HTTP RPM** (`cilium_service_instance_protocol_http_call_cpm`) and **Avg Latency** (`cilium_service_instance_protocol_http_call_duration/cilium_service_instance_protocol_http_call_cpm/1000000`); each edge carries server-side **HTTP RPM** (`cilium_service_instance_relation_server_protocol_http_call_cpm`) and **Avg Latency** (`cilium_service_instance_relation_server_protocol_http_call_duration/cilium_service_instance_relation_server_protocol_http_call_cpm/1000000`).

For how these maps are read and navigated, see the [3D Infrastructure Map](../operate/infra-3d-map.md) for the cross-layer view, and the topology section of [Layer Dashboard Templates](../customization/layer-templates.md) for how the node and edge metrics are configured.

## Requirements

The CILIUM_SERVICE dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs Cilium monitoring enabled, with the Cilium-Hubble fetcher feeding SkyWalking. Specifically:

- **L4 metrics** — the `cilium_service_l4_*` family (read / write packet rates, packet drops, and drop-reason breakdown) for the service-scope TCP widgets.

- **Protocol metrics** — the `cilium_service_protocol_*`, `cilium_service_instance_protocol_*`, and `cilium_endpoint_protocol_*` families covering HTTP, DNS, and Kafka call counts, durations, success counts, status classes, and errors, at their respective service / instance / endpoint scopes.

- **Relation metrics** — `cilium_service_relation_server_protocol_*` and `cilium_service_instance_relation_server_protocol_*` for the service map and instance map edges.

Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so an instance- or endpoint-scope metric is empty until that level of data is reported. A pod or endpoint that carries only one protocol shows `no data` for the others. For setup, see the [Cilium monitoring](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-k8s-monitoring-cilium/) guide.
