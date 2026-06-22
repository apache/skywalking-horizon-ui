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
# Elasticsearch

The **ELASTICSEARCH** layer monitors Elasticsearch clusters that OAP scrapes through its Elasticsearch monitoring receiver. It groups under **Databases** in the sidebar and gives an operator the cluster-health, node-runtime, and per-index view that an Elasticsearch admin expects.

In Horizon's sidebar this layer carries the display name **Elasticsearch**. An Elasticsearch cluster maps onto SkyWalking's entity scopes, and the layer renames each slot to match: services are listed as **ES clusters**, instances as **Nodes**, and endpoints as **Indices**. The layer enables three drill-down tabs — Service (the cluster dashboard), Instance (a node), and Endpoint (an index). It ships no topology, traces, or logs tabs.

This page is the **operator reference** for the bundled ELASTICSEARCH dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled ELASTICSEARCH template; if an operator has published a customized ELASTICSEARCH template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## ES clusters list

Before opening a cluster, the layer landing page lists every Elasticsearch cluster with four sortable columns, sorted by **Shards** by default:

- **Health** — the cluster health status (`meter_elasticsearch_cluster_health_status`), averaged over the window.

- **Shards** — total active shards across the cluster (`meter_elasticsearch_cluster_shards_total`, latest value).

- **Nodes** — number of nodes in the cluster (`meter_elasticsearch_cluster_nodes`, latest value).

- **Unassigned** — shards the cluster has not yet placed on a node (`meter_elasticsearch_cluster_unassigned_shards_total`, latest value) — a non-zero value is the usual first sign of a cluster under stress.

## Service dashboard (cluster)

The primary drill-down for one selected cluster — the cluster-wide health and capacity picture.

- **Cluster Health** — a table of the current health status and value (`meter_elasticsearch_cluster_health_status`, latest), the green / yellow / red rollup Elasticsearch reports for the cluster.

- **Nodes** — number of nodes currently in the cluster (`meter_elasticsearch_cluster_nodes`, latest).

- **Pending Tasks** — average count of cluster-level tasks queued for the master (`meter_elasticsearch_cluster_pending_tasks_total`) — a rising queue points at master-node pressure.

- **Primary Shards** — total primary shards (`meter_elasticsearch_cluster_primary_shards_total`, latest).

- **Active Shards** — total active shards (`meter_elasticsearch_cluster_shards_total`, latest).

- **Initializing** — shards currently initializing (`meter_elasticsearch_cluster_initializing_shards_total`, latest).

- **Relocating** — shards being moved between nodes (`meter_elasticsearch_cluster_relocating_shards_total`, latest).

- **Unassigned** — shards not assigned to any node (`meter_elasticsearch_cluster_unassigned_shards_total`, latest).

- **Delayed Unassigned** — unassigned shards whose reassignment is being delayed (`meter_elasticsearch_cluster_delayed_unassigned_shards_total`, latest).

- **Tripped Breakers** — count of tripped circuit breakers across the cluster (`meter_elasticsearch_cluster_breakers_tripped`, latest), a memory-protection signal.

- **Cluster CPU Avg** — average CPU usage across the cluster's nodes in percent (`meter_elasticsearch_cluster_cpu_usage_avg`).

- **JVM Memory Used Avg** — average JVM heap memory used across the cluster (`meter_elasticsearch_cluster_jvm_memory_used_avg`).

- **Open Files Avg** — average open file-descriptor count across the cluster (`meter_elasticsearch_cluster_open_file_count`).

## Instance dashboard (node)

For one selected node — the per-node OS, JVM, and storage detail.

- **Process CPU (%)** — CPU consumed by the Elasticsearch process (`meter_elasticsearch_node_process_cpu_percent`).

- **OS CPU (%)** — host CPU usage on the node (`meter_elasticsearch_node_os_cpu_percent`).

- **Load Average** — the node's 1-minute, 5-minute, and 15-minute OS load averages (`meter_elasticsearch_node_os_load1`, `meter_elasticsearch_node_os_load5`, `meter_elasticsearch_node_os_load15`).

