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
# PostgreSQL

The **POSTGRESQL** layer monitors PostgreSQL servers. It is populated by OAP's PostgreSQL monitoring, which scrapes a Prometheus-style postgres-exporter and turns the result into SkyWalking meters — there is no language agent here, the data comes from the exporter.

In Horizon's sidebar this layer lives under the **Databases** group and is named **PostgreSQL**. A monitored cluster is listed as a **PostgreSQL cluster** and each member server as a **Node**. This is a metrics-only layer: it enables the **Service** and **Instance** scopes and nothing else — there is no endpoint scope, no topology, and no traces or logs tabs.

This page is the **operator reference** for the bundled PostgreSQL dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled POSTGRESQL template; if an operator has published a customized POSTGRESQL template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

Before opening a cluster, the layer landing page lists every PostgreSQL cluster with four sortable columns, sorted by **Fetched / s** by default. Each column aggregates the per-node meters across the whole cluster:

- **Fetched / s** — rows fetched per second across the cluster (`aggregate_labels(meter_pg_fetched_rows_rate,sum)`).

- **Inserted / s** — rows inserted per second across the cluster (`aggregate_labels(meter_pg_inserted_rows_rate,sum)`).

- **Cache Hit** — buffer-cache hit ratio across the cluster, in percent (`aggregate_labels(meter_pg_cache_hit_rate,avg)`).

- **Deadlocks** — deadlocks per second across the cluster (`aggregate_labels(meter_pg_deadlocks_rate,sum)`).

## Service dashboard

The primary drill-down for one selected cluster. Most widgets here aggregate across the cluster's nodes with `aggregate_labels(...)`.

- **Fetched Rows / s** — cluster-wide rows fetched per second (`aggregate_labels(meter_pg_fetched_rows_rate,sum)`).

- **Inserted Rows / s** — cluster-wide rows inserted per second (`aggregate_labels(meter_pg_inserted_rows_rate,sum)`).

- **Updated Rows / s** — cluster-wide rows updated per second (`aggregate_labels(meter_pg_updated_rows_rate,sum)`).

- **Deleted Rows / s** — cluster-wide rows deleted per second (`aggregate_labels(meter_pg_deleted_rows_rate,sum)`).

- **Returned Rows / s** — cluster-wide rows returned per second (`aggregate_labels(meter_pg_returned_rows_rate,sum)`).

- **Temporary Files / s** — temporary files created per second across the cluster, a sign of queries spilling to disk (`aggregate_labels(meter_pg_temporary_files_rate,sum)`).

- **Cache Hit Rate** — cluster-wide buffer-cache hit ratio in percent (`aggregate_labels(meter_pg_cache_hit_rate,avg)`).

- **Transactions / s** — committed vs rolled-back transactions per second (`aggregate_labels(meter_pg_committed_transactions_rate,sum)` and `aggregate_labels(meter_pg_rolled_back_transactions_rate,sum)`).

- **Conflicts + Deadlocks / s** — two series, recovery conflicts vs deadlocks per second (`aggregate_labels(meter_pg_conflicts_rate,sum)` and `aggregate_labels(meter_pg_deadlocks_rate,sum)`).

- **Sessions** — active vs idle sessions and the lock count across the cluster (`aggregate_labels(meter_pg_active_sessions,sum)`, `aggregate_labels(meter_pg_idle_sessions,sum)`, `aggregate_labels(meter_pg_locks_count,sum)`).

- **Buffers / s** — background-writer and checkpoint buffer activity: checkpoint / clean / backend fsync / alloc / backend (`aggregate_labels(meter_pg_buffers_checkpoint,sum)`, `aggregate_labels(meter_pg_buffers_clean,sum)`, `aggregate_labels(meter_pg_buffers_backend_fsync,sum)`, `aggregate_labels(meter_pg_buffers_alloc,sum)`, `aggregate_labels(meter_pg_buffers_backend,sum)`).

- **Checkpoint Stats / s** — checkpoint counters: timed / requested / write time / sync time (`aggregate_labels(meter_pg_checkpoints_timed_rate,sum)`, `aggregate_labels(meter_pg_checkpoint_req_rate,sum)`, `aggregate_labels(meter_pg_checkpoint_write_time_rate,sum)`, `aggregate_labels(meter_pg_checkpoint_sync_time_rate,sum)`).

- **Slow Statements** — the top 20 slowest captured statements across the cluster, in ms, worst-first (`top_n(top_n_database_statement, 20, des)`). Each row carries the sampled statement text. Shows `no data` when OAP captured no statements in the window.

## Instance dashboard

For one selected **Node** (a single PostgreSQL server in the cluster). The four top cards are point-in-time configuration readings; the rest are per-node time series.

**Status cards**

- **Shared Buffers** — the node's configured `shared_buffers` size in MB (`latest(meter_pg_instance_shared_buffers)/1024/1024`).

- **Effective Cache** — the node's configured `effective_cache_size` in GB (`latest(meter_pg_instance_effective_cache)/1024/1024/1024`).

- **Work Mem** — the node's configured `work_mem` in MB (`latest(meter_pg_instance_work_mem)/1024/1024`).

- **Max WAL Size** — the node's configured `max_wal_size` in GB (`latest(meter_pg_instance_max_wal_size)/1024/1024/1024`).

**Time series**

- **Fetched Rows / s** — this node's rows fetched per second (`meter_pg_instance_fetched_rows_rate`).

- **Inserted Rows / s** — this node's rows inserted per second (`meter_pg_instance_inserted_rows_rate`).

- **Cache Hit Rate** — this node's buffer-cache hit ratio in percent (`meter_pg_instance_cache_hit_rate`).

- **Sessions** — this node's active vs idle sessions and lock count (`meter_pg_instance_active_sessions`, `meter_pg_instance_idle_sessions`, `meter_pg_instance_locks_count`).

- **Conflicts + Deadlocks / s** — recovery conflicts vs deadlocks per second for this node (`meter_pg_instance_conflicts_rate`, `meter_pg_instance_deadlocks_rate`).

## Requirements

The PostgreSQL dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs PostgreSQL monitoring enabled so it scrapes a postgres-exporter and produces:

- **Cluster (service-scope) meters** — the `meter_pg_*` family: the per-operation row rates (fetched / inserted / updated / deleted / returned), temporary-file rate, cache-hit ratio, committed and rolled-back transaction rates, conflicts and deadlocks, active / idle sessions and locks, and the background-writer buffer and checkpoint counters. These back the Service list and the Service dashboard.

- **Node (instance-scope) meters** — the `meter_pg_instance_*` family: the configured `shared_buffers`, `effective_cache_size`, `work_mem`, and `max_wal_size` readings, plus the per-node fetched / inserted row rates, cache-hit ratio, sessions and locks, and conflict / deadlock series. These back the Instance dashboard.

- **Sampled statements** — `top_n_database_statement` for the Slow Statements list, captured by OAP when slow-statement sampling is configured.

Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so the node-scope `meter_pg_instance_*` series are empty until per-node data is reported. For the upstream setup steps — exporter configuration and which OAP rules to enable — see the [PostgreSQL monitoring documentation](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-postgresql-monitoring/).
