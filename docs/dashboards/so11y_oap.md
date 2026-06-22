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
# OAP (Self-Observability)

The **SO11Y_OAP** layer is SkyWalking's own self-observability — the OAP backend reporting metrics about itself. It answers "is the backend healthy?": each OAP node's JVM, the analysis pipelines it runs (trace / mesh / OTEL / K8s ALS), the GraphQL query surface the UI itself hits, and the storage backend it persists to. This is the layer you watch to tell whether OAP — not the services it monitors — is the bottleneck.

In Horizon's sidebar this layer is named **OAP**, grouped under **Self-Observability**. Its services are listed as **OAP services** and its instances as **OAP nodes** — one node per running OAP backend in the cluster.

Unlike the application layers, SO11Y_OAP is a node-only layer: it ships a single **instance (OAP node)** dashboard and no service, endpoint, topology, traces, or logs tabs. There is no per-node landing table — pick an OAP node and you land directly on its dashboard.

This page is the **operator reference** for the bundled SO11Y_OAP dashboard: what you see on the OAP-node dashboard and what each widget means.

> The widgets and metrics below are read from the bundled SO11Y_OAP template; if an operator has published a customized SO11Y_OAP template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## OAP node dashboard

For one selected OAP node. Every widget on this dashboard is OAP-node-scoped, fed by the `meter_oap_*` self-observability meter family.

### JVM health

The runtime the OAP node runs on.

- **CPU (%)** — process CPU utilization for the OAP node (`meter_oap_instance_cpu_percentage`).

- **JVM Memory (MB)** — JVM heap memory used (`meter_oap_instance_jvm_memory_bytes_used`, converted to MB).

- **GC Count / min** — garbage-collection count per minute (`meter_oap_instance_jvm_gc_count`).

- **GC Time (ms / min)** — time spent in garbage collection per minute (`meter_oap_instance_jvm_gc_time`).

- **Buffer Pool (MB)** — JVM buffer-pool memory used (`meter_oap_instance_jvm_buffer_pool_bytes_used`, converted to MB).

- **Thread Count** — JVM threads broken out as **live**, **peak**, and **daemon** (`meter_oap_jvm_thread_live_count`, `meter_oap_jvm_thread_peak_count`, `meter_oap_jvm_thread_daemon_count`).

- **Thread States** — threads by state: **runnable**, **timed-waiting**, **blocked**, **waiting** (`meter_oap_jvm_thread_runnable_count`, `meter_oap_jvm_thread_timed_waiting_count`, `meter_oap_jvm_thread_blocked_count`, `meter_oap_jvm_thread_waiting_count`).

- **Class Count** — **loaded**, **unloaded total**, and **loaded total** classes (`meter_oap_jvm_class_loaded_count`, `meter_oap_jvm_class_total_unloaded_count`, `meter_oap_jvm_class_total_loaded_count`).

### Metrics aggregation and persistence

How much work the analysis-and-write pipeline is doing on this node.

- **Aggregation / min** — metrics aggregated per minute (`meter_oap_instance_metrics_aggregation`).

- **Persistence Counts / min** — persistence operations per minute, split into **prepare** and **execute** (`meter_oap_instance_persistence_prepare_count`, `meter_oap_instance_persistence_execute_count`).

- **Persistent Cache / min** — persistent-cache activity per minute (`meter_oap_instance_metrics_persistent_cache`).

- **Persistence Prepare Latency (ms)** — p50 / p75 / p90 / p95 / p99 latency of the persistence prepare phase (`meter_oap_instance_persistence_prepare_percentile`).

- **Persistence Execute Latency (ms)** — p50 / p75 / p90 / p95 / p99 latency of the persistence execute phase (`meter_oap_instance_persistence_execute_percentile`).

- **Aggregation Queue Usage (%)** — fill level of the L1 and L2 metrics-aggregation queues, top-10 worst series each (`meter_oap_instance_metrics_aggregation_queue_used_per_ten_thousand`, level 1 and level 2). A queue trending toward 100% is back-pressure — OAP is ingesting faster than it can aggregate.

### Query surface (GraphQL)

The query API that Horizon (and any GraphQL client) hits.

- **GraphQL Latency (ms)** — p50 / p75 / p90 / p95 / p99 latency of GraphQL queries served by this node (`meter_oap_graphql_query_latency_percentile`).

- **GraphQL Query Count** — GraphQL queries per minute, split into total **queries** and **errors** (`meter_oap_instance_graphql_query_count`, `meter_oap_instance_graphql_query_error_count`).

