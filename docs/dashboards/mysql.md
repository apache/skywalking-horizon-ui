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
# MySQL / MariaDB

The **MYSQL** layer monitors MySQL and MariaDB servers. It is populated by OAP's MySQL/MariaDB monitoring, which scrapes a Prometheus-style mysqld-exporter and turns the result into SkyWalking meters — there is no language agent here, the data comes from the exporter.

In Horizon's sidebar this layer lives under the **Databases** group and is named **MySQL / MariaDB**. A monitored cluster is listed as a **MySQL cluster** and each member server as a **Node**. This is a metrics-only layer: it enables the **Service** and **Instance** scopes and nothing else — there is no endpoint scope, no topology, and no traces or logs tabs.

This page is the **operator reference** for the bundled MySQL / MariaDB dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled MYSQL template; if an operator has published a customized MYSQL template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

Before opening a cluster, the layer landing page lists every MySQL cluster with four sortable columns, sorted by **QPS** by default. Each column aggregates the per-node meters across the whole cluster:

- **QPS** — queries per second across the cluster (`aggregate_labels(meter_mysql_qps,sum)`).

- **TPS** — transactions per second across the cluster (`aggregate_labels(meter_mysql_tps,sum)`).

- **Slow QPS** — slow queries per second across the cluster (`aggregate_labels(meter_mysql_slow_queries_rate,sum)`).

- **Conn Errors** — connection-error rate, internal rejects plus max-connection rejects summed (`aggregate_labels(meter_mysql_connection_errors_internal,sum) + aggregate_labels(meter_mysql_connection_errors_max_connections,sum)`).

## Service dashboard

The primary drill-down for one selected cluster. Every widget here aggregates across the cluster's nodes with `aggregate_labels(..., sum)`.

- **QPS** — cluster-wide queries per second (`aggregate_labels(meter_mysql_qps,sum)`).

- **TPS** — cluster-wide transactions per second (`aggregate_labels(meter_mysql_tps,sum)`).

- **Slow Queries / s** — cluster-wide slow-query rate (`aggregate_labels(meter_mysql_slow_queries_rate,sum)`).

- **Connection Errors** — two series, internal rejects vs max-connection rejects (`aggregate_labels(meter_mysql_connection_errors_internal,sum)` and `aggregate_labels(meter_mysql_connection_errors_max_connections,sum)`).

- **Commands Trend** — rows-affected rate per command type: select / insert / update / delete (`aggregate_labels(meter_mysql_commands_select_rate,sum)`, `meter_mysql_commands_insert_rate`, `meter_mysql_commands_update_rate`, `meter_mysql_commands_delete_rate`).

- **Threads** — thread counters: connected / running / cached / created (`aggregate_labels(meter_mysql_threads_connected,sum)`, `meter_mysql_threads_running`, `meter_mysql_threads_cached`, `meter_mysql_threads_created`).

- **Slow Statements** — the top 20 slowest captured statements across the cluster, in ms, worst-first (`top_n(top_n_database_statement, 20, des)`). Each row carries the sampled statement text. Shows `no data` when OAP captured no statements in the window.

## Instance dashboard

For one selected **Node** (a single MySQL/MariaDB server in the cluster). The four top cards are point-in-time configuration / status readings; the rest are per-node time series.

**Status cards**

- **Uptime** — how long the server has been up, in days (`latest(meter_mysql_instance_uptime)/3600/24`).

- **Max Connections** — the server's configured `max_connections` ceiling (`latest(meter_mysql_instance_max_connections)`).

- **InnoDB Buffer Pool** — the InnoDB buffer-pool size in MB (`latest(meter_mysql_instance_innodb_buffer_pool_size)/1024/1024`).

- **Thread Cache Size** — the configured thread-cache size (`latest(meter_mysql_instance_thread_cache_size)`).

**Time series**

- **QPS / TPS** — this node's queries per second and transactions per second on one chart (`meter_mysql_instance_qps`, `meter_mysql_instance_tps`).

- **Slow Queries / s** — this node's slow-query rate (`meter_mysql_instance_slow_queries_rate`).

- **Commands Trend** — rows-affected rate per command type for this node: select / insert / update / delete (`meter_mysql_instance_commands_select_rate`, `meter_mysql_instance_commands_insert_rate`, `meter_mysql_instance_commands_update_rate`, `meter_mysql_instance_commands_delete_rate`).

- **Threads** — this node's thread counters: connected / running / cached / created (`meter_mysql_instance_threads_connected`, `meter_mysql_instance_threads_running`, `meter_mysql_instance_threads_cached`, `meter_mysql_instance_threads_created`).

- **Connects** — available vs aborted connection rate (`meter_mysql_instance_connects_available`, `meter_mysql_instance_connects_aborted`).

- **Connection Errors** — internal rejects vs max-connection rejects for this node (`meter_mysql_instance_connection_errors_internal`, `meter_mysql_instance_connection_errors_max_connections`).

## Requirements

The MySQL / MariaDB dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs MySQL/MariaDB monitoring enabled so it scrapes a mysqld-exporter and produces:

- **Cluster (service-scope) meters** — the `meter_mysql_*` family: QPS / TPS, slow-query rate, connection errors, the per-command rates, and the thread counters. These back the Service list and the Service dashboard.

- **Node (instance-scope) meters** — the `meter_mysql_instance_*` family: uptime, max-connections, InnoDB buffer-pool size, thread-cache size, and the per-node QPS/TPS, slow-query, command, thread, connect, and connection-error series. These back the Instance dashboard.

- **Sampled statements** — `top_n_database_statement` for the Slow Statements list, captured by OAP when slow-statement sampling is configured.

Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so the node-scope `meter_mysql_instance_*` series are empty until per-node data is reported. For the upstream setup steps — exporter configuration and which OAP rules to enable — see the [MySQL/MariaDB monitoring documentation](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-mysql-monitoring/).
