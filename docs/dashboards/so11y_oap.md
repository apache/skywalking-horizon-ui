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

The **SO11Y_OAP** layer is SkyWalking's own self-observability — the OAP backend reporting metrics about itself. It answers "is the backend healthy?": each OAP node's JVM, the analysis pipelines it runs (trace / mesh / OTEL / K8s ALS), the GraphQL query surface the UI itself hits, the storage backend it persists to, and the traffic between the nodes of a cluster. This is the layer you watch to tell whether OAP — not the services it monitors — is the bottleneck.

In Horizon's sidebar this layer is named **OAP**, grouped under **Self-Observability**. Its services are listed as **OAP services** and its instances as **OAP nodes** — one node per running OAP backend in the cluster.

Unlike the application layers, SO11Y_OAP is a node-only layer: it ships a single **instance (OAP node)** dashboard and no service, endpoint, topology, traces, or logs tabs. There is no per-node landing table — pick an OAP node and you land directly on its dashboard.

This page is the **operator reference** for the bundled SO11Y_OAP dashboard: what you see on the OAP-node dashboard and what each widget means.

> The widgets and metrics below are read from the bundled SO11Y_OAP template; if an operator has published a customized SO11Y_OAP template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## OAP node dashboard

For one selected OAP node. Every widget on this dashboard is OAP-node-scoped, fed by the `meter_oap_*` self-observability meter family.

The widgets sit in one box with four tabs: **Receivers & JVM**, **Persistence & Storage**, **Aggregation & Cluster** and **Query & Alarms**. The dashboard opens on **Receivers & JVM**, and only the open tab's widgets are read from OAP, so switching tabs reads that tab's widgets afresh.

### Receivers & JVM

Start here: when the JVM and the receivers look healthy, the OAP node usually is.

- **CPU (%)** — process CPU utilization for the OAP node (`meter_oap_instance_cpu_percentage`).

- **JVM Memory (MB)** — JVM heap memory used (`meter_oap_instance_jvm_memory_bytes_used`, converted to MB).

- **GC Count / min** — garbage-collection count per minute (`meter_oap_instance_jvm_gc_count`).

- **GC Time (ms / min)** — time spent in garbage collection per minute (`meter_oap_instance_jvm_gc_time`).

- **Buffer Pool (MB)** — JVM buffer-pool memory used (`meter_oap_instance_jvm_buffer_pool_bytes_used`, converted to MB).

- **Thread Count** — JVM threads broken out as **live**, **peak**, and **daemon** (`meter_oap_jvm_thread_live_count`, `meter_oap_jvm_thread_peak_count`, `meter_oap_jvm_thread_daemon_count`).

- **Thread States** — threads by state: **runnable**, **timed-waiting**, **blocked**, **waiting** (`meter_oap_jvm_thread_runnable_count`, `meter_oap_jvm_thread_timed_waiting_count`, `meter_oap_jvm_thread_blocked_count`, `meter_oap_jvm_thread_waiting_count`).

- **Class Count** — **loaded**, **unloaded total**, and **loaded total** classes (`meter_oap_jvm_class_loaded_count`, `meter_oap_jvm_class_total_unloaded_count`, `meter_oap_jvm_class_total_loaded_count`).

- **Watermark Circuit Breaker** — cumulative **break** and **recover** counters per listener; when OAP sheds load under memory pressure, breaks climb (`meter_oap_instance_watermark_circuit_breaker_break_count`, `meter_oap_instance_watermark_circuit_breaker_recover_count`).

- **Trace Analysis / min** — traces analyzed per minute, **total** vs **errors** (`meter_oap_instance_trace_count`, `meter_oap_instance_trace_analysis_error_count`).

- **Trace Analysis Latency (ms)** — p50 / p75 / p90 / p95 / p99 latency of trace analysis (`meter_oap_instance_trace_latency_percentile`).

- **Mesh Analysis / min** — service-mesh telemetry analyzed per minute, **total** vs **errors** (`meter_oap_instance_mesh_count`, `meter_oap_instance_mesh_analysis_error_count`).

- **Mesh Analysis Latency (ms)** — p50 / p75 / p90 / p95 / p99 latency of mesh analysis (`meter_oap_instance_mesh_latency_percentile`).

- **OTEL Received / s** — OpenTelemetry records received per second, broken out as **metrics**, **logs**, and **spans** (`meter_oap_otel_metrics_received`, `meter_oap_otel_logs_received`, `meter_oap_otel_spans_received`).

- **K8S ALS** — Kubernetes Access Log Service throughput: **count**, **dropped**, **streams**, and **err streams** (`meter_oap_instance_k8s_als_count`, `meter_oap_instance_k8s_als_drop`, `meter_oap_instance_k8s_als_streams`, `meter_oap_instance_k8s_als_error_streams`).

