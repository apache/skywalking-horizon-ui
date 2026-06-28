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
# Kubernetes Services

The **K8S_SERVICE** layer monitors the network behavior of Kubernetes services, observed at the kernel level by SkyWalking Rover's eBPF probes. It captures the HTTP and TCP traffic flowing in and out of each service's pods — call rate, latency, status codes, header / body sizes, packet counts, and connection activity — without instrumenting the application. It belongs to the **Kubernetes** layer group.

In Horizon's sidebar this layer is named **Kubernetes Services**. Its services are listed as **K8s services**, instances as **Pods**, and endpoints as **Endpoints** — service names are grouped and displayed by their Kubernetes namespace. The K8S_SERVICE layer enables the Service, Pod, Endpoint, Topology, eBPF Profiling, Network Profiling, and Pod Logs sub-tabs. It does not enable an endpoint-dependency map, Traces, or Logs.

This page is the **operator reference** for the bundled K8S_SERVICE dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled K8S_SERVICE template; if an operator has published a customized K8S_SERVICE template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

Before opening a service, the layer landing page lists every K8S_SERVICE service with four sortable columns, sorted by HTTP traffic (**HTTP RPM**) by default:

- **Pods** — number of pods backing the service, summed from the latest reading (`latest(k8s_service_pod_total)`).

- **HTTP RPM** — HTTP calls per minute, summed across the service (`kubernetes_service_http_call_cpm`).

- **Latency** — average HTTP response time in ms (`kubernetes_service_http_call_time`).

- **Success Rate** — percent of successful HTTP calls (`kubernetes_service_http_call_successful_rate/100`).

## Service dashboard

The primary drill-down for one selected service. It mixes pod-lifecycle and resource widgets with the HTTP and TCP traffic the service's pods carry.

**Pods and resources**

- **Service Pods** — pod count over time (`k8s_service_pod_total`).

- **Pods Waiting** — a table of containers currently in the `Waiting` state, keyed by container · pod · reason (`latest(k8s_service_pod_status_waiting)`).

- **Pod Restarts** — a table of pods by cumulative restart count (`latest(k8s_service_pod_status_restarts_total)`).

- **CPU Resources** — requested vs. limited CPU in millicores, as two series (`k8s_service_cpu_cores_requests`, `k8s_service_cpu_cores_limits`).

- **Memory Resources** — requested vs. limited memory in MiB (`k8s_service_memory_requests`, `k8s_service_memory_limits`).

- **Pod CPU Usage** — actual CPU consumed by the pods in millicores (`k8s_service_pod_cpu_usage`).

- **Pod Memory Usage** — actual memory consumed by the pods in MiB (`k8s_service_pod_memory_usage`).

**HTTP traffic**

- **HTTP Request RPM** — HTTP calls per minute for the service (`kubernetes_service_http_call_cpm`).

- **HTTP Response Time** — average HTTP response time in ms (`kubernetes_service_http_call_time`).

- **HTTP Status Code RPM** — calls per minute broken out by status class: 1xx / 2xx / 3xx / 4xx / 5xx (`kubernetes_service_http_status_1xx_cpm` … `kubernetes_service_http_status_5xx_cpm`).

- **HTTP Request / Response Size** — average request and response header and body sizes in KB, as four series (`kubernetes_service_http_avg_req_header_size`, `kubernetes_service_http_avg_req_body_size`, `kubernetes_service_http_avg_resp_header_size`, `kubernetes_service_http_avg_resp_body_size`).

**TCP traffic**

- **TCP Connect** — client-side connect attempts and successes per minute, as two series (`kubernetes_service_connect_cpm`, `kubernetes_service_connect_success_cpm`).

- **TCP Connect Duration** — average connect time in ns (`kubernetes_service_connect_time`).

- **TCP Accept** — server-side accept events per minute (`kubernetes_service_accept_cpm`).

- **TCP Packets** — read, write, and write-retransmit packet counts per minute, as three series (`kubernetes_service_read_package_cpm`, `kubernetes_service_write_package_cpm`, `kubernetes_service_write_retrains_package_cpm`).

- **TCP Bytes** — read vs. write payload bytes per minute in KB (`kubernetes_service_read_package_size`, `kubernetes_service_write_package_size`).

## Pod dashboard

For one selected pod (a service **instance**). The widgets mirror the service view at instance scope, covering the pod's HTTP and TCP traffic.

- **Pod HTTP RPM** — HTTP calls per minute for the pod (`kubernetes_service_instance_http_call_cpm`).

- **Pod HTTP Response Time** — average HTTP response time in ms (`kubernetes_service_instance_http_call_time`).

- **Pod HTTP Status Code RPM** — calls per minute by status class: 1xx / 2xx / 3xx / 4xx / 5xx (`kubernetes_service_instance_http_status_1xx_cpm` … `kubernetes_service_instance_http_status_5xx_cpm`).

- **Pod HTTP Sizes** — average request and response header and body sizes in KB, as four series (`kubernetes_service_instance_http_avg_req_header_size`, `kubernetes_service_instance_http_avg_req_body_size`, `kubernetes_service_instance_http_avg_resp_header_size`, `kubernetes_service_instance_http_avg_resp_body_size`).

