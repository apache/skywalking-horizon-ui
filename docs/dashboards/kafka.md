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
# Kafka

The **KAFKA** layer monitors Apache Kafka clusters. SkyWalking reads Kafka's JMX metrics (via OpenTelemetry's Kafka receiver or an equivalent collector) and turns them into per-cluster and per-broker meters, so this dashboard is a JMX-derived view of cluster health, partition / replication state, and broker throughput rather than agent-traced request data.

In Horizon's sidebar this layer is named **Kafka**, grouped under **MQ**. Its services are listed as **Kafka clusters** and its instances as **Brokers**. The KAFKA layer enables only the **Service** (cluster) and **Instance** (broker) sub-tabs — it ships no endpoint scope, no topology, and no traces or logs, because Kafka's JMX feed is metrics-only.

This page is the **operator reference** for the bundled KAFKA dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled KAFKA template; if an operator has published a customized KAFKA template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Cluster list

Before opening a cluster, the layer landing page lists every Kafka cluster with four sortable columns, sorted by **Partitions** by default:

- **Partitions** — average partition count across the cluster (`meter_kafka_partition_count`).

- **Offline Partitions** — total partitions with no active leader, summed across the cluster (`meter_kafka_offline_partitions_count`). A non-zero value means data on those partitions is currently unavailable.

- **Max Lag** — the worst replica lag observed (`meter_kafka_max_lag`), the maximum of how far any follower trails its leader.

- **Leaders** — total partition leaders hosted across the cluster (`meter_kafka_leader_count`).

## Cluster dashboard

The primary drill-down for one selected Kafka cluster — the cluster-wide controller and partition health view.

- **Partition Count** — total partitions in the cluster (`meter_kafka_partition_count`).

- **Leader Count** — partition leaders in the cluster (`meter_kafka_leader_count`).

- **Active Controllers** — the count of active controllers (`meter_kafka_active_controller_count`). A healthy cluster has exactly one; zero or more than one signals a controller problem.

- **Max Lag** — the worst replica lag across the cluster (`meter_kafka_max_lag`).

- **Under-Replicated Partitions** — partitions that have fewer in-sync replicas than configured (`meter_kafka_under_replicated_partitions`). Sustained non-zero values indicate replication is falling behind.

- **Offline Partitions** — partitions with no active leader (`meter_kafka_offline_partitions_count`).

- **Leader Election Rate** — partition-leader elections per second, split into two series: normal **elections** (`meter_kafka_leader_election_rate`) and **unclean** elections (`meter_kafka_unclean_leader_elections_per_second`). Unclean elections promote an out-of-sync replica and can lose data, so they should stay at zero.

## Broker dashboard

For one selected broker. The widgets cover the broker's CPU and memory, message and byte throughput, request handling, queue timings, replication, and partition/ISR state.

- **CPU Usage** — broker CPU percentage (`meter_kafka_broker_cpu_time_total`).

- **Incoming Messages / s** — messages produced into the broker per second (`meter_kafka_broker_messages_per_second`).

- **Bytes In / s** — inbound throughput in bytes per second (`meter_kafka_broker_bytes_in_per_second`).

- **Bytes Out / s** — outbound throughput in bytes per second (`meter_kafka_broker_bytes_out_per_second`).

- **Requests / s** — total requests handled per second (`meter_kafka_broker_requests_per_second`).

- **Purgatory Size** — requests parked in the broker's request purgatory awaiting completion (`meter_kafka_broker_purgatory_size`).

- **ISR Shrinks/s** — the latest rate at which in-sync-replica sets are shrinking (`latest(meter_kafka_broker_isr_shrinks_per_second)`), shown as a single number. Frequent shrinks mean replicas are repeatedly dropping out of sync.

- **ISR Expands/s** — the latest rate at which in-sync-replica sets are re-expanding (`latest(meter_kafka_broker_isr_expands_per_second)`), shown as a single number.

- **Memory Usage (%)** — broker memory utilization (`meter_kafka_broker_memory_usage_percentage`).

- **Under-Replicated Partitions** — the latest count of under-replicated partitions on this broker (`latest(meter_kafka_broker_under_replicated_partitions)`), shown as a single number.

- **Under Min-ISR Partitions** — the latest count of partitions below their minimum in-sync-replica threshold on this broker (`latest(meter_kafka_broker_under_min_isr_partition_count)`), shown as a single number. These partitions reject produces under the default acks setting.

- **Partitions + Leaders** — partitions hosted on the broker (`meter_kafka_broker_partition_count`) overlaid with the partitions it currently leads (`meter_kafka_broker_leader_count`).

- **Queue / Send Times** — broker request latency breakdown in ms across four stages: **request q** (`meter_kafka_broker_request_queue_time_ms`), **response q** (`meter_kafka_broker_response_queue_time_ms`), **response send** (`meter_kafka_broker_response_send_time_ms`), and **remote** (`meter_kafka_broker_remote_time_ms`).

- **Topic Rates** — per-broker topic activity: **produce req/s** (`meter_kafka_broker_topic_produce_requests_per_second`), **fetch req/s** (`meter_kafka_broker_topic_fetch_requests_per_second`), and **bytes-in/s** (`meter_kafka_broker_topic_bytesin_per_second`).

- **Replication** — replication traffic in bytes per second between brokers, **bytes in** (`meter_kafka_broker_replication_bytes_in_per_second`) and **bytes out** (`meter_kafka_broker_replication_bytes_out_per_second`).

- **GC Count** — garbage-collection count for the broker JVM (`meter_kafka_broker_garbage_collector_count`).

- **Max Lag (broker)** — the broker's total replica lag (`sum(meter_kafka_broker_max_lag)`), shown as a single number — the sum of how far this broker's followers trail their leaders.

## Requirements

The KAFKA dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs Kafka's JMX metrics ingested and aggregated into the two meter families this layer renders:

- **Cluster meters** — the `meter_kafka_*` family at Service scope (partition, leader, controller, lag, under-replicated / offline partition, and leader-election metrics) for the cluster list and cluster dashboard.

- **Broker meters** — the `meter_kafka_broker_*` family at ServiceInstance scope (CPU, memory, message / byte / request throughput, purgatory, ISR, queue and send times, topic rates, replication, GC, and per-broker partition / leader / lag metrics) for the broker dashboard.

These meters are produced by SkyWalking's Kafka monitoring, which reads Kafka's JMX through OpenTelemetry's Kafka receiver. See the [Kafka monitoring setup](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-kafka-monitoring/) for how to wire the collector to OAP. Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so a broker-scope meter is empty until per-broker data is reported.