- **Zipkin Spans Dropped** — Zipkin spans dropped by this node, for deployments running the Zipkin receiver (`meter_oap_instance_spans_dropped_count`).

### Persistence & Storage

How much this node writes, and how fast the storage backend takes it.

- **Persistence Counts / min** — persistence operations per minute, split into **prepare** and **execute** (`meter_oap_instance_persistence_prepare_count`, `meter_oap_instance_persistence_execute_count`).

- **Persistent Cache / min** — persistent-cache activity per minute (`meter_oap_instance_metrics_persistent_cache`).

- **Persistence Prepare Latency (ms)** — p50 / p75 / p90 / p95 / p99 latency of the persistence prepare phase (`meter_oap_instance_persistence_prepare_percentile`).

- **Persistence Execute Latency (ms)** — p50 / p75 / p90 / p95 / p99 latency of the persistence execute phase (`meter_oap_instance_persistence_execute_percentile`).

- **BanyanDB Write Latency (ms)** — write latency by catalog and operation: **measure bulk**, **stream bulk**, **trace bulk**, **stream single**, and **property** (`meter_oap_banyandb_write_latency_percentile`). Shown only when BanyanDB write metrics are present.

- **Elasticsearch Write Latency (ms)** — write latency split into **single** (single write / update / delete) and **bulk** (`meter_oap_elasticsearch_write_latency_percentile`). Shown only when Elasticsearch write metrics are present.

### Aggregation & Cluster

How much this node aggregates, and how the aggregated metrics move between the OAP nodes of a cluster. The cluster widgets need OAP 11.2.0+ and read `no data` against an older OAP. A standalone OAP 11.2.0+ fills **Cluster Size** (1) and the local sends on the traffic widget; its streams and send-queue widgets read `no data`, because a standalone node has no peers.

- **Cluster Size** — the aggregation nodes (role Mixed or Aggregator) this node sees in the cluster: the latest reported count above, and the count over the picked range below (`meter_oap_instance_cluster_size`). It counts this node too, unless it runs with the Receiver role, which only sends to the aggregation nodes. A dip in the line means a node dropped out of the cluster coordinator's list.

- **Aggregation / min** — metrics aggregated per minute (`meter_oap_instance_metrics_aggregation`).

- **Aggregation Queue Usage (%)** — fill level of the L1 and L2 metrics-aggregation queues, top-10 worst series each (`meter_oap_instance_metrics_aggregation_queue_used_per_ten_thousand`, level 1 and level 2). A queue trending toward 100% is back-pressure — OAP is ingesting faster than it can aggregate. Messages received from other nodes go into the L2 queue, so its level also shows how well this node keeps up with its peers.

