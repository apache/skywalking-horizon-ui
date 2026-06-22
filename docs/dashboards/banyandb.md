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
# BanyanDB

The **BANYANDB** layer is the self-observability dashboard for [Apache SkyWalking BanyanDB](https://skywalking.apache.org/docs/skywalking-banyandb/next/readme/), the native storage that backs an OAP cluster. It surfaces the health of the storage tier itself — write and query throughput, the liaison front door, the data nodes that hold the shards, the lifecycle sidecar that migrates data between tiers, and the per-group load across the measure / stream / trace / property data models.

In Horizon's sidebar this layer sits under the **Self-Observability** group and is named **BanyanDB**. It maps BanyanDB's own topology onto the standard entity slots: a BanyanDB cluster is a **Cluster** (the service slot), each running container — a `liaison`, `data`, or `lifecycle` process — is a **Container** (the instance slot, badged with its `container_name`), and each storage group is a **Group** (the endpoint slot). The layer enables the Cluster, Container, and Group dashboards plus a layer-specific **Deployment** tab; it ships no service topology, no API-dependency view, and no traces or logs tabs.

This page is the **operator reference** for the bundled BANYANDB dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled BANYANDB template; if an operator has published a customized BANYANDB template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Cluster list

Before opening a cluster, the layer landing page lists every BanyanDB cluster with three sortable columns, sorted by write rate by default:

- **Write/s** — cluster-wide writes per second (`meter_banyandb_cluster_write_rate`).

- **Query/s** — cluster-wide query calls per second (`meter_banyandb_cluster_query_rate`).

- **Errors** — cluster-wide errors per minute (`meter_banyandb_cluster_error_rate`).

## Cluster dashboard

The primary drill-down for one selected cluster, summarizing the whole storage tier.

- **Write Rate** / **Query Rate** / **Error Rate** — three headline cards: cluster-wide writes per second across the measure + stream + trace data models (`meter_banyandb_cluster_write_rate`), gRPC query calls per second seen at the liaison front door (`meter_banyandb_cluster_query_rate`), and errors per minute summed across the cluster (`meter_banyandb_cluster_error_rate`). On a healthy cluster the error card reads 0.

- **CPU Cores** / **Memory Used** / **Disk Used** — capacity cards rolled up across the cluster's containers: total CPU cores visible (`meter_banyandb_total_cpu_cores`), total memory used in GB (`meter_banyandb_total_memory_used`), and total on-disk bytes used across the data paths in GB (`meter_banyandb_total_disk_used`).

- **Cluster Throughput** — write rate versus query rate over time on one chart (`meter_banyandb_cluster_write_rate`, `meter_banyandb_cluster_query_rate`).

- **Cluster Errors / min** — cluster-wide errors per minute over time (`meter_banyandb_cluster_error_rate`).

- **Containers by Role** — a table of the live container count per role (data / liaison), derived from the system uptime gauge (`meter_banyandb_reporting_instances`). The lifecycle sidecar runs no system collector, so it does not appear here.

## Container dashboard

For one selected container. Because the three BanyanDB roles report different metrics, most widgets are **role-specific** and appear only on the container they apply to — a `liaison` container shows the front-door widgets, a `data` container the storage-engine widgets, and the `lifecycle` sidecar its migration widgets. A handful of common runtime widgets render on every container, and a few host widgets appear only when that container's system collector reports them.

**Common runtime (every container)**

- **CPU Usage** — process CPU consumption in cores (`meter_banyandb_instance_cpu_usage`).

- **Resident Memory** — process resident memory in MB (`meter_banyandb_instance_rss_memory`).

- **Goroutines** — live goroutine count (`meter_banyandb_instance_goroutines`).

- **GC Pause (avg)** — average Go GC pause per cycle in ms (`meter_banyandb_instance_gc_pause_avg`).

- **Go Heap** — Go heap in-use versus next-GC threshold in MB (`meter_banyandb_instance_heap_inuse`, `meter_banyandb_instance_heap_next_gc`).

- **Go Alloc Rate** — Go allocation rate in MB/s (`meter_banyandb_instance_alloc_rate`).

**Host (when the system collector reports it)**

- **Uptime** — days since the node started (`meter_banyandb_instance_node_uptime`). Absent on the lifecycle sidecar, which runs no system collector.

- **System Memory Used** — host memory used as a percentage (`meter_banyandb_instance_system_memory_percent`).

- **Disk Usage** — used / total across the node's data paths as a percentage (`meter_banyandb_instance_disk_usage_percent`).

- **Disk Used / Total** — used per data path against total filesystem capacity in GB (`meter_banyandb_instance_disk_used_by_path`, `meter_banyandb_instance_disk_total_by_path`). Paths that share one filesystem report identical figures.

- **Network I/O** — per-interface receive / send throughput in KB/s (`meter_banyandb_instance_network_recv`, `meter_banyandb_instance_network_sent`).

**Lifecycle sidecar (`container_name` = lifecycle)**

- **Time Since Last Sync** — how long ago the last migration cycle started, shown as a duration (`meter_banyandb_instance_lifecycle_last_run`). Appears once the first migration cycle has run.

- **Last Sync** — whether the last migration cycle succeeded (OK) or failed (`meter_banyandb_instance_lifecycle_last_run_success`).

- **Migration Cycles** — cumulative tier-migration cycles run by the sidecar (`meter_banyandb_instance_lifecycle_migration_cycles`).

**Liaison front door (`container_name` = liaison)**

- **Query Rate by Service** — gRPC query calls per second, split by data-model service (measure / stream / trace / property) (`meter_banyandb_instance_liaison_query_rate`).

- **gRPC Errors / min** — gRPC errors per minute, summed across total + registry + stream-msg (`meter_banyandb_instance_liaison_grpc_error_rate`). Lazily registered, so it reads 0 on a healthy liaison.

- **Registry Ops / s** — schema-registry operations per second at the front door (`meter_banyandb_instance_liaison_registry_op_rate`).

- **Write Rate** — writes per second at the front door across the three data models (`meter_banyandb_instance_liaison_write_rate`).

- **Publish Throughput** — the tier-2 publish pipeline (liaison → data) broken out by operation (`meter_banyandb_instance_liaison_publish_throughput`).

- **Publish p99 Latency** — p99 send latency of the publish pipeline, per operation (`meter_banyandb_instance_liaison_publish_latency_p99`).

- **Part-sync Bytes** — bytes per second streamed to data nodes on the part-sync (file-sync) path in KB/s (`meter_banyandb_instance_liaison_publish_bytes`). Only chunked file-sync increments this counter; regular write / query publishes are not counted.

- **Write Queue Pending** — liaison write-buffer depth: records buffered at the front door before publish (`meter_banyandb_instance_liaison_wqueue_pending`).

- **Publish Batch Throughput** — batches published per second by operation (`meter_banyandb_instance_liaison_publish_batch_throughput`). Hidden until the cluster emits batch metrics.

- **Publish Batch p99** — p99 latency of batch publishes in ms (`meter_banyandb_instance_liaison_publish_batch_latency_p99`).

**Data node (`container_name` = data)**

- **Stored Data Elements** — total file elements stored across measure + stream + trace (`meter_banyandb_instance_data_total_data`).

- **Write Queue (wqueue)** — the data-node write queue: pending records, on-disk file parts, and in-memory parts (`meter_banyandb_instance_data_wqueue_pending`, `meter_banyandb_instance_data_wqueue_file_parts`, `meter_banyandb_instance_data_wqueue_mem_part`).

- **Merge Loop Rate** — file merge-loop iterations per second (`meter_banyandb_instance_data_merge_file_rate`).

- **Merge File Latency** — average on-disk file-merge latency per merge loop in ms (`meter_banyandb_instance_data_merge_file_latency`).

- **Merge Parts / Loop** — average parts merged per on-disk merge loop (`meter_banyandb_instance_data_merge_file_partitions`).

- **Inverted Index Rate** — series-index updates and term searches per second across measure + stream storage + stream tst (`meter_banyandb_instance_data_series_write_rate`, `meter_banyandb_instance_data_series_term_search_rate`, `meter_banyandb_instance_data_stream_tst_write_rate`, `meter_banyandb_instance_data_stream_tst_term_search_rate`).

- **Index Documents** — total inverted-index documents, used as a series proxy (`meter_banyandb_instance_data_total_series`, `meter_banyandb_instance_data_stream_tst_total_docs`).

- **Subscribe Throughput** — subscribe-side queue throughput by operation (query / file-sync / batch-write / control) (`meter_banyandb_instance_data_queue_sub_throughput`).

- **Subscribe p99 Latency** — p99 latency of subscribe-side queue processing in ms (`meter_banyandb_instance_data_queue_sub_latency_p99`).

- **Retention Disk Usage** — per data-model retention disk-usage percentage (`meter_banyandb_instance_data_retention_measure_disk_usage_percent`, `meter_banyandb_instance_data_retention_stream_disk_usage_percent`, `meter_banyandb_instance_data_retention_trace_disk_usage_percent`).

- **Subscribe Message Throughput** — per-record processing rate the subscriber unpacks from batches in msgs/s (`meter_banyandb_instance_data_queue_sub_message_throughput`).

## Group dashboard

For one selected group — a BanyanDB storage group, mapped to the endpoint slot. The widgets are organized by data model (measure, stream, trace, property); each model's widgets render only when that model's group reports data, and a final set of queue widgets is common to every group.

**Measure**

- **Measure Write / s** — writes per second for this group (`meter_banyandb_endpoint_measure_write_rate`).

- **Measure Query Latency** — mean liaison query latency for this group in ms (`meter_banyandb_endpoint_measure_query_latency`).

- **Measure Total Data** — current stored data elements for this group (`meter_banyandb_endpoint_measure_total_data`).

- **Measure Merge Rate** — file merge-loop iterations per minute (`meter_banyandb_endpoint_measure_merge_file_rate`).

- **Measure Merge Latency** — mean file-merge latency per merge loop in ms (`meter_banyandb_endpoint_measure_merge_file_latency`).

- **Measure Merge Partitions** — average parts merged per file merge loop (`meter_banyandb_endpoint_measure_merge_file_partitions`).

- **Measure Series Write / s** — inverted-index updates per second, used as a series-write proxy (`meter_banyandb_endpoint_measure_series_write_rate`).

- **Measure Term Search / s** — inverted-index term-search invocations per second, the index read-pressure signal (`meter_banyandb_endpoint_measure_series_term_search_rate`).

- **Measure Total Series** — total inverted-index documents for this group, used as a series proxy (`meter_banyandb_endpoint_measure_total_series`).

**Stream**

- **Stream Write / s** — writes per second for this group (`meter_banyandb_endpoint_stream_write_rate`).

- **Stream Query Latency** — mean liaison query latency for this group in ms (`meter_banyandb_endpoint_stream_query_latency`).

- **Stream Total Data** — current stored data elements for this group (`meter_banyandb_endpoint_stream_total_data`).

- **Stream Merge Rate** — file merge-loop iterations per minute (`meter_banyandb_endpoint_stream_merge_file_rate`).

- **Stream Merge Latency** — mean file-merge latency per merge loop in ms (`meter_banyandb_endpoint_stream_merge_file_latency`).

- **Stream Merge Partitions** — average parts merged per file merge loop (`meter_banyandb_endpoint_stream_merge_file_partitions`).

- **Stream Series Write / s** — inverted-index updates per second, used as a series-write proxy (`meter_banyandb_endpoint_stream_series_write_rate`).

- **Stream TST Index Write / s** — stream tst-scope inverted-index updates per second, distinct from the storage-scope series index (`meter_banyandb_endpoint_stream_tst_index_write_rate`).

- **Stream Term Search / s** — inverted-index term-search invocations per second (`meter_banyandb_endpoint_stream_series_term_search_rate`).

- **Stream Total Series** — total inverted-index documents for this group (`meter_banyandb_endpoint_stream_total_series`).

- **Stream TST Total Series** — the stream tst-scope index document total, distinct from the storage-scope series index (`meter_banyandb_endpoint_stream_tst_total_series`).

**Trace**

- **Trace Write / s** — writes per second for this group (`meter_banyandb_endpoint_trace_write_rate`).

- **Trace Query Latency** — mean liaison query latency for this group in ms (`meter_banyandb_endpoint_trace_query_latency`).

- **Trace Total Data** — current stored data elements for this group (`meter_banyandb_endpoint_trace_total_data`).

- **Trace Merge Rate** — file merge-loop iterations per minute (`meter_banyandb_endpoint_trace_merge_file_rate`).

- **Trace Merge Latency** — mean file-merge latency per merge loop in ms (`meter_banyandb_endpoint_trace_merge_file_latency`).

- **Trace Merge Partitions** — average parts merged per file merge loop (`meter_banyandb_endpoint_trace_merge_file_partitions`).

- **Trace Series Write / s** — inverted-index updates per second, used as a series-write proxy (`meter_banyandb_endpoint_trace_series_write_rate`).

- **Trace Term Search / s** — inverted-index term-search invocations per second (`meter_banyandb_endpoint_trace_series_term_search_rate`).

- **Trace Total Series** — total inverted-index documents for this group (`meter_banyandb_endpoint_trace_total_series`).

**Property**

- **Property Index Write / s** — property-registry inverted-index updates per second, the property model's write signal (`meter_banyandb_endpoint_property_index_write_rate`).

- **Property Index Merge Rate** — property inverted-index segment merges per minute; property has no tst merge loop (`meter_banyandb_endpoint_property_index_merge_rate`).

- **Property Index Merge Latency** — mean property inverted-index merge latency in ms (`meter_banyandb_endpoint_property_index_merge_latency`).

- **Property Term Search / s** — property term-search invocations per second; property is read via the registry / term-search path rather than the liaison query method, so this is its read-load signal (`meter_banyandb_endpoint_property_series_term_search_rate`).

- **Property Total Series** — total property inverted-index documents for this group (`meter_banyandb_endpoint_property_total_series`).

**Queue (every group)**

- **Subscribe Throughput** — subscribe-side queue messages per second for this group, by operation (`meter_banyandb_endpoint_queue_throughput`).

- **Publish p99** — publish-side queue p99 latency for this group in ms (`meter_banyandb_endpoint_queue_latency_p99`).

- **Batch Throughput** — per-group write-batch rate, by operation (`meter_banyandb_endpoint_queue_batch_throughput`).

- **Message Throughput** — per-group per-record rate, by operation (`meter_banyandb_endpoint_queue_message_throughput`).

- **Part-sync Bytes / s** — part-sync (file-sync) bytes per second for this group in KB/s (`meter_banyandb_endpoint_publish_bytes`). Only the chunked part-streaming path increments this; regular write / query publishes are not counted.

## Deployment

The BANYANDB layer enables the layer-specific **Deployment** tab — the deployment topology of one cluster's own containers and the intra-cluster calls between them. Pick a cluster from the header and the tab draws its containers as health-ring nodes laid out left → right along the calls between them, with animated edge flow, a per-edge metric panel, and a node popover that opens the container dashboard. For how the Deployment tab is read and navigated in general, see the [Deployment](../customization/layer-templates.md#deployment) section of Layer Dashboard Templates.

Containers are grouped into three roles by their `node_role` / `node_type` attributes:

- **Liaison** — the front door. Its node center shows **Query/s** (`meter_banyandb_instance_liaison_query_rate`) and its health ring tracks **gRPC err/min** (`meter_banyandb_instance_liaison_grpc_error_rate`).

- **Data** — the storage nodes. Center shows **Ingest/s** (`meter_banyandb_instance_data_queue_sub_throughput`) and the ring tracks **Disk %** (`meter_banyandb_instance_disk_usage_percent`).

- **Lifecycle** — the tier-migration sidecar. Center shows cumulative **Cycles** (`meter_banyandb_instance_lifecycle_migration_cycles`) and the ring tracks **Last OK** (`meter_banyandb_instance_lifecycle_last_run_success`).

Because role-pair edges are configured, the Deployment map gains a **Flows** sub-tab listing every edge grouped by role-pair. Each edge type carries its own client-side (publish) and server-side (subscribe) metrics, so a `liaison → data` call surfaces a different metric set than a `liaison → liaison` forward or a `lifecycle → data` migration:

- **liaison → data** — the main write / query path. Per-operation **Write/s**, **Query/s**, and **Part-sync/s** throughput; **Write p99** and **Query p99** latency; **Part-sync B/s** bytes; and **Errors/s**. Each is paired across the publish side (`meter_banyandb_instance_relation_publish_*`, filtered by `operation`) and the subscribe side (`meter_banyandb_instance_relation_queue_sub_*`).

- **liaison → liaison** — node-to-node forwarding. **Forward/s** and **Forward p99** for the batch-write forward, **Control/s** for the control channel, and **Errors/s** (`meter_banyandb_instance_relation_publish_throughput{operation='batch-write'}` and the matching subscribe / control / error counters).

- **lifecycle → data** — the tier-migration path. **Migrate/s** throughput, **Migrate p99** latency, **Migrate B/s** bytes, and **Errors/s** (`meter_banyandb_instance_relation_migration_*` on the publish side, `meter_banyandb_instance_relation_queue_sub_*` on the subscribe side).

- **any other pair** — a generic fallback showing aggregated **Msg/s** and **p99** (`aggregate_labels(meter_banyandb_instance_relation_publish_throughput,sum)` and the matching latency / subscribe counters), so an edge that matches no specific role-pair still reports something.

## Requirements

The BANYANDB dashboard is a pure consumer of what OAP reports about its BanyanDB storage tier — it invents no data, and a widget with no backing data simply reads `no data` (or 0 for the lazily-registered error counters). To populate it, OAP needs BanyanDB self-observability enabled so that BanyanDB exposes its metrics and OAP ingests them into the `meter_banyandb_*` families:

- **Cluster metrics** — `meter_banyandb_cluster_*` and the `meter_banyandb_total_*` capacity rollups for the Cluster list and Cluster dashboard.

- **Container metrics** — `meter_banyandb_instance_*` for the per-container runtime, host, liaison, data, and lifecycle widgets. A container only shows the families its role emits, and the host widgets need a running system collector (absent on the lifecycle sidecar).

- **Group metrics** — the per-data-model `meter_banyandb_endpoint_*` families (measure / stream / trace / property, plus the shared queue counters) for the Group dashboard.

- **Relation metrics** — `meter_banyandb_instance_relation_*` (publish / subscribe / migration throughput, latency, bytes, and error counters) for the Deployment tab's edges.

Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so a container- or group-scope metric is empty until that level of data is reported, and an entire data model's group widgets stay hidden until that model's group reports.