### Ingestion and analysis pipelines

The receivers and analyzers turning raw telemetry into metrics.

- **Trace Analysis / min** — traces analyzed per minute, **total** vs **errors** (`meter_oap_instance_trace_count`, `meter_oap_instance_trace_analysis_error_count`).

- **Trace Analysis Latency (ms)** — p50 / p75 / p90 / p95 / p99 latency of trace analysis (`meter_oap_instance_trace_latency_percentile`).

- **Mesh Analysis / min** — service-mesh telemetry analyzed per minute, **total** vs **errors** (`meter_oap_instance_mesh_count`, `meter_oap_instance_mesh_analysis_error_count`).

- **Mesh Analysis Latency (ms)** — p50 / p75 / p90 / p95 / p99 latency of mesh analysis (`meter_oap_instance_mesh_latency_percentile`).

- **OTEL Received / s** — OpenTelemetry records received per second, broken out as **metrics**, **logs**, and **spans** (`meter_oap_otel_metrics_received`, `meter_oap_otel_logs_received`, `meter_oap_otel_spans_received`).

- **K8S ALS** — Kubernetes Access Log Service throughput: **count**, **dropped**, **streams**, and **err streams** (`meter_oap_instance_k8s_als_count`, `meter_oap_instance_k8s_als_drop`, `meter_oap_instance_k8s_als_streams`, `meter_oap_instance_k8s_als_error_streams`).

- **Watermark Circuit Breaker** — cumulative **break** and **recover** counters per listener; when OAP sheds load under memory pressure, breaks climb (`meter_oap_instance_watermark_circuit_breaker_break_count`, `meter_oap_instance_watermark_circuit_breaker_recover_count`).

- **Zipkin Spans Dropped** — Zipkin spans dropped by this node, for deployments running the Zipkin receiver (`meter_oap_instance_spans_dropped_count`).

### Storage backend

Write latency against whichever storage backend this OAP is configured with. These two widgets are storage-specific and only render when the matching backend is in use — a BanyanDB deployment shows the BanyanDB widget, an Elasticsearch deployment shows the Elasticsearch widget.

- **BanyanDB Write Latency (ms)** — write latency by catalog and operation: **measure bulk**, **stream bulk**, **trace bulk**, **stream single**, and **property** (`meter_oap_banyandb_write_latency_percentile`). Shown only when BanyanDB write metrics are present.

- **Elasticsearch Write Latency (ms)** — write latency split into **single** (single write / update / delete) and **bulk** (`meter_oap_elasticsearch_write_latency_percentile`). Shown only when Elasticsearch write metrics are present.

## Requirements

The SO11Y_OAP dashboard is a pure consumer of what OAP reports about itself — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs its **self-observability** telemetry enabled, which produces the `meter_oap_*` meter family:

- **JVM and process metrics** — `meter_oap_instance_cpu_percentage`, `meter_oap_instance_jvm_*`, and the `meter_oap_jvm_thread_*` / `meter_oap_jvm_class_*` families behind the JVM-health widgets.

- **Pipeline and persistence metrics** — `meter_oap_instance_metrics_aggregation`, `meter_oap_instance_persistence_*`, `meter_oap_instance_metrics_persistent_cache`, and `meter_oap_instance_metrics_aggregation_queue_used_per_ten_thousand` for the aggregation / persistence widgets.

- **Query metrics** — `meter_oap_graphql_query_latency_percentile` and `meter_oap_instance_graphql_query_count` / `_error_count` for the GraphQL surface.

- **Ingestion metrics** — the trace, mesh, OTEL, K8s ALS, watermark, and Zipkin families (`meter_oap_instance_trace_*`, `meter_oap_instance_mesh_*`, `meter_oap_otel_*`, `meter_oap_instance_k8s_als_*`, `meter_oap_instance_watermark_circuit_breaker_*`, `meter_oap_instance_spans_dropped_count`). A pipeline that isn't running on a given node simply reports nothing, and its widget reads `no data`.

- **Storage metrics** — `meter_oap_banyandb_write_latency_percentile` **or** `meter_oap_elasticsearch_write_latency_percentile`, depending on the configured storage backend; only the matching widget renders.

Each metric is queried at the OAP-node (instance) scope; OAP does not roll a metric up across scopes, so the dashboard is empty until self-observability telemetry is reported by the OAP nodes themselves. See the [OAP backend setup](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-setup/) docs for enabling the self-observability telemetry source.
