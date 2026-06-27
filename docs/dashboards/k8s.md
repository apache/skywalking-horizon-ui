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
# Kubernetes

The **K8S** layer monitors Kubernetes clusters and the nodes inside them. SkyWalking builds this layer from cluster-state and node-resource telemetry collected through OpenTelemetry (kube-state-metrics and the node / cAdvisor metric pipelines scraped into OAP) and reshapes it into cluster-wide and per-node metrics. In the sidebar it groups under **Kubernetes**.

In Horizon's sidebar this layer's entities are renamed to fit the Kubernetes model: services are listed as **Clusters** and instances as **Nodes**. The K8S layer enables the Service (Cluster) and Instance (Node) scopes only — there is no endpoint scope, no topology, and no traces or logs tab, because this layer reports cluster-state and node-resource metrics rather than request traffic.

This page is the **operator reference** for the bundled K8S dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled K8S template; if an operator has published a customized K8S template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Cluster list

Before opening a cluster, the layer landing page lists every Kubernetes cluster with four sortable columns, sorted by **Pods** by default. Each column shows the latest reading summed across the cluster:

- **Pods** — total pods in the cluster (`k8s_cluster_pod_total`).

- **Nodes** — total nodes in the cluster (`k8s_cluster_node_total`).

- **Namespaces** — total namespaces in the cluster (`k8s_cluster_namespace_total`).

- **Deployments** — total deployments in the cluster (`k8s_cluster_deployment_total`).

## Cluster dashboard

The primary drill-down for one selected cluster (a **Service** in OAP terms). It opens with a row of count cards summarizing the cluster's object inventory, then resource trends, then status tables that break the cluster down per node, deployment, service, and pod.

**Inventory cards** — each is a single latest count:

- **Node Total** — nodes in the cluster (`latest(k8s_cluster_node_total)`).

- **Namespace Total** — namespaces in the cluster (`latest(k8s_cluster_namespace_total)`).

- **Deployment Total** — deployments in the cluster (`latest(k8s_cluster_deployment_total)`).

- **StatefulSet Total** — statefulsets in the cluster (`latest(k8s_cluster_statefulset_total)`).

- **DaemonSet Total** — daemonsets in the cluster (`latest(k8s_cluster_daemonset_total)`).

- **Service Total** — Kubernetes services in the cluster (`latest(k8s_cluster_service_total)`).

- **Pod Total** — pods in the cluster (`latest(k8s_cluster_pod_total)`).

- **Container Total** — containers in the cluster (`latest(k8s_cluster_container_total)`).

**Resource trends** — cluster-wide capacity vs. demand over time:

- **CPU Resources** — cluster CPU capacity against requests, limits, and allocatable, in millicores (`k8s_cluster_cpu_cores`, `k8s_cluster_cpu_cores_requests`, `k8s_cluster_cpu_cores_limits`, `k8s_cluster_cpu_cores_allocatable`).

- **Memory Resources** — cluster memory requests, allocatable, limits, and total, in GiB (`k8s_cluster_memory_requests`, `k8s_cluster_memory_allocatable`, `k8s_cluster_memory_limits`, `k8s_cluster_memory_total`).

- **Storage Resources** — cluster ephemeral-storage total against allocatable, in GiB (`k8s_cluster_storage_total`, `k8s_cluster_storage_allocatable`).

**Status tables** — each lists the entities currently matching the condition; they read `no data` when nothing matches:

- **Node Status** — per-node Kubernetes conditions currently true or unknown — Ready, the various Pressure conditions, and so on (`latest(k8s_cluster_node_status)`).

- **Deployment Status** — deployments reporting the Available condition (`latest(k8s_cluster_deployment_status)`).

- **Deployment Spec Replicas** — desired replica count per deployment (`latest(k8s_cluster_deployment_spec_replicas)`).

- **Service Status** — pods backing each Kubernetes service, grouped by pod phase — Running / Pending / Failed and so on (`latest(k8s_cluster_service_pod_status)`).

- **Pod Status Not Running** — pods in any non-Running phase (`latest(k8s_cluster_pod_status_not_running)`).

- **Pod Status Waiting** — containers in a waiting state, grouped by the waiting reason (`latest(k8s_cluster_pod_status_waiting)`).

## Node dashboard

For one selected node (an **Instance** in OAP terms) — its scheduling state and CPU / memory / network / storage resources.

- **Node Status** — the node's current status as a single latest reading (`latest(k8s_node_node_status)`).

- **Pods on Node** — pods scheduled on the node over time (`k8s_node_pod_total`).

- **Pod Total** — the current count of pods scheduled on the node, as a single latest reading (`latest(k8s_node_pod_total)`).

- **Node CPU Usage** — node CPU usage in millicores (`k8s_node_cpu_usage`).

- **Node CPU Resources** — node CPU total against allocatable, requests, and limits, in millicores (`k8s_node_cpu_cores`, `k8s_node_cpu_cores_allocatable`, `k8s_node_cpu_cores_requests`, `k8s_node_cpu_cores_limits`).

- **Node Memory Usage** — node memory usage in GiB (`k8s_node_memory_usage`).

- **Node Memory Resources** — node memory total against allocatable, requests, and limits, in GiB (`k8s_node_memory_total`, `k8s_node_memory_allocatable`, `k8s_node_memory_requests`, `k8s_node_memory_limits`).

- **Node Network I/O** — node receive and transmit throughput in KB/s (`k8s_node_network_receive`, `k8s_node_network_transmit`).

- **Node Storage Resources** — node storage total against allocatable, in GiB (`k8s_node_storage_total`, `k8s_node_storage_allocatable`).

## Requirements

The K8S dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs the Kubernetes monitoring metric families, fed in through the OpenTelemetry receiver from kube-state-metrics and the node / cAdvisor pipelines:

- **Cluster metrics** — the `k8s_cluster_*` family at cluster scope: object-inventory totals (node / namespace / deployment / statefulset / daemonset / service / pod / container), CPU / memory / storage capacity-and-demand series, and the per-node, per-deployment, per-service, and per-pod status breakdowns.

- **Node metrics** — the `k8s_node_*` family at node scope: node status, pod count, and CPU / memory / network / storage usage and resource series.

Each metric is queried at its own OAP scope (Cluster / Node); OAP does not roll a metric up across scopes, so a node-scope metric stays empty until that level of data is reported. For how to stand up the Kubernetes-to-OAP pipeline, see the layer's [setup documentation](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-k8s-monitoring/).
