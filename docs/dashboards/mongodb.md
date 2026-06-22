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
# MongoDB

The **MONGODB** layer monitors [MongoDB](https://www.mongodb.com/) database clusters. SkyWalking collects MongoDB's internal metrics — document and operation throughput, connections, cursors, replication lag and buffer, per-database data and index size, and per-node host stats — and Horizon renders them as a cluster-level and a node-level dashboard. This is a metrics-only layer: there are no traces, logs, endpoints, or a topology map for MongoDB.

In Horizon's sidebar this layer is grouped under **Databases** and named **MongoDB**. Its services are listed as **MongoDB clusters** and its instances as **Nodes**. Because the layer carries no endpoint, topology, trace, or log data, it enables only two sub-tabs: a **Service** (cluster) dashboard and an **Instance** (node) dashboard.

This page is the **operator reference** for the bundled MONGODB dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled MONGODB template; if an operator has published a customized MONGODB template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

Before opening a cluster, the layer landing page lists every MongoDB cluster with four sortable columns, sorted by document throughput (**Doc QPS**) by default:

- **Doc QPS** — document operations per second across the cluster, summed over the document-operation types (`aggregate_labels(meter_mongodb_cluster_document_avg_qps, sum(doc_op_type))`).

- **Op QPS** — database operations per second across the cluster, summed over the operation types (`aggregate_labels(meter_mongodb_cluster_operation_avg_qps, sum(legacy_op_type))`).

- **Conns** — total open connections across the cluster (`aggregate_labels(meter_mongodb_cluster_connections,sum)`).

- **Repl Lag** — replication lag in ms (`meter_mongodb_cluster_repl_lag`).

## Service dashboard

The cluster-level drill-down for one selected MongoDB cluster. Most widgets aggregate across the cluster's nodes with `aggregate_labels(...)`.

- **Cluster Uptime (days)** — how long the cluster has been running, as a single card, taking the max uptime across nodes and converting from seconds (`latest(aggregate_labels(meter_mongodb_cluster_uptime,max))/3600/24`).

- **Data Size (GB)** — total stored data across the cluster, as a card, summed across nodes and converted from bytes (`latest(aggregate_labels(meter_mongodb_cluster_data_size,sum))/1024/1024/1024`).

- **Collection Count** — total number of collections across the cluster, as a card (`latest(aggregate_labels(meter_mongodb_cluster_collection_count,sum))`).

- **Object Count** — total number of objects (documents) across the cluster, as a card (`latest(aggregate_labels(meter_mongodb_cluster_object_count,sum))`).

- **Document QPS** — document operations per second over time, summed over the document-operation types (`aggregate_labels(meter_mongodb_cluster_document_avg_qps, sum(doc_op_type))`).

- **Operation QPS** — database operations per second over time, summed over the operation types (`aggregate_labels(meter_mongodb_cluster_operation_avg_qps, sum(legacy_op_type))`).

- **Total Connections** — open connections across the cluster over time (`aggregate_labels(meter_mongodb_cluster_connections,sum)`).

- **Cursor Total** — open cursors across the cluster, summed over the cursor types (`aggregate_labels(meter_mongodb_cluster_cursor_avg, sum(csr_type))`).

- **Replication Lag (ms)** — replication lag in ms (`meter_mongodb_cluster_repl_lag`).

- **DB Total Data (GB)** — a per-database table of stored data size in GB, summed per database and converted from bytes, with columns **Database** and **Data (GB)** (`latest(aggregate_labels(meter_mongodb_cluster_db_data_size, sum(database)))/1024/1024/1024`).

- **DB Total Index (GB)** — a per-database table of index size in GB, summed per database and converted from bytes, with columns **Database** and **Index (GB)** (`latest(aggregate_labels(meter_mongodb_cluster_db_index_size, sum(database)))/1024/1024/1024`).

## Instance dashboard

The node-level drill-down for one selected MongoDB node. These widgets read the per-node `meter_mongodb_node_*` family directly, with no cross-node aggregation.

- **Uptime (days)** — how long the node has been running, as a card, converted from seconds (`latest(meter_mongodb_node_uptime)/3600/24`).

- **QPS** — total query throughput on the node (`meter_mongodb_node_qps`).

- **ReplSet State** — a table of the node's replica-set state, with columns **Node** and **ReplSet state** (`latest(meter_mongodb_node_rs_state)`).

- **Connections** — open connections on the node (`meter_mongodb_node_connections`).

- **CPU Usage (%)** — total CPU usage percentage on the node (`meter_mongodb_node_cpu_total_percentage`).

- **Memory Usage** — memory used by the node (`meter_mongodb_node_memory_usage`).

- **Memory Free (GB)** — free memory in GB as two series, `mem` and `swap`, each converted from KB (`meter_mongodb_node_memory_free_kb/1024/1024`, `meter_mongodb_node_swap_memory_free_kb/1024/1024`).

- **Disk (GB)** — filesystem `used` vs `total` in GB, converted from bytes (`meter_mongodb_node_fs_used_size/1024/1024/1024`, `meter_mongodb_node_fs_total_size/1024/1024/1024`).

- **Network (KB/s)** — network throughput in KB/s as `in` vs `out`, converted from bytes (`meter_mongodb_node_network_bytes_in/1024`, `meter_mongodb_node_network_bytes_out/1024`).

- **Active Clients** — active client connections as `total`, `writers`, and `readers` (`meter_mongodb_node_active_total_num`, `meter_mongodb_node_active_writer_num`, `meter_mongodb_node_active_reader_num`).

- **Document QPS** — document operations per second on the node (`meter_mongodb_node_document_qps`).

- **Operation QPS** — database operations per second on the node (`meter_mongodb_node_operation_qps`).

- **Op Latency (µs)** — average operation latency in microseconds, computed as total latency divided by operation count, each summed over the operation types (`aggregate_labels(meter_mongodb_node_latency_rate,sum(op_type))/aggregate_labels(meter_mongodb_node_op_rate,sum(op_type))`).

- **Transactions** — `active` vs `inactive` transactions on the node (`meter_mongodb_node_transactions_active`, `meter_mongodb_node_transactions_inactive`).

- **Repl Buffer** — replication buffer `count` and `size (MB)`, the size converted from bytes (`meter_mongodb_node_repl_buffer_count`, `meter_mongodb_node_repl_buffer_size/1024/1024`).

- **Queued Operations** — operations queued on the node (`meter_mongodb_node_queued_operation`).

## Requirements

The MONGODB dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs MongoDB metrics, which OAP aggregates into the `meter_mongodb_*` families:

- **Cluster (service-scope) metrics** — the `meter_mongodb_cluster_*` family (uptime, data and index size, collection and object counts, document and operation QPS, connections, cursors, and replication lag), which the cluster dashboard and the Service list aggregate across nodes.

- **Node (instance-scope) metrics** — the `meter_mongodb_node_*` family (uptime, QPS, replica-set state, connections, CPU, memory, disk, network, active clients, document and operation QPS, operation latency, transactions, replication buffer, and queued operations) for the node dashboard.

Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so the node-scope widgets stay empty until per-node data is reported. Setting up MongoDB collection is described in the upstream [MongoDB monitoring](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-mongodb-monitoring/) guide.
