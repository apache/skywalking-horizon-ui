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
# RocketMQ

The **ROCKETMQ** layer monitors Apache RocketMQ message-queue clusters. SkyWalking collects RocketMQ metrics over OpenTelemetry and rolls them up into cluster-, broker-, and topic-scope metrics, so operators can watch produce / consume throughput, message size, consumer latency and backlog, and broker disk and thread-pool pressure alongside the rest of their estate. See the upstream [RocketMQ monitoring setup](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-rocketmq-monitoring/) for how to wire the telemetry pipeline.

In Horizon's sidebar this layer is named **RocketMQ**. Its services are listed as **RocketMQ clusters**, its instances as **Brokers**, and its endpoints as **Topics**. The ROCKETMQ layer enables the Service, Instance, and Endpoint sub-tabs; it has no topology, traces, or logs view.

This page is the **operator reference** for the bundled ROCKETMQ dashboard: what you see on each scope and what each widget means.

> The widgets and metrics below are read from the bundled ROCKETMQ template; if an operator has published a customized ROCKETMQ template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

Before opening a cluster, the layer landing page lists every RocketMQ cluster with four sortable columns, sorted by **Produce TPS** by default:

- **Produce TPS** — messages produced per second across the cluster (`meter_rocketmq_cluster_total_producer_tps`).

- **Consume TPS** — messages consumed per second across the cluster (`meter_rocketmq_cluster_total_consumer_tps`).

- **Topics** — the latest topic count in the cluster (`latest(meter_rocketmq_cluster_topic_count)`).

- **Brokers** — the latest broker count in the cluster (`latest(meter_rocketmq_cluster_broker_count)`).

## Service dashboard

The primary drill-down for one selected RocketMQ cluster, mixing daily message volume, live throughput, disk and thread-pool health, and the cluster's topic / broker totals.

- **Produced Today** — messages produced since the start of today (`latest(meter_rocketmq_cluster_messages_produced_today)`).

- **Consumed Today** — messages consumed since the start of today (`latest(meter_rocketmq_cluster_messages_consumed_today)`).

- **Produced Yesterday** — messages produced over the previous full day (`latest(meter_rocketmq_cluster_messages_produced_until_yesterday)`).

- **Consumed Yesterday** — messages consumed over the previous full day (`latest(meter_rocketmq_cluster_messages_consumed_until_yesterday)`).

- **Producer / Consumer TPS** — produce and consume throughput per second on one chart (`meter_rocketmq_cluster_total_producer_tps`, `meter_rocketmq_cluster_total_consumer_tps`).

- **Producer / Consumer Message Size (MB)** — produced and consumed message size, in MB (`meter_rocketmq_cluster_producer_message_size/1024/1024`, `meter_rocketmq_cluster_consumer_message_size/1024/1024`).

- **Max Consumer Latency** — the highest consumer latency seen across the cluster (`latest(meter_rocketmq_cluster_max_consumer_latency)`).

- **CommitLog Disk Ratio (%)** — how full the CommitLog disk is, in percent: the current ratio over time plus the latest maximum across brokers (`meter_rocketmq_cluster_commitLog_disk_ratio`, `latest(meter_rocketmq_cluster_max_commitLog_disk_ratio)`).

- **ThreadPool Queue Head Wait (ms)** — how long the head request has waited in the pull and send broker thread-pool queues, in ms — a rising value signals broker back-pressure (`meter_rocketmq_cluster_pull_threadPool_queue_head_wait_time`, `meter_rocketmq_cluster_send_threadPool_queue_head_wait_time`).

- **Topics** — the latest topic count in the cluster (`latest(meter_rocketmq_cluster_topic_count)`).

- **Brokers** — the latest broker count in the cluster (`latest(meter_rocketmq_cluster_broker_count)`).

## Instance dashboard

For one selected broker, focused on the broker's produce / consume throughput and message size.

- **Produce TPS** — messages produced per second by this broker (`meter_rocketmq_broker_produce_tps`).

- **Consume QPS** — consume requests per second served by this broker (`meter_rocketmq_broker_consume_qps`).

- **Producer Msg Size (MB)** — produced message size on this broker, in MB (`meter_rocketmq_broker_producer_message_size/1024/1024`).

- **Consumer Msg Size (MB)** — consumed message size on this broker, in MB (`meter_rocketmq_broker_consumer_message_size/1024/1024`).

## Endpoint dashboard

For one selected topic, covering producer / consumer-group throughput, message size, consumer latency, offsets, and lag.

- **Producer / Consumer Group TPS** — produce throughput and consumer-group consume throughput per second on one chart (`meter_rocketmq_topic_producer_tps`, `meter_rocketmq_topic_consumer_group_tps`).

- **Message Size (MB)** — produced and consumed message size for the topic, in MB (`meter_rocketmq_topic_producer_message_size/1024/1024`, `meter_rocketmq_topic_consumer_message_size/1024/1024`).

- **Max Message Size (MB)** — the latest maximum produced and consumed message size for the topic, in MB (`latest(meter_rocketmq_topic_max_producer_message_size)/1024/1024`, `latest(meter_rocketmq_topic_max_consumer_message_size)/1024/1024`).

- **Consumer Latency (s)** — consumer latency for the topic, in seconds (`meter_rocketmq_topic_consumer_latency/1000`).

- **Producer / Consumer Offsets** — the topic's producer offset and consumer-group offset over time (`meter_rocketmq_topic_producer_offset`, `meter_rocketmq_topic_consumer_group_offset`).

- **Backlogged Messages** — the topic lag: producer offset minus consumer-group offset, the count of produced messages a consumer group has not yet consumed (`meter_rocketmq_topic_producer_offset-meter_rocketmq_topic_consumer_group_offset`).

- **Consumer Group Count** — the latest number of consumer groups on the topic (`latest(meter_rocketmq_topic_consumer_group_count)`).

- **Broker Count** — the latest number of brokers serving the topic (`latest(meter_rocketmq_topic_broker_count)`).

## Requirements

The ROCKETMQ dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs the RocketMQ meter families, produced from cluster telemetry collected over OpenTelemetry:

- **Cluster metrics** — the `meter_rocketmq_cluster_*` family (total producer / consumer TPS, messages produced / consumed today and yesterday, producer / consumer message size, max consumer latency, CommitLog disk ratio, the pull / send thread-pool queue head-wait timers, and the topic / broker counts) for the service list and the cluster dashboard.

- **Broker metrics** — the `meter_rocketmq_broker_*` family (produce TPS, consume QPS, producer / consumer message size) for the broker dashboard.

- **Topic metrics** — the `meter_rocketmq_topic_*` family (producer TPS and consumer-group TPS, producer / consumer message size and their maxima, consumer latency, producer and consumer-group offsets, and the consumer-group / broker counts) for the topic dashboard.

Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so a broker- or topic-scope metric is empty until that level of data is reported. See the upstream [RocketMQ monitoring setup](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-rocketmq-monitoring/) for the collection pipeline that produces these families.
