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
# ActiveMQ

The **ACTIVEMQ** layer monitors Apache ActiveMQ message brokers. SkyWalking collects ActiveMQ metrics over OpenTelemetry and rolls them up into cluster-, broker-, and destination-scope metrics, so operators can watch queue depth, throughput, connection counts, and broker JVM health alongside the rest of their estate. See the upstream [ActiveMQ monitoring setup](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-activemq-monitoring/) for how to wire the telemetry pipeline.

In Horizon's sidebar this layer is named **ActiveMQ**. Its services are listed as **ActiveMQ clusters**, its instances as **Brokers**, and its endpoints as **Destinations** (the queues and topics a broker serves). The ACTIVEMQ layer enables the Service, Instance, and Endpoint sub-tabs; it has no topology, traces, or logs view.

This page is the **operator reference** for the bundled ACTIVEMQ dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled ACTIVEMQ template; if an operator has published a customized ACTIVEMQ template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

Before opening a cluster, the layer landing page lists every ActiveMQ cluster with four sortable columns, sorted by **Enqueue/s** by default:

- **Enqueue/s** — messages enqueued per second across the cluster (`meter_activemq_cluster_enqueue_rate`).

- **Dequeue/s** — messages dequeued per second across the cluster (`meter_activemq_cluster_dequeue_rate`).

- **System Load** — the cluster's average system load (`meter_activemq_cluster_system_load_average/10000`).

- **Threads** — the cluster's average thread count (`meter_activemq_cluster_thread_count`).

## Service dashboard

The primary drill-down for one selected ActiveMQ cluster, mixing throughput, message timing, and broker JVM health.

- **System Load Average** — the cluster's system load over time (`meter_activemq_cluster_system_load_average/10000`).

- **Thread Count** — live JVM threads across the cluster (`meter_activemq_cluster_thread_count`).

- **Heap Used (MB)** — JVM heap memory in use, in MB (`meter_activemq_cluster_heap_memory_usage_used/1024/1024`).

- **Heap Max (MB)** — the configured maximum heap across the cluster, summed and shown as the latest value in MB (`latest(aggregate_labels(meter_activemq_cluster_heap_memory_usage_max,sum))/1024/1024`).

- **Enqueue / Dequeue / Dispatch /s** — the three core message rates on one chart: messages enqueued, dequeued, and dispatched per second (`meter_activemq_cluster_enqueue_rate`, `meter_activemq_cluster_dequeue_rate`, `meter_activemq_cluster_dispatch_rate`).

- **Expired /s** — messages that expired before delivery, per second (`meter_activemq_cluster_expired_rate`).

- **Enqueue Time** — average and maximum time a message spends being enqueued, in seconds (`meter_activemq_cluster_average_enqueue_time/1000`, `meter_activemq_cluster_max_enqueue_time/1000`).

- **GC Counts (G1+Parallel)** — old- and young-generation garbage-collection counts, each combining the G1 and Parallel collectors so the chart reads correctly regardless of which collector the broker JVM uses (`view_as_seq(meter_activemq_cluster_gc_g1_old_collection_count, meter_activemq_cluster_gc_parallel_old_collection_count)`, and the matching young-collection counters).

- **GC Time (ms)** — old- and young-generation GC time in ms, again combining the G1 and Parallel collectors (`view_as_seq(meter_activemq_cluster_gc_g1_old_collection_time, meter_activemq_cluster_gc_parallel_old_collection_time)`, and the matching young-collection timers).

## Instance dashboard

For one selected broker. A row of single-value cards summarizes the broker's current state, followed by trend charts.

**Summary cards**

- **Connections** — current TCP/JMS connections to this broker (`latest(meter_activemq_broker_current_connections)`).

- **Producer Count** — active producer sessions on this broker, summed across destinations (`latest(aggregate_labels(meter_activemq_broker_current_producer_count,sum))`).

- **Consumer Count** — active consumer sessions on this broker, summed across destinations (`latest(aggregate_labels(meter_activemq_broker_current_consumer_count,sum))`).

- **Uptime** — broker uptime in hours since its last restart (`latest(meter_activemq_broker_uptime)/1000/60/60`).

**Trends**

- **Connections (trend)** — the broker's connection count over time (`meter_activemq_broker_current_connections`).

- **Enqueue / Dequeue Count** — per-minute enqueue and dequeue totals summed across the broker's destinations (`aggregate_labels(meter_activemq_broker_enqueue_count,sum)`, `aggregate_labels(meter_activemq_broker_dequeue_count,sum)`).

- **Producer / Consumer Increase** — new producer and consumer sessions opened per minute (`aggregate_labels(meter_activemq_broker_producer_count,sum)`, `aggregate_labels(meter_activemq_broker_consumer_count,sum)`).

- **Memory Usage** — aggregate memory usage across destinations, in MB (`aggregate_labels(meter_activemq_broker_memory_usage,sum)/1024/1024`).

- **Memory Limit** — the configured memory ceiling across destinations, in GB (`aggregate_labels(meter_activemq_broker_memory_limit,sum)/1024/1024/1024`).

- **Avg Message Size** — average message size across destinations, in bytes (`aggregate_labels(meter_activemq_broker_average_message_size,avg)`).

## Endpoint dashboard

For one selected destination (a queue or topic).

- **Producer Count** — producers attached to this destination (`meter_activemq_destination_producer_count`).

- **Consumer Count** — consumers attached to this destination (`meter_activemq_destination_consumer_count`).

- **Queue Size** — messages currently held in the destination (`meter_activemq_destination_queue_size`).

- **Memory Usage (MB)** — memory the destination is consuming, in MB (`meter_activemq_destination_memory_usage/1024/1024`).

- **Message Counts** — the destination's message lifecycle on one chart: enqueued, dequeued, dispatched, expired, and in-flight counts (`meter_activemq_destination_enqueue_count`, `meter_activemq_destination_dequeue_count`, `meter_activemq_destination_dispatch_count`, `meter_activemq_destination_expired_count`, `meter_activemq_destination_inflight_count`).

- **Enqueue Time (s)** — average and maximum enqueue time for the destination, in seconds (`meter_activemq_destination_average_enqueue_time/1000`, `meter_activemq_destination_max_enqueue_time/1000`).

## Requirements

The ACTIVEMQ dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs the ActiveMQ meter families, produced from broker telemetry collected over OpenTelemetry:

- **Cluster metrics** — the `meter_activemq_cluster_*` family (enqueue / dequeue / dispatch / expired rates, enqueue time, system load, thread count, heap usage, and the G1 / Parallel GC counters) for the service list and the cluster dashboard.

- **Broker metrics** — the `meter_activemq_broker_*` family (current connections, producer / consumer counts, uptime, enqueue / dequeue counts, memory usage and limit, average message size) for the broker dashboard.

- **Destination metrics** — the `meter_activemq_destination_*` family (producer / consumer count, queue size, memory usage, the enqueue / dequeue / dispatch / expired / in-flight counts, and enqueue time) for the destination dashboard.

Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so a broker- or destination-scope metric is empty until that level of data is reported. See the upstream [ActiveMQ monitoring setup](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-activemq-monitoring/) for the collection pipeline that produces these families.
