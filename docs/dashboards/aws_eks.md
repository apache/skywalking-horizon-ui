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
# AWS EKS

The **AWS_EKS** layer monitors Amazon Elastic Kubernetes Service (EKS) clusters. SkyWalking ingests EKS observability data through OpenTelemetry — Container Insights / CloudWatch metrics scraped into OAP — and reshapes it into cluster, node, and pod metrics. It groups under **AWS** in the sidebar.

In Horizon's sidebar this layer's entities are renamed to fit the EKS model: services are listed as **Clusters**, instances as **Nodes**, and endpoints as **EKS services** (the Kubernetes services running inside the cluster). The AWS_EKS layer enables the Service (Cluster), Instance (Node), and Endpoint (EKS service) scopes; it does **not** enable a topology, traces, or logs tab — EKS reports metric data only.

This page is the **operator reference** for the bundled AWS_EKS dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled AWS_EKS template; if an operator has published a customized AWS_EKS template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Cluster list

Before opening a cluster, the layer landing page lists every EKS cluster with four sortable columns, sorted by **Nodes** by default. Each column shows the latest reading averaged across the window:

- **Nodes** — number of nodes in the cluster (`latest(eks_cluster_node_count)`).

- **Failed Nodes** — nodes currently in a failed state (`latest(eks_cluster_failed_node_count)`).

- **Namespaces** — Kubernetes namespaces in the cluster (`latest(eks_cluster_namespace_count)`).

- **Services** — Kubernetes services in the cluster (`latest(eks_cluster_service_count)`).

## Cluster dashboard

The primary drill-down for one selected cluster (a **Service** in OAP terms).

- **Node Count** — number of nodes over time (`eks_cluster_node_count`).

- **Failed Nodes** — nodes in a failed state over time (`eks_cluster_failed_node_count`).

- **Namespace Count** — Kubernetes namespaces in the cluster (`eks_cluster_namespace_count`).

- **EKS Service Count** — Kubernetes services in the cluster (`eks_cluster_service_count`).

- **Cluster Network Errors** — cluster-wide receive and transmit error counts, plotted as two series, **rx** (`eks_cluster_net_rx_error`) and **tx** (`eks_cluster_net_tx_error`).

- **Cluster Network Drops** — cluster-wide dropped packets on receive and transmit, **rx** (`eks_cluster_net_rx_dropped`) and **tx** (`eks_cluster_net_tx_dropped`).

## Node dashboard

For one selected node (an **Instance** in OAP terms).

- **Pod Count** — pods scheduled on the node (`eks_cluster_node_pod_number`).

- **CPU Utilization (%)** — node CPU utilization (`eks_cluster_node_cpu_utilization`).

- **Memory Utilization (%)** — node memory utilization (`eks_cluster_node_memory_utilization`).

- **FS Utilization (%)** — node filesystem utilization (`eks_cluster_node_fs_utilization`).

- **Network RX (KB/s)** — node receive throughput in KB/s (`eks_cluster_node_net_rx_bytes/1024`) on the left axis, with receive errors (`eks_cluster_node_net_rx_error`) on a second axis so the error count doesn't get lost against the byte scale.

- **Network TX (KB/s)** — node transmit throughput in KB/s (`eks_cluster_node_net_tx_bytes/1024`) on the left axis, with transmit errors (`eks_cluster_node_net_tx_error`) on a second axis.

- **Disk IO (B/s)** — node disk read and write throughput in bytes/s, plotted as **read** (`eks_cluster_node_disk_io_read`) and **write** (`eks_cluster_node_disk_io_write`).

- **Pod CPU on Node** — aggregate CPU utilization of the pods running on this node (`eks_cluster_node_pod_cpu_utilization`).

- **Pod Memory on Node** — aggregate memory utilization of the pods running on this node (`eks_cluster_node_pod_memory_utilization`).

## EKS service dashboard

For one selected EKS service (an **Endpoint** in OAP terms) — a Kubernetes service running inside the cluster, with its pod-level resource and network metrics.

- **Pod CPU Utilization (%)** — CPU utilization across the service's pods (`eks_cluster_service_pod_cpu_utilization`).

- **Pod Memory Utilization (%)** — memory utilization across the service's pods (`eks_cluster_service_pod_memory_utilization`).

- **Pod Network RX (KB/s)** — pod receive throughput in KB/s (`eks_cluster_service_pod_net_rx_bytes/1024`).

- **Pod RX Errors / s** — pod receive error rate (`eks_cluster_service_pod_net_rx_error`).

- **Pod Network TX (KB/s)** — pod transmit throughput in KB/s (`eks_cluster_service_pod_net_tx_bytes/1024`).

- **Pod TX Errors / s** — pod transmit error rate (`eks_cluster_service_pod_net_tx_error`).

## Requirements

The AWS_EKS dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs the EKS observability metric families, fed in through the OpenTelemetry receiver from Amazon CloudWatch / Container Insights:

- **Cluster metrics** — the `eks_cluster_*` family at cluster scope: node / failed-node / namespace / service counts and cluster-wide network error and drop counters.

- **Node metrics** — the `eks_cluster_node_*` family at node scope: pod count, CPU / memory / filesystem utilization, network receive / transmit bytes and errors, disk read / write IO, and the per-node aggregate pod CPU / memory utilization.

- **EKS service metrics** — the `eks_cluster_service_pod_*` family at EKS-service scope: per-service pod CPU / memory utilization and pod network receive / transmit bytes and errors.

Each metric is queried at its own OAP scope (Cluster / Node / EKS service); OAP does not roll a metric up across scopes, so a node- or service-scope metric stays empty until that level of data is reported. For how to stand up the EKS-to-OAP pipeline, see the layer's [setup documentation](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-aws-eks-monitoring/).