- **Pod TCP Connect** — client-side connect attempts and successes per minute (`kubernetes_service_instance_connect_cpm`, `kubernetes_service_instance_connect_success_cpm`).

- **Pod TCP Packets** — read, write, and write-retransmit packet counts per minute (`kubernetes_service_instance_read_package_cpm`, `kubernetes_service_instance_write_package_cpm`, `kubernetes_service_instance_write_retrains_package_cpm`).

- **Pod TCP Bytes** — read vs. write payload bytes per minute in KB (`kubernetes_service_instance_read_package_size`, `kubernetes_service_instance_write_package_size`).

## Endpoint dashboard

For one selected endpoint. K8S_SERVICE endpoints carry HTTP traffic, so this scope is HTTP-focused.

- **Endpoint HTTP RPM** — HTTP calls per minute for the endpoint (`kubernetes_service_endpoint_http_call_cpm`).

- **Endpoint HTTP Response Time** — average HTTP response time in ms (`kubernetes_service_endpoint_http_call_time`).

- **Endpoint Status Code RPM** — calls per minute by status class: 1xx / 2xx / 3xx / 4xx / 5xx (`kubernetes_service_endpoint_http_status_1xx_cpm` … `kubernetes_service_endpoint_http_status_5xx_cpm`).

- **Endpoint Request Sizes** — average request header and body sizes in KB (`kubernetes_service_endpoint_http_avg_req_header_size`, `kubernetes_service_endpoint_http_avg_req_body_size`).

- **Endpoint Response Sizes** — average response header and body sizes in KB (`kubernetes_service_endpoint_http_avg_resp_header_size`, `kubernetes_service_endpoint_http_avg_resp_body_size`).

## Topology and maps

The K8S_SERVICE layer ships a service topology with an instance-level drill-down.

**Topology (service map)** — each service node is decorated with **RPM** (`kubernetes_service_http_call_cpm`), a **Success Rate** health ring (`kubernetes_service_http_call_successful_rate/100`, colored green / amber / red — higher is better, so the ring turns red as the success rate drops), and **Latency** (`kubernetes_service_http_call_time`). Each call edge carries server-side and client-side **RPM** (`kubernetes_service_relation_server_http_call_cpm`, `kubernetes_service_relation_client_http_call_cpm`) and **Avg response time** (`kubernetes_service_relation_server_http_call_time`, `kubernetes_service_relation_client_http_call_time`).

**Instance map** — from a call between two services on the service map, drill into the pod-to-pod calls between them. Each instance node shows **RPM** (`kubernetes_service_instance_http_call_cpm`), a **Success Rate** ring (`kubernetes_service_instance_http_call_successful_rate/100`), and **Latency** (`kubernetes_service_instance_http_call_time`); each edge carries server-side and client-side **RPM** (`kubernetes_service_instance_relation_server_http_call_cpm`, `kubernetes_service_instance_relation_client_http_call_cpm`) and **Avg response time** (`kubernetes_service_instance_relation_server_http_call_time`, `kubernetes_service_instance_relation_client_http_call_time`).

For how these maps are read and navigated, see the [3D Infrastructure Map](../operate/infra-3d-map.md) for the cross-layer view, and the topology section of [Layer Dashboard Templates](../customization/layer-templates.md) for how the node and edge metrics are configured.

## eBPF Profiling, Network Profiling, and Pod Logs

Because K8S_SERVICE data comes from eBPF probes, this layer also enables three investigation tabs alongside the dashboards:

- **eBPF Profiling** — on-CPU / off-CPU profiling tasks targeted at a selected service, with the flame-graph and span-attached results SkyWalking Rover reports.

- **Network Profiling** — the process-to-process network conversations within the service, rendered as a process-level topology, captured by SkyWalking Rover on a selected pod.

- **Pod Logs** — the container logs collected from the service's pods, with the same filtering and search the logs surface provides elsewhere.

These tabs query their own data on demand and are independent of the metric widgets above.

## Requirements

The K8S_SERVICE dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs Kubernetes network monitoring enabled, with SkyWalking Rover's eBPF probes feeding traffic telemetry and a Kubernetes metrics source feeding pod / resource state. Specifically:

- **Pod and resource metrics** — the `k8s_service_*` family (pod totals, waiting / restart status, CPU and memory requests / limits, and actual pod CPU / memory usage) for the service-scope lifecycle and resource widgets.

- **HTTP metrics** — the `kubernetes_service_http_*`, `kubernetes_service_instance_http_*`, and `kubernetes_service_endpoint_http_*` families covering call counts, response time, success rate, status classes, and header / body sizes, at their respective service / instance / endpoint scopes.

- **TCP metrics** — the `kubernetes_service_*` and `kubernetes_service_instance_*` connect, accept, packet, and byte families for the L4 widgets.

- **Relation metrics** — `kubernetes_service_relation_server/client_http_*` and `kubernetes_service_instance_relation_server/client_http_*` for the service map and instance map edges.

Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so an instance- or endpoint-scope metric is empty until that level of data is reported. For setup, see the [Kubernetes network monitoring](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-k8s-network-monitoring/) guide.
