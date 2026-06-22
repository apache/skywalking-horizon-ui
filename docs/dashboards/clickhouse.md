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
# ClickHouse

The **CLICKHOUSE** layer monitors [ClickHouse](https://clickhouse.com/) database clusters. SkyWalking collects ClickHouse's internal metrics — queries, query latency, merges and mutations, data parts, replication, ZooKeeper / Keeper coordination, and per-node host stats — through OpenTelemetry, and Horizon renders them as a cluster-level and a node-level dashboard. This is a metrics-only layer: there are no traces, logs, endpoints, or a topology map for ClickHouse.

In Horizon's sidebar this layer is grouped under **Databases** and named **ClickHouse**. Its services are listed as **ClickHouse clusters** and its instances as **Nodes**. Because the layer carries no endpoint, topology, trace, or log data, it enables only two sub-tabs: a **Service** (cluster) dashboard and an **Instance** (node) dashboard.

This page is the **operator reference** for the bundled CLICKHOUSE dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled CLICKHOUSE template; if an operator has published a customized CLICKHOUSE template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

Before opening a cluster, the layer landing page lists every ClickHouse cluster with four sortable columns, sorted by select rate (**Select / s**) by default:

- **Select / s** — `SELECT` queries per second across the cluster (`aggregate_labels(meter_clickhouse_query_select_rate,sum)`).

- **Insert / s** — `INSERT` queries per second across the cluster (`aggregate_labels(meter_clickhouse_query_insert_rate,sum)`).

- **Slow Reads** — slow file reads across the cluster (`aggregate_labels(meter_clickhouse_query_slow,sum)`).

- **Open Files** — the latest count of open files across the cluster (`latest(aggregate_labels(meter_clickhouse_file_open,sum))`).

## Service dashboard

The cluster-level drill-down for one selected ClickHouse cluster. Every widget aggregates across the cluster's nodes with `aggregate_labels(...,sum)`.

- **Files Open** — the latest number of open files in the cluster, as a single card (`latest(aggregate_labels(meter_clickhouse_file_open,sum))`).

- **QPS** — query rate per second, plotted as two series: `select` (`aggregate_labels(meter_clickhouse_query_select_rate,sum)`) and `insert` (`aggregate_labels(meter_clickhouse_query_insert_rate,sum)`).

- **Queries** — query counts split into `total`, `select`, and `insert` (`aggregate_labels(meter_clickhouse_query,sum)`, `aggregate_labels(meter_clickhouse_query_select,sum)`, `aggregate_labels(meter_clickhouse_query_insert,sum)`).

- **Query Time (ms)** — average time per query in ms, as `avg`, `select`, and `insert` series, each computed as total query microseconds divided by query count and converted to ms (`aggregate_labels(meter_clickhouse_querytime_microseconds,sum)/aggregate_labels(meter_clickhouse_query,sum)/1000` and the matching `_select_` / `_insert_` pair).

- **Connections** — open client connections by protocol: `TCP` (`aggregate_labels(meter_clickhouse_tcp_connections,sum)`) and `HTTP` (`aggregate_labels(meter_clickhouse_http_connections,sum)`).

- **Slow Reads** — slow file reads across the cluster (`aggregate_labels(meter_clickhouse_query_slow,sum)`).

- **Merge / Mutations** — background `merge` operations (`aggregate_labels(meter_clickhouse_background_merge,sum)`) and `mutations` (`aggregate_labels(meter_clickhouse_mutations,sum)`).

- **Insert Throughput** — insert volume on a dual axis: `bytes/s` on the left (`aggregate_labels(meter_clickhouse_inserted_bytes,sum)`) and `rows/s` on the right (`aggregate_labels(meter_clickhouse_inserted_rows,sum)`).

- **Delayed Inserts (s)** — inserts that were throttled / delayed (`aggregate_labels(meter_clickhouse_delayed_inserts,sum)`).

- **Active Data Parts** — the number of active MergeTree data parts in the cluster (`aggregate_labels(meter_clickhouse_parts_active,sum)`).

- **Replicated Fetch / Send** — replication traffic between replicas: `fetch` (`aggregate_labels(meter_clickhouse_replicated_fetch,sum)`) and `send` (`aggregate_labels(meter_clickhouse_replicated_send,sum)`).

- **Zookeeper Activity** — the coordination layer's health, with the latest `sessions` and `watches` (`latest(aggregate_labels(meter_clickhouse_zookeeper_session,sum))`, `latest(aggregate_labels(meter_clickhouse_zookeeper_watch,sum))`) plus `bytes sent` and `bytes recv` over time (`aggregate_labels(meter_clickhouse_zookeeper_bytes_sent,sum)`, `aggregate_labels(meter_clickhouse_zookeeper_bytes_received,sum)`).

- **Keeper Alive Conns** — the latest count of alive ClickHouse Keeper connections, as a single card (`latest(aggregate_labels(meter_clickhouse_keeper_connections_alive,sum))`).

- **Keeper Outstanding Requests** — the latest count of outstanding ClickHouse Keeper requests, as a single card (`latest(aggregate_labels(meter_clickhouse_keeper_outstanding_requests,sum))`).

## Instance dashboard

The node-level drill-down for one selected ClickHouse node. These widgets read the per-node `meter_clickhouse_instance_*` family directly, with no cross-node aggregation.

- **Uptime (days)** — how long the node has been running, as a card, converted from seconds (`latest(meter_clickhouse_instance_uptime)/3600/24`).

- **Version** — the node's ClickHouse version, as a card (`latest(meter_clickhouse_instance_version)`).

- **CPU (cores)** — CPU consumption expressed in cores (`meter_clickhouse_instance_cpu_usage/1000000`).

- **Memory (%)** — `used` vs `available` memory percentage (`meter_clickhouse_instance_memory_usage`, `meter_clickhouse_instance_memory_available`).

- **Network (B)** — bytes `receive` vs `send` on the node (`meter_clickhouse_instance_network_receive_bytes`, `meter_clickhouse_instance_network_send_bytes`).

- **Connections** — open client connections by protocol: `TCP` (`meter_clickhouse_instance_tcp_connections`) and `HTTP` (`meter_clickhouse_instance_http_connections`).

- **Queries** — query counts split into `total`, `select`, and `insert` (`meter_clickhouse_instance_query`, `meter_clickhouse_instance_query_select`, `meter_clickhouse_instance_query_insert`).

- **QPS** — query rate per second, as `select` and `insert` series (`meter_clickhouse_instance_query_select_rate`, `meter_clickhouse_instance_query_insert_rate`).

- **Query Time (ms)** — average time per query in ms, as `avg`, `select`, and `insert` series, each total query microseconds divided by query count and converted to ms (`meter_clickhouse_instance_querytime_microseconds/meter_clickhouse_instance_query/1000` and the matching `_select_` / `_insert_` pair).

- **File Slow Read** — slow file reads on the node (`meter_clickhouse_instance_query_slow`).

- **Background Merge** — background merge operations on the node (`meter_clickhouse_instance_background_merge`).

- **Mutations** — mutation operations on the node (`meter_clickhouse_instance_mutations`).

- **Files Open** — the latest number of open files on the node, as a card (`latest(meter_clickhouse_instance_file_open)`).

- **Insert Throughput** — insert volume on a dual axis: `bytes/s` on the left (`meter_clickhouse_instance_inserted_bytes`) and `rows/s` on the right (`meter_clickhouse_instance_inserted_rows`).

- **Delayed Inserts (s)** — inserts that were throttled / delayed on the node (`meter_clickhouse_instance_delayed_inserts`).

## Requirements

The CLICKHOUSE dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs ClickHouse metrics delivered through the OpenTelemetry receiver, which OAP aggregates into the `meter_clickhouse_*` families:

- **Cluster (service-scope) metrics** — the `meter_clickhouse_*` family (queries, query rate, query time, connections, slow reads, merges, mutations, data parts, insert throughput, delayed inserts, replication, ZooKeeper, and Keeper), which the cluster dashboard and the Service list aggregate across nodes.

- **Node (instance-scope) metrics** — the `meter_clickhouse_instance_*` family (uptime, version, CPU, memory, network, connections, queries, query rate, query time, slow reads, merges, mutations, open files, and insert throughput) for the node dashboard.

Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so the node-scope widgets stay empty until per-node data is reported. Setting up the ClickHouse OpenTelemetry collection is described in the upstream [ClickHouse monitoring](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-clickhouse-monitoring/) guide.
