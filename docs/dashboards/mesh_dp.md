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
# Istio Data Plane

The **MESH_DP** layer monitors the **Istio data plane** — the Envoy sidecar proxies that carry the mesh's traffic. Where the service-mesh control-plane and request telemetry live in the MESH layer, MESH_DP is the proxy's own view: the runtime health of each Envoy process and its upstream clusters, fed by Envoy's metrics-service output. It is grouped under **Istio** in the sidebar.

In Horizon's sidebar this layer's entities are the Envoy sidecars themselves. Its top-level entities are listed as **Sidecar services**, and each sidecar process is a **Sidecars** instance — there is no separate per-application service or endpoint slot, so MESH_DP reads "Sidecar service / Sidecar" rather than the GENERAL layer's "Service / Instance / Endpoint". Sidecar names follow the Istio `name.namespace` convention, so the namespace is surfaced as the displayed grouping.

MESH_DP enables the **Sidecar** (instance) dashboard plus the **Logs** and **eBPF profiling** tabs; pod logs are available for the sidecar. It does **not** ship a service dashboard, an endpoint dashboard, a topology / map view, or a traces tab — the layer is scoped to per-sidecar runtime metrics, so those sections are absent.

This page is the **operator reference** for the bundled MESH_DP dashboard: what you see on the sidecar scope and what each widget means.

> The widgets and metrics below are read from the bundled MESH_DP template; if an operator has published a customized MESH_DP template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Sidecar service list

The layer landing page lists every sidecar service. This layer defines no metric columns on the list, so the landing view is a plain, namespace-grouped roster of sidecar services — pick one to open its sidecars, then drill into a single sidecar's dashboard.

## Sidecar dashboard

For one selected sidecar (an Envoy instance). The dashboard opens with four single-value status cards, then a set of time-series trends.

**Status cards**

- **Bug Failures** — Envoy's internal bug-failure counter; a non-zero value means an assertion or debug check tripped inside the proxy (`envoy_bug_failures`).

- **Membership Healthy** — the count of healthy endpoints across all of this Envoy's upstream clusters (`envoy_cluster_membership_healthy`).

- **Worker Threads** — concurrent worker threads currently in use (`envoy_worker_threads`).

- **Upstream Request Active** — total active upstream requests across this Envoy's clusters (`envoy_cluster_up_rq_active`).

**Connections and requests**

- **Upstream Connection Active** — active upstream connections over time (`envoy_cluster_up_cx_active`).

- **Upstream Request Pending** — requests waiting in upstream queues (`envoy_cluster_up_rq_pending_active`).

- **Connections Used** — server-side connections in use, plotted as **total** and **parent** (`envoy_total_connections_used`, `envoy_parent_connections_used`).

- **Upstream Connection Increase** — new upstream connections opened per minute (`envoy_cluster_up_cx_incr`).

- **Upstream Request Increase** — new upstream requests per minute (`envoy_cluster_up_rq_incr`).

**Threads and memory**

- **Worker Threads (current vs max)** — concurrent worker threads in use plotted against the window maximum, as **current** and **max** (`envoy_worker_threads`, `envoy_worker_threads_max`).

- **Server Memory** — the proxy's memory footprint in bytes, each line paired with its window maximum: **heap** / **heap max** (`envoy_heap_memory_used`, `envoy_heap_memory_max_used`), **allocated** / **allocated max** (`envoy_memory_allocated`, `envoy_memory_allocated_max`), and **physical** / **physical max** (`envoy_memory_physical_size`, `envoy_memory_physical_size_max`).

## Logs and profiling

Beyond the dashboard, the sidecar's triage tabs are:

- **Logs** — the log stream is scoped to the sidecar (instance), so logs are read against the selected Envoy proxy rather than a higher-level service.

- **eBPF profiling** — on-CPU / network profiling of the sidecar process via the eBPF profiling workflow.

Pod logs are also available for the sidecar, surfacing the underlying pod's container output alongside the proxy's own log stream.

## Requirements

The MESH_DP dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs the **Envoy metrics-service** receiver enabled and the sidecars configured to push their metrics to it. Every widget on the sidecar dashboard reads the `envoy_*` metric family at instance scope:

- **Proxy health** — `envoy_bug_failures`, `envoy_cluster_membership_healthy`.

- **Worker threads** — `envoy_worker_threads`, `envoy_worker_threads_max`.

- **Upstream clusters** — `envoy_cluster_up_rq_active`, `envoy_cluster_up_cx_active`, `envoy_cluster_up_rq_pending_active`, `envoy_cluster_up_cx_incr`, `envoy_cluster_up_rq_incr`.

- **Server connections** — `envoy_total_connections_used`, `envoy_parent_connections_used`.

- **Server memory** — `envoy_heap_memory_used`, `envoy_heap_memory_max_used`, `envoy_memory_allocated`, `envoy_memory_allocated_max`, `envoy_memory_physical_size`, `envoy_memory_physical_size_max`.

These are instance-scope metrics; OAP does not roll a metric up across scopes, so the dashboard is empty until each sidecar's Envoy is actually reporting to the metrics-service receiver. For how to point Envoy at OAP, see Envoy's [metrics service setting](https://skywalking.apache.org/docs/main/next/en/setup/envoy/metrics_service_setting/).
