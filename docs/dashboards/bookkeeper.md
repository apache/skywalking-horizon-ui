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
# BookKeeper

The **BOOKKEEPER** layer monitors Apache BookKeeper, the distributed write-ahead log storage that backs systems such as Apache Pulsar. OAP gathers BookKeeper's metrics through the OpenTelemetry receiver and aggregates them per bookie node and per cluster.

In Horizon's sidebar this layer is named **BookKeeper**. Its services are listed as **BookKeeper clusters** and its instances as **Bookies** — each bookie is one storage node in the cluster. This layer enables the **Service** and **Instance** scopes only: there is no endpoint scope, no topology, and no traces or logs tab, because BookKeeper reports node-level meters rather than request traffic.

This page is the **operator reference** for the bundled BOOKKEEPER dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled BOOKKEEPER template; if an operator has published a customized BOOKKEEPER template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

Before opening a cluster, the layer landing page lists every BookKeeper cluster with four sortable columns, sorted by **Ledgers** by default:

- **Ledgers** — total ledgers held across the cluster's bookies (`meter_bookkeeper_bookie_ledgers_count`, summed).

- **Entries** — total entries stored across the cluster's bookies (`meter_bookkeeper_bookie_entries_count`, summed).

- **Writable Dirs** — number of ledger directories currently accepting writes (`meter_bookkeeper_bookie_ledger_writable_dirs`, summed).

- **Dir Usage** — the ledger data directory's fill level (`meter_bookkeeper_bookie_ledger_dir_data_bookkeeper_ledgers_usage`).

## Service dashboard

The primary drill-down for one selected BookKeeper cluster. Every widget aggregates the cluster's bookies with `aggregate_labels(..., sum)`.

- **Bookie Ledgers** — ledgers held across the cluster over time (`meter_bookkeeper_bookie_ledgers_count`).

- **Bookie Entries** — entries stored across the cluster over time (`meter_bookkeeper_bookie_entries_count`).

- **Writable Ledger Dirs** — ledger directories currently accepting writes (`meter_bookkeeper_bookie_ledger_writable_dirs`).

- **Write Cache** — the bookie write cache on a dual axis: cache size in MB on the left (`meter_bookkeeper_bookie_write_cache_size`, divided to MB) and cached entry count on the right (`meter_bookkeeper_bookie_write_cache_count`).

- **Read Cache** — the bookie read cache on a dual axis: cache size in MB on the left (`meter_bookkeeper_bookie_read_cache_size`, divided to MB) and cached entry count on the right (`meter_bookkeeper_bookie_read_cache_count`).

- **Read / Write Rate (B/s)** — bytes per second served and ingested, plotted together: **read** (`meter_bookkeeper_bookie_read_rate`) and **write** (`meter_bookkeeper_bookie_write_rate`).

- **Ledger Dir Usage** — fill level of the ledger data directory over time (`meter_bookkeeper_bookie_ledger_dir_data_bookkeeper_ledgers_usage`).

## Instance dashboard

For one selected bookie. These widgets cover the bookie's JVM runtime and its internal thread pools.

- **JVM Memory Pool (MB)** — used memory per JVM memory pool in MB (`meter_bookkeeper_node_jvm_memory_pool_used`).

- **JVM Memory (MB)** — JVM memory in MB: **used**, **committed**, and **init** (`meter_bookkeeper_node_jvm_memory_used`, `meter_bookkeeper_node_jvm_memory_committed`, `meter_bookkeeper_node_jvm_memory_init`).

- **JVM Threads** — thread counts: **current**, **daemon**, **peak**, and **deadlocked** (`meter_bookkeeper_node_jvm_threads_current`, `meter_bookkeeper_node_jvm_threads_daemon`, `meter_bookkeeper_node_jvm_threads_peak`, `meter_bookkeeper_node_jvm_threads_deadlocked`).

- **GC** — garbage-collection activity on a dual axis: cumulative GC **seconds** on the left (`meter_bookkeeper_node_jvm_gc_collection_seconds_sum`) and GC **count** on the right (`meter_bookkeeper_node_jvm_gc_collection_seconds_count`).

- **Thread Executor** — the bookie's task executor: **completed**, **tasks completed**, **rejected**, and **failed** (`meter_bookkeeper_node_thread_executor_completed`, `meter_bookkeeper_node_thread_executor_tasks_completed`, `meter_bookkeeper_node_thread_executor_tasks_rejected`, `meter_bookkeeper_node_thread_executor_tasks_failed`).

- **Pooled Threads** — thread counts for the **high-priority** and **read** pools (`meter_bookkeeper_node_high_priority_threads`, `meter_bookkeeper_node_read_thread_pool_threads`).

- **Pool Max Queue Size** — the maximum queue size of the **high-priority** and **read** thread pools (`meter_bookkeeper_node_high_priority_thread_max_queue_size`, `meter_bookkeeper_node_read_thread_pool_max_queue_size`).

## Requirements

The BOOKKEEPER dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs:

- **Bookie metrics** — the `meter_bookkeeper_bookie_*` family (ledgers, entries, writable directories, directory usage, read/write caches, and read/write rates), aggregated at the BookKeeper cluster (Service) scope.

- **Bookie node metrics** — the `meter_bookkeeper_node_*` family (JVM memory, threads, and GC, plus the bookie's thread executor and thread pools), reported at the bookie (ServiceInstance) scope.

These metrics come from BookKeeper's own OpenTelemetry export, gathered by OAP's OpenTelemetry receiver — see the [BookKeeper monitoring](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-bookkeeper-monitoring/) setup. Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so the instance-scope widgets stay empty until per-bookie data is reported.