- **Cluster Remote Traffic / min** — messages per minute. Left axis: **sent to peers** (sends attempted to the other nodes, all peers added together), **sent locally** (this node's own share, handed to its own workers without a network call) and **received** (from the other nodes). Right axis: **send errors**, **receive errors** and **target missing** (`meter_oap_instance_remote_out_count`, `meter_oap_instance_remote_out_error_count`, `meter_oap_instance_remote_in_count`, `meter_oap_instance_remote_in_error_count`, `meter_oap_instance_remote_in_target_not_found_count`). A send error is one failed send or one failed stream, however many messages that stream carried, so it is not a count of lost messages; it counts failures sending to peers and handing a message to this node's own worker alike. Target missing is a received message for a worker this node does not have — most often because the nodes run different OAL / MAL rules, though a message still in flight when a rule is removed lands there too. Sent and received describe the two sides of one node, so they need not match: a local send never shows up as received. On a healthy cluster, the nodes' **sent to peers** add up to roughly their **received**.

- **Cluster Remote Send Latency p99 (ms)** — one line per peer, named by its address, for the five slowest: the p99 time from a batch's gRPC stream opening to the peer confirming it, the peer's handling included, but not the wait for a free stream slot (that is **block wait** below) (`meter_oap_instance_remote_out_latency_percentile`). Values read in the steps of OAP's latency buckets (5, 10, 25, 50, 75, 100 ms and up), each meaning "at most". A peer reads 0 in a minute in which no batch to it completed; a peer that no batch has ever completed to has no line at all.

- **Cluster Remote Streams** — left axis, **in flight**: the gRPC streams open to the other nodes, all peers added together; each peer allows at most 10 at a time. Right axis, **block wait**: milliseconds per minute spent waiting for a free stream slot, which climbs when a peer is slow to accept or cannot be reached (`meter_oap_instance_remote_out_stream_inflight`, `meter_oap_instance_remote_out_stream_block_milliseconds`). In flight is kept per minute, so a short burst can read lower than it peaked.

- **Cluster Remote Send Queue (%)** — how full the send queue to each other node is, one line per peer for the five fullest (`meter_oap_instance_remote_out_queue_used_per_ten_thousand`). A send the queue refuses counts as a **send error** on the traffic widget.

### Query & Alarms

The GraphQL API that Horizon (and any GraphQL client) queries, and the hooks this node's alarms go out through.

- **GraphQL Latency (ms)** — p50 / p75 / p90 / p95 / p99 latency of GraphQL queries served by this node (`meter_oap_graphql_query_latency_percentile`).

- **GraphQL Query Count** — GraphQL queries per minute, split into total **queries** and **errors** (`meter_oap_instance_graphql_query_count`, `meter_oap_instance_graphql_query_error_count`).

The alarm delivery widgets cover HTTP channels (Webhook, Slack, WeCom, DingTalk, Feishu, WeLink, PagerDuty, Discord) and **gRPC**. They read `no data` on an OAP node that has not delivered an alarm, and the Responses widget does until an HTTP hook has answered; each line is one channel, so a deployment with one notification channel reads one line per result.

- **Alarm Delivery / min** — deliveries per minute by channel (HTTP and gRPC) and result: **success**, or why a delivery failed — **auth_failed** (a bad token, key, signature or IP whitelist), **rate_limited**, **rejected** (the channel refused the message, for example a missing keyword), **server_error**, **token_error** (WeLink could not get its access token), **timeout**, **io_error** or **interrupted** (`meter_oap_instance_alarm_http_delivery_count`). DingTalk, WeCom, Feishu and WeLink often refuse a message with HTTP 200 and an error code; those count as failures too.

- **Alarm Delivery Responses / min** — HTTP hook responses per minute by channel and status class: **2xx**, **3xx**, **4xx**, **5xx** or **other** (`meter_oap_instance_alarm_http_delivery_status_count`). HTTP hooks only; gRPC deliveries have no HTTP status series.

- **Alarm Delivery Latency (ms)** — p50 / p75 / p90 / p95 / p99 delivery time per channel, HTTP and gRPC (`meter_oap_instance_alarm_http_delivery_latency_percentile`).

## Requirements

The SO11Y_OAP dashboard is a pure consumer of what OAP reports about itself — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs its **self-observability** telemetry enabled, which produces the `meter_oap_*` meter family:

- **JVM and process metrics** — `meter_oap_instance_cpu_percentage`, `meter_oap_instance_jvm_*`, and the `meter_oap_jvm_thread_*` / `meter_oap_jvm_class_*` families behind the JVM-health widgets.

- **Pipeline and persistence metrics** — `meter_oap_instance_metrics_aggregation`, `meter_oap_instance_persistence_*`, `meter_oap_instance_metrics_persistent_cache`, and `meter_oap_instance_metrics_aggregation_queue_used_per_ten_thousand` for the aggregation / persistence widgets.

- **Query metrics** — `meter_oap_graphql_query_latency_percentile` and `meter_oap_instance_graphql_query_count` / `_error_count` for the GraphQL surface.

- **Ingestion metrics** — the trace, mesh, OTEL, K8s ALS, watermark, and Zipkin families (`meter_oap_instance_trace_*`, `meter_oap_instance_mesh_*`, `meter_oap_otel_*`, `meter_oap_instance_k8s_als_*`, `meter_oap_instance_watermark_circuit_breaker_*`, `meter_oap_instance_spans_dropped_count`). A pipeline that isn't running on a given node simply reports nothing, and its widget reads `no data`.

- **Alarm delivery metrics** — `meter_oap_instance_alarm_http_delivery_count` / `_status_count` / `_latency_percentile` (OAP 11.1.0+ after a hook delivery). With OAP 11.2.0+, gRPC deliveries appear as `hook_type=gRPC` on the delivery and latency meters.

- **Cluster remote metrics** — `meter_oap_instance_cluster_size`, `meter_oap_instance_remote_out_*`, `meter_oap_instance_remote_in_*` (OAP 11.2.0+).

- **Storage metrics** — `meter_oap_banyandb_write_latency_percentile` **or** `meter_oap_elasticsearch_write_latency_percentile`, depending on the configured storage backend; only the matching widget renders.

Each metric is queried at the OAP-node (instance) scope; OAP does not roll a metric up across scopes, so the dashboard is empty until self-observability telemetry is reported by the OAP nodes themselves. See the [OAP backend setup](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-setup/) docs for enabling the self-observability telemetry source.