- **JVM Memory (MB)** — heap used, heap max, and non-heap used in MB (`meter_elasticsearch_node_jvm_memory_heap_used`, `meter_elasticsearch_node_jvm_memory_heap_max`, `meter_elasticsearch_node_jvm_memory_nonheap_used`).

- **GC** — garbage-collection activity on a dual axis: GC count on the left, GC time in ms/min on the right (`meter_elasticsearch_node_jvm_gc_count`, `meter_elasticsearch_node_jvm_gc_time`).

- **Translog** — transaction-log operations and translog size in MB on a dual axis (`meter_elasticsearch_node_indices_translog_operations`, `meter_elasticsearch_node_indices_translog_size`).

- **Breakers** — tripped circuit breakers and the estimated breaker size in MB on this node (`meter_elasticsearch_node_breakers_tripped`, `meter_elasticsearch_node_breakers_estimated_size`).

- **Segments** — Lucene segment count and segment memory in MB on a dual axis (`meter_elasticsearch_node_segment_count`, `meter_elasticsearch_node_segment_memory`).

- **Disk Usage** — disk used in GB and disk-used percent on a dual axis (`meter_elasticsearch_node_disk_usage`, `meter_elasticsearch_node_disk_usage_percent`).

- **Network** — bytes sent and received on the node (`meter_elasticsearch_node_network_send_bytes`, `meter_elasticsearch_node_network_receive_bytes`).

- **Open Files** — average open file-descriptor count on the node (`meter_elasticsearch_node_open_file_count`).

## Endpoint dashboard (index)

For one selected index — indexing throughput, search throughput, size, and document counts.

- **Indexing Rate** — indexing requests vs. processed operations (`meter_elasticsearch_index_stats_indexing_index_total_req_rate`, `meter_elasticsearch_index_stats_indexing_index_total_proc_rate`).

- **Search Rate** — search-query requests vs. processed operations (`meter_elasticsearch_index_stats_search_query_total_req_rate`, `meter_elasticsearch_index_stats_search_query_total_proc_rate`).

- **Index Size (all shards)** — total store size of the index across all shards in GB (`meter_elasticsearch_index_indices_store_size_bytes_total`, latest).

- **Index Size (primary)** — store size of the index's primary shards in GB (`meter_elasticsearch_index_indices_store_size_bytes_primary`, latest).

- **Documents** — document counts: all, primary, and deleted (`meter_elasticsearch_index_indices_docs_total`, `meter_elasticsearch_index_indices_docs_primary`, `meter_elasticsearch_index_indices_deleted_docs_primary`).

- **Avg Search Time / Req (s)** — average per-request time in seconds for each search phase: fetch, query, scroll, and suggest (`meter_elasticsearch_index_search_fetch_avg_time`, `meter_elasticsearch_index_search_query_avg_time`, `meter_elasticsearch_index_search_scroll_avg_time`, `meter_elasticsearch_index_search_suggest_avg_time`).

## Requirements

The ELASTICSEARCH dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs Elasticsearch monitoring enabled (see the upstream [Elasticsearch monitoring](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-elasticsearch-monitoring/) setup), which feeds the three metric families this dashboard reads:

- **Cluster metrics** — the `meter_elasticsearch_cluster_*` family (health, node count, shard states, pending tasks, tripped breakers, average CPU / JVM memory / open files) for the cluster list and the Service dashboard.

- **Node metrics** — the `meter_elasticsearch_node_*` family (process / OS CPU, load averages, JVM memory and GC, translog, breakers, segments, disk, network, open files) for the Instance dashboard.

- **Index metrics** — the `meter_elasticsearch_index_*` family (indexing and search rates, store size, document counts, per-phase search times) for the Endpoint dashboard.

Each metric is queried at its own OAP scope — cluster metrics at service scope, node metrics at instance scope, index metrics at endpoint scope. OAP does not roll a metric up across scopes, so a node- or index-scope widget stays empty until that level of data is reported.
